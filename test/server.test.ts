// HTTP layer tests: real server on a random port, fake TV functions injected.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "lgtv-srv-"));
process.env.LGTV_STATE = join(DIR, "state.json");
const { app, QUERIES, loadConfig } = await import("../server.ts");

const TV1 = "10.0.0.5", TV2 = "10.0.0.6";
let calls: any[] = [];
let found: any[] = [];
let tvAnswer: (uri: string) => { ok: boolean; payload: any } = () => ({ ok: true, payload: {} });
let tvDown = false;
const tv = {
  ask: async (host: string, reqs: any[]) => {
    if (tvDown) throw new Error("websocket error: connection failed");
    calls.push(...reqs.map(([uri, payload]) => ({ host, uri, payload })));
    return reqs.map(([uri]) => ({ uri, ...tvAnswer(uri) }));
  },
  button: async (host: string, name: string) => void calls.push({ host, button: name }),
  wake: async (mac: string, bcast?: string) => void calls.push({ wake: mac, bcast }),
  discover: async () => found,
};

let server: Server, base: string, port: number, handler: ReturnType<typeof app>;
before(async () => {
  handler = app({ tv: tv as any, config: [{ host: TV1, name: "Living room", mac: "aa:aa:aa:aa:aa:aa", broadcast: "10.0.0.255" }] });
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});
after(() => server.close());
beforeEach(async () => {
  calls = [];
  tvAnswer = () => ({ ok: true, payload: {} });
  tvDown = false;
  rmSync(process.env.LGTV_STATE!, { force: true });
  found = [];
  await handler.scan(); // reset "online" set
  delete process.env.LGTV_BROADCAST;
});

const JSONH = { "content-type": "application/json" };
const post = (path: string, body: any, headers: Record<string, string> = JSONH) =>
  fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const cmd = (body: any, headers?: Record<string, string>) => post("/api/cmd", { tv: TV1, ...body }, headers);
const tvs = async () => (await fetch(base + "/api/tvs")).json();

// fetch can't override Host, so use node:http for that one.
const withHost = (host: string) => new Promise<number>((resolve, reject) =>
  request({ port, path: "/api/tvs", headers: { host } }, (res) => resolve(res.statusCode!)).on("error", reject).end());

// --- TV list, discovery, config ---

test("config TVs are listed before any scan", async () => {
  assert.deepEqual(await tvs(), [{ host: TV1, name: "Living room", mac: "aa:aa:aa:aa:aa:aa", broadcast: "10.0.0.255", sources: ["config"], online: false, paired: false }]);
});

test("scan merges discovered TVs: config wins, discovery fills gaps, new TVs are added", async () => {
  found = [
    { host: TV1, name: "[LG] webOS TV", model: "M1", mac: "bb:bb:bb:bb:bb:bb", id: "uuid-1" },
    { host: TV2, name: "Bedroom TV", model: "M2", mac: "cc:cc:cc:cc:cc:cc", id: "uuid-2" },
  ];
  const list = await (await post("/api/scan", {})).json();
  assert.deepEqual(list.map((t: any) => [t.host, t.name, t.model, t.mac, t.sources.join("+"), t.online]), [
    [TV1, "Living room", "M1", "aa:aa:aa:aa:aa:aa", "config+discovered", true],
    [TV2, "Bedroom TV", "M2", "cc:cc:cc:cc:cc:cc", "discovered", true],
  ]);
});

test("a discovered TV is remembered when a later scan misses it (e.g. it's off)", async () => {
  found = [{ host: TV2, name: "Bedroom TV", mac: "cc:cc:cc:cc:cc:cc" }];
  await post("/api/scan", {});
  found = [];
  await post("/api/scan", {});
  const t = (await tvs()).find((t: any) => t.host === TV2);
  assert.deepEqual([t.name, t.mac, t.online], ["Bedroom TV", "cc:cc:cc:cc:cc:cc", false]);
});

test("paired reflects a saved key for that host", async () => {
  writeFileSync(process.env.LGTV_STATE!, JSON.stringify({ keys: { [TV1]: "k" } }));
  assert.equal((await tvs())[0].paired, true);
});

test("concurrent scans share one discovery run", async () => {
  let runs = 0;
  const slow = app({ tv: { ...tv, discover: async () => (runs++, await new Promise((r) => setTimeout(r, 20)), []) } as any });
  await Promise.all([slow.scan(), slow.scan(), slow.scan()]);
  assert.equal(runs, 1);
});

test("loadConfig: missing file is empty, bad entries are rejected with the index", () => {
  assert.deepEqual(loadConfig(join(DIR, "nope.json")), []);
  const f = join(DIR, "tvs.json");
  writeFileSync(f, JSON.stringify([{ host: "10.0.0.5", name: "A", extra: 1 }]));
  assert.deepEqual(loadConfig(f), [{ host: "10.0.0.5", name: "A", mac: undefined, broadcast: undefined }]);
  for (const [bad, msg] of [[{}, /expected an array/], [[{ name: "x" }], /\[0\].*host/], [[{ host: "a b" }], /host/], [[{ host: "x", mac: 1 }], /mac/]] as const) {
    writeFileSync(f, JSON.stringify(bad));
    assert.throws(() => loadConfig(f), msg);
  }
  writeFileSync(f, "{oops");
  assert.throws(() => loadConfig(f), /tvs\.json/);
});

// --- info / commands ---

test("GET /api/info?tv= returns every query by name, from that TV", async () => {
  const res = await fetch(`${base}/api/info?tv=${TV1}`);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(await res.json()), Object.keys(QUERIES));
  assert.ok(calls.every((c) => c.host === TV1));
});

