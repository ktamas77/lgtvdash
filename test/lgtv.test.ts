// Client tests against a fake TV: globalThis.WebSocket is swapped for a scripted stand-in.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "lgtv-"));
process.env.LGTV_STATE = join(DIR, "state.json");
const STATE = process.env.LGTV_STATE;
const LEGACY = join(DIR, ".lgtv-key");

type Msg = Record<string, any>;
class FakeTV {
  static script: (m: Msg) => Msg[] = () => [];
  static sockets: FakeTV[] = [];
  sent: any[] = [];
  url: string;
  onopen?: () => void; onmessage?: (e: { data: string }) => void; onerror?: (e: any) => void; onclose?: () => void;
  constructor(url: string) {
    this.url = url;
    FakeTV.sockets.push(this);
    setImmediate(() => this.onopen?.());
  }
  send(s: string) {
    let m: Msg;
    try { m = JSON.parse(s); } catch { return void this.sent.push(s); } // pointer socket frames are plain text
    this.sent.push(m);
    for (const r of FakeTV.script(m)) setImmediate(() => this.onmessage?.({ data: typeof r === "string" ? r : JSON.stringify(r) }));
  }
  close() {}
}
(globalThis as any).WebSocket = FakeTV;
const { ask, button, magicPacket, parseSsdp, absorb, loadState } = await import("../lgtv.ts");

const registered = (key = "k1"): Msg => ({ id: "reg", type: "registered", payload: { "client-key": key } });
const ok = (m: Msg, payload: Msg = {}): Msg => ({ id: m.id, type: "response", payload: { returnValue: true, ...payload } });
const sentKey = (i = 0) => FakeTV.sockets[i].sent[0].payload["client-key"];

beforeEach(() => {
  FakeTV.sockets = [];
  rmSync(STATE, { force: true });
  rmSync(LEGACY, { force: true });
});

test("pairs, saves the key for that host, and returns answers in request order", async () => {
  FakeTV.script = (m) => {
    if (m.type === "register") return [{ id: "reg", type: "response", payload: { pairingType: "PROMPT" } }, registered("k1")];
    return [ok(m, { uri: m.uri })];
  };
  const res = await ask("tv1.test", [["ssap://a"], ["ssap://b", { x: 1 }]], 1000);
  assert.deepEqual(res.map((r) => [r.uri, r.ok, r.payload.uri]), [["ssap://a", true, "ssap://a"], ["ssap://b", true, "ssap://b"]]);
  assert.equal(FakeTV.sockets[0].url, "ws://tv1.test:3000");
  assert.equal(sentKey(), undefined);
  assert.deepEqual(FakeTV.sockets[0].sent[2].payload, { x: 1 });
  assert.deepEqual(loadState().keys, { "tv1.test": "k1" });
});

test("keeps one key per TV and sends each TV its own", async () => {
  writeFileSync(STATE, JSON.stringify({ keys: { "tv1.test": "key-1" } }));
  FakeTV.script = (m) => (m.type === "register" ? [registered(m.payload["client-key"] ?? "key-2")] : [ok(m)]);
  await ask("tv1.test", [["ssap://a"]], 1000);
  await ask("tv2.test", [["ssap://a"]], 1000);
  assert.equal(sentKey(0), "key-1");
  assert.equal(sentKey(1), undefined); // never offers TV 1's key to TV 2
  assert.deepEqual(loadState().keys, { "tv1.test": "key-1", "tv2.test": "key-2" });
});

test("never sends a key to a host it wasn't issued by (a spoofed SSDP answer gets nothing)", async () => {
  writeFileSync(LEGACY, "old-single-tv-key\n"); // pre-multi-TV key file is ignored, never migrated
  writeFileSync(STATE, JSON.stringify({ keys: { "tv1.test": "key-1" } }));
  FakeTV.script = (m) => (m.type === "register" ? [registered("fresh")] : [ok(m)]);
  await ask("spoof.test", [["ssap://a"]], 1000);
  assert.equal(sentKey(0), undefined);
});

test("maps TV errors and returnValue:false to ok:false", async () => {
  FakeTV.script = (m) => {
    if (m.type === "register") return [registered()];
    if (m.uri === "ssap://denied") return [{ id: m.id, type: "error", error: "401 insufficient permissions" }];
    return [{ id: m.id, type: "response", payload: { returnValue: false, errorText: "nope" } }];
  };
  const [denied, failed] = await ask("tv.test", [["ssap://denied"], ["ssap://failed"]], 1000);
  assert.deepEqual([denied.ok, denied.payload], [false, "401 insufficient permissions"]);
  assert.equal(failed.ok, false);
});

test("rejects when the TV refuses pairing", async () => {
  FakeTV.script = () => [{ id: "reg", type: "error", error: "403 cancelled" }];
  await assert.rejects(ask("tv.test", [["ssap://a"]], 1000), /refused pairing: 403 cancelled/);
});

