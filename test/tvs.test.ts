// Registry tests: TV list/merge, discovery folding, sessions, actions and their validation.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tv, TV1, TV2, makeRegistry } from "./fake.ts";
const { absorbFound, parseYouTube, loadConfig } = await import("../tvs.ts");
const { loadState } = await import("../lgtv.ts");

beforeEach(() => tv.reset());
const seed = (tvs: object, extra: object = {}) => writeFileSync(process.env.LGTV_STATE!, JSON.stringify({ version: 2, tvs, ...extra }));

// --- discovery folding (the identity rules) ---

test("absorbFound: new TV is stored under its uuid", () => {
  const s: any = { version: 2, tvs: {} };
  absorbFound(s, TV1, "T");
  assert.deepEqual(s.tvs["uuid-1"], { ...TV1, seenAt: "T" });
});

test("absorbFound: a TV paired by address is folded into its uuid entry (key kept)", () => {
  const s: any = { version: 2, tvs: { "host:10.0.0.5": { host: "10.0.0.5", key: "k1", cert: "AA" } } };
  absorbFound(s, TV1, "T");
  assert.deepEqual(Object.keys(s.tvs), ["uuid-1"]);
  assert.equal(s.tvs["uuid-1"].key, "k1");
});

test("absorbFound: uuid at a new IP keeps its key only when the certificate is pinned", () => {
  const pinned: any = { version: 2, tvs: { "uuid-1": { host: "10.0.0.5", key: "k1", cert: "AA" } } };
  absorbFound(pinned, { ...TV1, host: "10.0.0.99" });
  assert.deepEqual([pinned.tvs["uuid-1"].host, pinned.tvs["uuid-1"].key], ["10.0.0.99", "k1"]); // connect() checks the cert

  const unpinned: any = { version: 2, tvs: { "uuid-1": { host: "10.0.0.5", key: "k1" } } };
  absorbFound(unpinned, { ...TV1, host: "10.0.0.99" });
  assert.equal(unpinned.tvs["uuid-1"].key, undefined); // can't verify the new IP: re-pair
});

// --- list / merge ---

test("config TVs are listed before any scan, by address", () => {
  const r = makeRegistry([{ host: "10.0.0.5", name: "Living room" }]);
  assert.deepEqual(r.list(), [{ name: "Living room", host: "10.0.0.5", id: "host:10.0.0.5", sources: ["config"], online: false, paired: false, certPinned: false, certChanged: false }]);
});

test("scan merges: config wins, discovery fills gaps, new TVs added, online flags set", async () => {
  const r = makeRegistry([{ host: "10.0.0.5", name: "Living room", mac: "cc:cc:cc:cc:cc:cc" }]);
  tv.found = [TV1, TV2];
  await r.scan();
  assert.deepEqual(r.list().map((t) => [t.id, t.host, t.name, t.model, t.mac, t.sources.join("+"), t.online]), [
    ["uuid-1", "10.0.0.5", "Living room", "M1", "cc:cc:cc:cc:cc:cc", "config+discovered", true],
    ["uuid-2", "10.0.0.6", "Bedroom TV", "M2", "bb:bb:bb:bb:bb:bb", "discovered", true],
  ]);
});

test("a TV that moved IP keeps its id and key; a config entry with its uuid follows it", async () => {
  seed({ "uuid-1": { ...TV1, seenAt: "T", cert: "AA", key: "k1" } });
  tv.found = [{ ...TV1, host: "10.0.0.99" }];
  const byUuid = makeRegistry([{ host: "10.0.0.5", uuid: "uuid-1", name: "Living room" }]);
  await byUuid.scan();
  assert.deepEqual(byUuid.list().map((t) => [t.id, t.host, t.paired]), [["uuid-1", "10.0.0.99", true]]);
});

test("a discovered TV is remembered (offline) when a later scan misses it", async () => {
  const r = makeRegistry();
  tv.found = [TV2];
  await r.scan();
  tv.found = [];
  await r.scan();
  assert.deepEqual(r.list().map((t) => [t.id, t.online, t.mac]), [["uuid-2", false, TV2.mac]]);
});

test("concurrent scans share one discovery run", async () => {
  let runs = 0;
  const r = makeRegistry();
  tv.deps.discover = async () => (runs++, await new Promise((res) => setTimeout(res, 20)), []);
  await Promise.all([r.scan(), r.scan(), r.scan()]);
  tv.deps.discover = async () => tv.found;
  assert.equal(runs, 1);
});

test("resolve(): named TV, else last used, else the only one; several is an error", async () => {
  const r = makeRegistry();
  assert.throws(() => r.resolve(), /No TVs known/);
  tv.found = [TV1];
  await r.scan();
  assert.equal(r.resolve().id, "uuid-1");
  tv.found = [TV1, TV2];
  await r.scan();
  assert.throws(() => r.resolve(), /Several TVs/);
  await r.run(r.pick("uuid-2"), "volume", 5);
  assert.equal(r.resolve().id, "uuid-2");
  assert.equal(r.resolve("uuid-1").id, "uuid-1");
  assert.throws(() => r.resolve("nope"), (e) => e === 404);
});