test("unknown or missing TVs are 404 and never contacted", async () => {
  assert.equal((await fetch(`${base}/api/info?tv=10.9.9.9`)).status, 404);
  assert.equal((await fetch(`${base}/api/info`)).status, 404);
  assert.equal((await post("/api/cmd", { tv: "evil.example", action: "powerOff" })).status, 404);
  assert.equal((await post("/api/cmd", { action: "powerOff" })).status, 404);
  assert.deepEqual(calls, []);
});

test("GET /api/info is 502 when the TV is unreachable", async () => {
  tvDown = true;
  const res = await fetch(`${base}/api/info?tv=${TV1}`);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /connection failed/);
});

test("serves the page and 404s unknown paths", async () => {
  assert.match(await (await fetch(base + "/")).text(), /<title>/);
  assert.equal((await fetch(base + "/nope")).status, 404);
});

test("rejects a foreign Host header (DNS rebinding)", async () => {
  assert.equal(await withHost("evil.example:" + port), 403);
  assert.equal(await withHost("localhost:" + port), 200);
});

test("valid actions map to the right TV call on the selected TV", async () => {
  const cases: [any, any][] = [
    [{ action: "volume", arg: 30 }, { host: TV1, uri: "ssap://audio/setVolume", payload: { volume: 30 } }],
    [{ action: "mute", arg: true }, { host: TV1, uri: "ssap://audio/setMute", payload: { mute: true } }],
    [{ action: "input", arg: "HDMI_1" }, { host: TV1, uri: "ssap://tv/switchInput", payload: { inputId: "HDMI_1" } }],
    [{ action: "launch", arg: "youtube.leanback.v4" }, { host: TV1, uri: "ssap://system.launcher/launch", payload: { id: "youtube.leanback.v4" } }],
    [{ action: "media", arg: "pause" }, { host: TV1, uri: "ssap://media.controls/pause", payload: undefined }],
    [{ action: "powerOff" }, { host: TV1, uri: "ssap://system/turnOff", payload: undefined }],
    [{ action: "button", arg: "HOME" }, { host: TV1, button: "HOME" }],
  ];
  for (const [body, expected] of cases) {
    calls = [];
    const res = await cmd(body);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(calls, [expected]);
  }
});

test("commands go to whichever TV is named", async () => {
  found = [{ host: TV2 }];
  await post("/api/scan", {});
  await post("/api/cmd", { tv: TV2, action: "volume", arg: 5 });
  assert.deepEqual(calls, [{ host: TV2, uri: "ssap://audio/setVolume", payload: { volume: 5 } }]);
});

test("invalid arguments are 400 and never reach the TV", async () => {
  const bad = [
    { action: "volume", arg: 101 }, { action: "volume", arg: -1 }, { action: "volume", arg: 2.5 }, { action: "volume", arg: "30" },
    { action: "mute", arg: "true" },
    { action: "input", arg: "HDMI 1; rm" }, { action: "input", arg: "x".repeat(129) },
    { action: "launch", arg: "../etc" }, { action: "launch" },
    { action: "media", arg: "eject" },
    { action: "button", arg: "REBOOT" },
    { action: "nope" }, { action: "__proto__" }, { action: "constructor" }, { action: "toString" }, {},
  ];
  for (const body of bad) assert.equal((await cmd(body)).status, 400, JSON.stringify(body));
  assert.deepEqual(calls, []);
});

test("CSRF guard: cross-origin and non-JSON POSTs are 403, for commands and scans", async () => {
  const body = { action: "powerOff" };
  assert.equal((await cmd(body, { ...JSONH, origin: "https://evil.example" })).status, 403);
  assert.equal((await cmd(body, { "content-type": "text/plain" })).status, 403);
  assert.equal((await cmd(body, { "content-type": "application/x-www-form-urlencoded" })).status, 403);
  assert.equal((await post("/api/scan", {}, { "content-type": "text/plain" })).status, 403);
  assert.equal((await cmd(body, { ...JSONH, origin: base })).status, 200);
  assert.deepEqual(calls, [{ host: TV1, uri: "ssap://system/turnOff", payload: undefined }]);
});

test("malformed and oversized bodies are 400", async () => {
  assert.equal((await post("/api/cmd", "{not json")).status, 400);
  assert.equal((await cmd({ action: "volume", arg: 1, pad: "x".repeat(2000) })).status, 400);
  assert.deepEqual(calls, []);
});

test("a TV-side refusal is a 502 with the TV's error", async () => {
  tvAnswer = () => ({ ok: false, payload: "401 insufficient permissions" });
  const res = await cmd({ action: "volume", arg: 10 });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "401 insufficient permissions");
});

test("powerOn uses the TV's MAC and broadcast; without a MAC it explains how to get one", async () => {
  assert.equal((await cmd({ action: "powerOn" })).status, 200);
  assert.deepEqual(calls, [{ wake: "aa:aa:aa:aa:aa:aa", bcast: "10.0.0.255" }]);

  found = [{ host: TV2 }]; // discovered without a MAC
  await post("/api/scan", {});
  const res = await post("/api/cmd", { tv: TV2, action: "powerOn" });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /No MAC known for 10\.0\.0\.6/);

  calls = [];
  found = [{ host: TV2, mac: "cc:cc:cc:cc:cc:cc" }];
  await post("/api/scan", {});
  process.env.LGTV_BROADCAST = "10.0.0.127";
  assert.equal((await post("/api/cmd", { tv: TV2, action: "powerOn" })).status, 200);
  assert.deepEqual(calls, [{ wake: "cc:cc:cc:cc:cc:cc", bcast: "10.0.0.127" }]);
});