test("rejects a registration without a client key, and saves nothing", async () => {
  FakeTV.script = () => [{ id: "reg", type: "registered", payload: {} }];
  await assert.rejects(ask("tv.test", [["ssap://a"]], 1000), /no client key/);
  assert.deepEqual(loadState().keys, {});
});

test("rejects on malformed JSON from the TV", async () => {
  FakeTV.script = () => ["{not json" as any];
  await assert.rejects(ask("tv.test", [["ssap://a"]], 1000));
});

test("unanswered requests come back as ok:false after the timeout", async () => {
  FakeTV.script = (m) => (m.type === "register" ? [registered()] : m.uri === "ssap://slow" ? [] : [ok(m)]);
  const [fast, slow] = await ask("tv.test", [["ssap://fast"], ["ssap://slow"]], 100);
  assert.equal(fast.ok, true);
  assert.deepEqual([slow.ok, slow.payload], [false, "timeout: no answer from the TV"]);
});

test("rejects with a timeout when the TV never registers", async () => {
  FakeTV.script = () => [];
  await assert.rejects(ask("tv.test", [["ssap://a"]], 50), /timeout/);
});

test("button() presses through the pointer socket", async () => {
  FakeTV.script = (m) => (m.type === "register" ? [registered()] : [ok(m, { socketPath: "ws://tv.test:3000/pointer" })]);
  await button("tv.test", "UP");
  const pointer = FakeTV.sockets.find((s) => s.url === "ws://tv.test:3000/pointer");
  assert.deepEqual(pointer?.sent, ["type:button\nname:UP\n\n"]);
});

test("magicPacket: 6x FF then the MAC 16 times, any separator", () => {
  const p = magicPacket("0A-1b:2c.3D:4e:5f");
  assert.equal(p.length, 102);
  assert.equal(p.subarray(0, 6).toString("hex"), "ffffffffffff");
  assert.equal(p.subarray(6).toString("hex"), "0a1b2c3d4e5f".repeat(16));
  assert.throws(() => magicPacket("0a:1b:2c"), /MAC/);
  assert.throws(() => magicPacket("zz:zz:zz:zz:zz:zz"), /MAC/);
});

// --- discovery parsing (shapes copied from a real webOS 4.x TV, values neutralised) ---
const secondScreen = [
  "HTTP/1.1 200 OK", "Location: http://10.0.0.5:1673/", "Cache-Control: max-age=1800", "Server: WebOS/4.1.0 UPnP/1.0", "EXT: ",
  "USN: uuid:11111111-2222-3333-4444-555555555555::urn:lge-com:service:webos-second-screen:1",
  "ST: urn:lge-com:service:webos-second-screen:1", "",
].join("\r\n");
const dial = [
  "HTTP/1.1 200 OK", "Location: http://10.0.0.5:1444/", "Server: WebOS/1.5 UPnP/1.0 webOSTV/1.0",
  "USN: uuid:aaaa::urn:dial-multiscreen-org:service:dial:1", "ST: urn:dial-multiscreen-org:service:dial:1",
  "WAKEUP: MAC=0A:1B:2C:3D:4E:5F;Timeout=60", "",
].join("\r\n");
const sonos = ["HTTP/1.1 200 OK", "ST: upnp:rootdevice", "SERVER: Linux UPnP/1.0 Sonos/86", "USN: uuid:RINCON::upnp:rootdevice", ""].join("\r\n");

test("parseSsdp: lowercases header names, keeps values (including colons)", () => {
  const h = parseSsdp(secondScreen);
  assert.equal(h.location, "http://10.0.0.5:1673/");
  assert.equal(h.st, "urn:lge-com:service:webos-second-screen:1");
  assert.equal(h.ext, "");
});

test("absorb: a webOS answer creates a TV; DIAL adds its MAC; other devices are ignored", () => {
  const found = new Map(), macs = new Map();
  absorb(found, macs, "10.0.0.5", dial); // MAC can arrive before the webOS answer
  absorb(found, macs, "10.0.0.5", secondScreen);
  absorb(found, macs, "10.0.0.5", secondScreen); // duplicate answers are harmless
  absorb(found, macs, "10.0.0.9", sonos);
  assert.deepEqual([...found.values()], [{ host: "10.0.0.5", id: "11111111-2222-3333-4444-555555555555", location: "http://10.0.0.5:1673/" }]);
  assert.deepEqual([...macs], [["10.0.0.5", "0a:1b:2c:3d:4e:5f"]]);
});

test("absorb: a DIAL-only device (e.g. a Chromecast) is not a TV", () => {
  const found = new Map(), macs = new Map();
  absorb(found, macs, "10.0.0.7", dial.replace("WAKEUP: MAC=0A:1B:2C:3D:4E:5F;Timeout=60", ""));
  assert.equal(found.size, 0);
});

test("state file is the temp one (tests never touch the real keys)", () => {
  writeFileSync(STATE, "not json");
  assert.deepEqual(loadState(), { keys: {}, tvs: {} });
  assert.ok(STATE.startsWith(DIR));
  assert.equal(readFileSync(STATE, "utf8"), "not json");
});