// --- sessions ---

test("one shared session per TV; reconnects after it closes", async () => {
  const r = makeRegistry([{ host: "10.0.0.5" }]);
  const t = r.list()[0];
  const [a, b] = await Promise.all([r.session(t), r.session(t)]);
  assert.equal(a, b);
  assert.equal(tv.connects.length, 1);
  a.close();
  const c = await r.session(t);
  assert.notEqual(c, a);
  assert.equal(tv.connects.length, 2);
});

test("a request that failed only because the TV dropped the connection is retried once on a new session", async () => {
  const r = makeRegistry([{ host: "10.0.0.5" }]);
  const t = r.list()[0];
  let drops = 1;
  tv.answer = () => {
    if (drops-- > 0) {
      tv.sessions.at(-1)!.close(); // the TV drops the connection mid-request
      return { ok: false, payload: "connection closed" };
    }
    return { ok: true, payload: { volume: 9 } };
  };
  assert.deepEqual((await r.request(t, "ssap://audio/getVolume")).payload, { volume: 9 });
  assert.equal(tv.connects.length, 2);

  drops = 5; // keeps dropping: one retry only, then the failure is reported
  assert.equal((await r.request(t, "ssap://audio/getVolume")).payload, "connection closed");
  await assert.rejects(r.run(t, "volume", 3), /connection closed/);
});

test("a certificate change is reported in the list until forget() re-pairs", async () => {
  seed({ "uuid-1": { ...TV1, seenAt: "T", cert: "AA", key: "k1" } });
  const r = makeRegistry();
  tv.certChanged = true;
  await assert.rejects(r.session(r.pick("uuid-1")), /certificate changed/);
  assert.equal(r.pick("uuid-1").certChanged, true);
  await r.forget(r.pick("uuid-1"));
  const t = r.pick("uuid-1");
  assert.deepEqual([t.certChanged, t.paired, t.certPinned], [false, false, false]);
  assert.equal(loadState().tvs["uuid-1"].mac, TV1.mac); // everything but key/cert kept
});

test("watch(): forwards pushes by kind and reports offline when the TV drops", async () => {
  const r = makeRegistry([{ host: "10.0.0.5" }]);
  const events: any[] = [];
  const stop = await r.watch(r.list()[0], (e) => events.push([e.kind, e.payload]));
  const s = tv.sessions[0];
  assert.deepEqual([...s.subs.keys()].sort(), ["ssap://audio/getVolume", "ssap://com.webos.applicationManager/getForegroundAppInfo", "ssap://com.webos.service.tvpower/power/getPowerState"]);
  s.push("ssap://audio/getVolume", { volume: 7 });
  s.close();
  assert.deepEqual(events, [["volume", { volume: 7 }], ["offline", "connection to the TV closed"]]);
  stop();
  assert.equal(s.subs.size, 0);
});

// --- actions ---

test("actions map to the right TV call", async () => {
  const r = makeRegistry([{ host: "10.0.0.5" }]);
  const t = r.list()[0];
  const cases: [string, any, any][] = [
    ["volume", 30, { uri: "ssap://audio/setVolume", payload: { volume: 30 } }],
    ["mute", true, { uri: "ssap://audio/setMute", payload: { mute: true } }],
    ["input", "HDMI_1", { uri: "ssap://tv/switchInput", payload: { inputId: "HDMI_1" } }],
    ["launch", "netflix", { uri: "ssap://system.launcher/launch", payload: { id: "netflix" } }],
    ["media", "pause", { uri: "ssap://media.controls/pause", payload: undefined }],
    ["powerOff", undefined, { uri: "ssap://system/turnOff", payload: undefined }],
    ["alert", "  Dinner's ready  ", { uri: "ssap://system.notifications/createAlert", payload: { message: "Dinner's ready", buttons: [{ label: "OK", focus: true }] } }],
    ["youtube", "https://youtu.be/dQw4w9WgXcQ", { uri: "ssap://system.launcher/launch", payload: { id: "youtube.leanback.v4", contentTarget: "https://www.youtube.com/tv?v=dQw4w9WgXcQ" } }],
    ["text", "hello", { uri: "ssap://com.webos.service.ime/insertText", payload: { text: "hello", replace: false } }],
    ["key", "enter", { uri: "ssap://com.webos.service.ime/sendEnterKey", payload: undefined }],
    ["key", "backspace", { uri: "ssap://com.webos.service.ime/deleteCharacters", payload: { count: 1 } }],
    ["button", "HOME", { frame: "type:button\nname:HOME\n\n" }],
    ["pointer", { dx: 5, dy: -3 }, { frame: "type:move\ndx:5\ndy:-3\ndown:0\n\n" }],
    ["click", undefined, { frame: "type:click\n\n" }],
    ["scroll", { dy: 40 }, { frame: "type:scroll\ndx:0\ndy:40\n\n" }],
  ];
  for (const [action, arg, expected] of cases) {
    tv.calls = [];
    await r.run(t, action, arg);
    assert.deepEqual(tv.calls, [{ id: t.id, ...expected }], action);
  }
});

test("invalid arguments throw 400 and never reach the TV", async () => {
  const r = makeRegistry([{ host: "10.0.0.5" }]);
  const t = r.list()[0];
  const bad: [string, any][] = [
    ["volume", 101], ["volume", -1], ["volume", 2.5], ["volume", "30"], ["mute", "true"],
    ["input", "HDMI 1; rm"], ["input", "x".repeat(129)], ["launch", undefined], ["launch", "../etc"],
    ["media", "eject"], ["button", "REBOOT"],
    ["alert", ""], ["alert", "   "], ["alert", "x".repeat(201)], ["alert", 42],
    ["youtube", "https://evil.example/watch?v=dQw4w9WgXcQ"], ["youtube", "javascript:alert(1)"], ["youtube", "not-an-id"],
    ["text", ""], ["text", "x".repeat(501)], ["text", ["a"]], ["key", "delete"],
    ["pointer", { dx: 501, dy: 0 }], ["pointer", { dx: 1 }], ["pointer", { dx: 1.5, dy: 0 }], ["pointer", "1,1"],
    ["scroll", { dy: -501 }], ["scroll", {}],
    ["nope", 1], ["__proto__", 1], ["constructor", 1], ["toString", 1], [undefined as any, 1],
  ];
  for (const [action, arg] of bad) await assert.rejects(r.run(t, action, arg), (e) => e === 400, `${action} ${JSON.stringify(arg)}`);
  assert.deepEqual(tv.calls, []);
});

test("a TV-side refusal becomes an error with the TV's message", async () => {
  const r = makeRegistry([{ host: "10.0.0.5" }]);
  tv.answer = () => ({ ok: false, payload: "401 insufficient permissions" });
  await assert.rejects(r.run(r.list()[0], "volume", 10), /401 insufficient permissions/);
});

test("powerOn: config/discovered MAC and broadcast; a clear error without a MAC", async () => {
  const r = makeRegistry([{ host: "10.0.0.5", mac: "aa:aa:aa:aa:aa:aa", broadcast: "10.0.0.255" }, { host: "10.0.0.6" }]);
  const [withMac, without] = r.list();
  await r.run(withMac, "powerOn", undefined);
  assert.deepEqual(tv.calls, [{ wake: "aa:aa:aa:aa:aa:aa", broadcast: "10.0.0.255" }]);
  await assert.rejects(r.run(without, "powerOn", undefined), /No MAC known for 10\.0\.0\.6/);
});

test("parseYouTube: the usual link forms and a bare id; everything else rejected", () => {
  const id = "dQw4w9WgXcQ";
  for (const ok of [
    id, `https://www.youtube.com/watch?v=${id}`, `https://youtube.com/watch?v=${id}&t=42s`, `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}&list=x`, `https://youtu.be/${id}?si=abc`, `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`, `https://www.youtube.com/embed/${id}`, `  ${id}  `, `http://youtu.be/${id}`,
  ]) assert.equal(parseYouTube(ok), id, ok);
  for (const bad of [
    "", "short", `${id}x`, `https://evil.example/watch?v=${id}`, `https://youtube.com.evil.example/watch?v=${id}`,
    `javascript:alert('${id}')`, `ftp://youtu.be/${id}`, "https://youtube.com/watch?v=bad<script>", "https://youtube.com/watch",
    `https://youtu.be/`, 42, null, "x".repeat(301),
  ]) assert.equal(parseYouTube(bad), undefined, String(bad));
});

test("loadConfig: missing file is empty, bad entries rejected with the index", () => {
  const dir = dirname(process.env.LGTV_STATE!);
  assert.deepEqual(loadConfig(join(dir, "nope.json")), []);
  const f = join(dir, "tvs.json");
  writeFileSync(f, JSON.stringify([{ host: "10.0.0.5", name: "A", uuid: "u", extra: 1 }]));
  assert.deepEqual(loadConfig(f), [{ host: "10.0.0.5", name: "A", mac: undefined, broadcast: undefined, uuid: "u" }]);
  for (const [bad, msg] of [[{}, /expected an array/], [[{ name: "x" }], /\[0\].*host/], [[{ host: "a b" }], /host/], [[{ host: "x", mac: 1 }], /mac/]] as const) {
    writeFileSync(f, JSON.stringify(bad));
    assert.throws(() => loadConfig(f), msg);
  }
  writeFileSync(f, "{oops");
  assert.throws(() => loadConfig(f), /tvs\.json/);
});
