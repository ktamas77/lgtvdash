// Client tests against a fake TV: lgtv.ts's transport is swapped for a scripted stand-in
// that presents a chosen TLS certificate fingerprint.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "lgtv-"));
process.env.LGTV_STATE = join(DIR, "state.json");
const STATE = process.env.LGTV_STATE;
const lgtv = await import("../lgtv.ts");
const { connect, ask, magicPacket, parseSsdp, absorb, loadState, migrateV1, transport, CertChangedError } = lgtv;

type Msg = Record<string, any>;
class FakeConn extends EventEmitter {
  static script: (m: Msg, c: FakeConn) => Msg[] = () => [];
  static cert: string | undefined = "AA:AA";
  static conns: FakeConn[] = [];
  sent: any[] = [];
  closed = false;
  url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeConn.conns.push(this);
    const cert = FakeConn.cert;
    setImmediate(() => this.emit("open", cert));
  }
  send(s: string) {
    let m: Msg;
    try { m = JSON.parse(s); } catch { return void this.sent.push(s); } // pointer frames are plain text
    this.sent.push(m);
    for (const r of FakeConn.script(m, this)) this.reply(r);
  }
  reply(r: Msg | string) { setImmediate(() => this.emit("message", typeof r === "string" ? r : JSON.stringify(r))); }
  close() { this.closed = true; setImmediate(() => this.emit("close")); }
}
transport.open = (url: string) => new FakeConn(url) as any;

const T1 = { id: "uuid-1", host: "10.0.0.5" };
const registered = (key = "k1"): Msg => ({ id: "reg", type: "registered", payload: { "client-key": key } });
const ok = (m: Msg, payload: Msg = {}): Msg => ({ id: m.id, type: "response", payload: { returnValue: true, ...payload } });
const echo = (key = "k1") => (m: Msg) => (m.type === "register" ? [registered(m.payload["client-key"] ?? key)] : m.type === "request" ? [ok(m, { uri: m.uri })] : []);
const registerOf = (i = 0) => FakeConn.conns[i].sent.find((m) => m.type === "register");
const seed = (tvs: object) => writeFileSync(STATE, JSON.stringify({ version: 2, tvs }));

beforeEach(() => {
  FakeConn.conns = [];
  FakeConn.cert = "AA:AA";
  FakeConn.script = echo();
  rmSync(STATE, { force: true });
});

// --- pairing, certificate pinning ---

test("first contact: pairs over wss, pins the certificate, saves the key", async () => {
  FakeConn.script = (m) => (m.type === "register" ? [{ id: "reg", type: "response", payload: { pairingType: "PROMPT" } }, registered("k1")] : []);
  const s = await connect(T1, { timeoutMs: 1000 });
  assert.equal(FakeConn.conns[0].url, "wss://10.0.0.5:3001");
  assert.equal(registerOf().payload["client-key"], undefined);
  assert.deepEqual(loadState().tvs["uuid-1"], { host: "10.0.0.5", cert: "AA:AA", key: "k1", locked: true });
  s.close();
});

test("requirePinned (unverified address): fails closed without a pinned certificate, never registers", async () => {
  await assert.rejects(connect({ id: "uuid-1", host: "10.0.0.66" }, { timeoutMs: 1000, requirePinned: true }), CertChangedError);
  assert.equal(FakeConn.conns.length, 0); // not even a TLS connection
  seed({ "uuid-1": { host: "10.0.0.5", cert: "AA:AA", key: "k1" } });
  FakeConn.cert = "EV:IL";
  await assert.rejects(connect({ id: "uuid-1", host: "10.0.0.66" }, { timeoutMs: 1000, requirePinned: true }), CertChangedError);
  assert.equal(registerOf(), undefined);
});

test("matching certificate: the saved key is sent", async () => {
  seed({ "uuid-1": { host: "10.0.0.5", cert: "AA:AA", key: "k1" } });
  (await connect(T1, { timeoutMs: 1000 })).close();
  assert.equal(registerOf().payload["client-key"], "k1");
});

test("changed certificate: the key is never sent and the error says so", async () => {
  seed({ "uuid-1": { host: "10.0.0.5", cert: "AA:AA", key: "k1" } });
  FakeConn.cert = "BB:BB";
  await assert.rejects(connect(T1, { timeoutMs: 1000 }), (e: any) => e instanceof CertChangedError && /certificate changed/.test(e.message));
  assert.equal(registerOf(), undefined);
  assert.ok(FakeConn.conns[0].closed);
});

test("same TV at a new IP with the same certificate: gets its key", async () => {
  seed({ "uuid-1": { host: "10.0.0.5", cert: "AA:AA", key: "k1" } });
  (await connect({ id: "uuid-1", host: "10.0.0.99" }, { timeoutMs: 1000 })).close();
  assert.equal(registerOf().payload["client-key"], "k1");
  assert.equal(loadState().tvs["uuid-1"].host, "10.0.0.99");
});

test("key without a pinned certificate (migrated) is only sent to the IP it was paired on", async () => {
  seed({ "uuid-1": { host: "10.0.0.5", key: "k1" } });
  (await connect({ id: "uuid-1", host: "10.0.0.99" }, { timeoutMs: 1000 })).close();
  assert.equal(registerOf(0).payload["client-key"], undefined);
  seed({ "uuid-1": { host: "10.0.0.5", key: "k1" } });
  (await connect(T1, { timeoutMs: 1000 })).close();
  assert.equal(registerOf(1).payload["client-key"], "k1");
  assert.equal(loadState().tvs["uuid-1"].cert, "AA:AA"); // pinned from now on
});

test("no certificate at all is refused", async () => {
  FakeConn.cert = undefined;
  await assert.rejects(connect(T1, { timeoutMs: 1000 }), /no TLS certificate/);
  assert.equal(registerOf(), undefined);
});

test("refused pairing, missing key, garbage, and silence all reject", async () => {
  FakeConn.script = () => [{ id: "reg", type: "error", error: "403 cancelled" }];
  await assert.rejects(connect(T1, { timeoutMs: 1000 }), /refused pairing: 403 cancelled/);
  FakeConn.script = () => [{ id: "reg", type: "registered", payload: {} }];
  await assert.rejects(connect(T1, { timeoutMs: 1000 }), /no client key/);
  assert.deepEqual(loadState().tvs, {});
  FakeConn.script = () => ["{not json" as any];
  await assert.rejects(connect(T1, { timeoutMs: 1000 }), /unreadable/);
  FakeConn.script = () => [];
  await assert.rejects(connect(T1, { timeoutMs: 50 }), /timeout/);
});

// --- session ---

test("requests: answers matched by id, errors and returnValue:false are ok:false", async () => {
  FakeConn.script = (m) => {
    if (m.type === "register") return [registered()];
    if (m.uri === "ssap://denied") return [{ id: m.id, type: "error", error: "401 insufficient permissions" }];
    if (m.uri === "ssap://failed") return [{ id: m.id, type: "response", payload: { returnValue: false } }];
    return [ok(m, { uri: m.uri })];
  };
  const s = await connect(T1, { timeoutMs: 1000 });
  const [a, denied, failed] = await Promise.all([s.request("ssap://a"), s.request("ssap://denied"), s.request("ssap://failed")]);
  assert.deepEqual([a.ok, a.payload.uri], [true, "ssap://a"]);
  assert.deepEqual([denied.ok, denied.payload], [false, "401 insufficient permissions"]);
  assert.equal(failed.ok, false);
  s.close();
});

test("an unanswered request times out; requests after close fail fast", async () => {
  FakeConn.script = (m) => (m.type === "register" ? [registered()] : []);
  const s = await connect(T1, { timeoutMs: 1000 });
  assert.deepEqual(await s.request("ssap://slow", {}, 30), { uri: "ssap://slow", ok: false, payload: "timeout: no answer from the TV" });
  s.close();
  assert.equal((await s.request("ssap://a")).payload, "connection closed");
});

test("pending requests fail and onClose fires when the TV drops", async () => {
  FakeConn.script = (m) => (m.type === "register" ? [registered()] : []);
  const s = await connect(T1, { timeoutMs: 1000 });
  let closed = 0;
  s.onClose(() => closed++);
  const pending = s.request("ssap://a");
  FakeConn.conns[0].emit("close");
  assert.equal((await pending).payload, "connection closed");
  assert.equal(closed, 1);
  assert.ok(s.closed);
});

test("subscriptions deliver every push until unsubscribed", async () => {
  const s = await connect(T1, { timeoutMs: 1000 });
  const got: any[] = [];
  const off = s.subscribe("ssap://audio/getVolume", (r) => got.push(r.payload.volume));
  const conn = FakeConn.conns[0];
  const sub = conn.sent.find((m) => m.type === "subscribe");
  assert.equal(sub.uri, "ssap://audio/getVolume");
  conn.reply(ok(sub, { volume: 10 }));
  conn.reply(ok(sub, { volume: 11 }));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  off();
  conn.reply(ok(sub, { volume: 12 }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, [10, 11]);
  assert.deepEqual(conn.sent.at(-1), { type: "unsubscribe", id: sub.id });
  s.close();
});

test("pointer frames go over one lazily opened pointer socket", async () => {
  FakeConn.script = (m) => (m.type === "register" ? [registered()] : [ok(m, { socketPath: "ws://10.0.0.5:3000/pointer" })]);
  const s = await connect(T1, { timeoutMs: 1000 });
  await s.pointer("type:button\nname:UP\n\n");
  await s.pointer("type:click\n\n");
  const pointers = FakeConn.conns.filter((c) => c.url === "ws://10.0.0.5:3000/pointer");
  assert.equal(pointers.length, 1);
  assert.deepEqual(pointers[0].sent, ["type:button\nname:UP\n\n", "type:click\n\n"]);
  s.close();
});

test("ask(): connect, batch, close", async () => {
  const res = await ask(T1, [["ssap://a"], ["ssap://b", { x: 1 }]], 1000);
  assert.deepEqual(res.map((r) => r.payload.uri), ["ssap://a", "ssap://b"]);
  assert.deepEqual(FakeConn.conns[0].sent[2].payload, { x: 1 });
  assert.ok(FakeConn.conns[0].closed);
});

// --- state ---

test("v1 state migrates: keys move onto their TV, entries re-keyed by uuid", () => {
  const s = migrateV1({
    keys: { "10.0.0.5": "k1", "10.0.0.7": "k7" },
    tvs: { "10.0.0.5": { host: "10.0.0.5", id: "uuid-1", name: "TV", mac: "aa:aa:aa:aa:aa:aa" }, "10.0.0.6": { host: "10.0.0.6" } },
  });
  assert.deepEqual(s, {
    version: 2,
    tvs: {
      "uuid-1": { host: "10.0.0.5", uuid: "uuid-1", name: "TV", mac: "aa:aa:aa:aa:aa:aa", key: "k1", locked: true },
      "host:10.0.0.6": { host: "10.0.0.6" },
      "host:10.0.0.7": { host: "10.0.0.7", key: "k7", locked: true },
    },
  });
  writeFileSync(STATE, JSON.stringify({ keys: { "10.0.0.5": "k1" }, tvs: { "10.0.0.5": { host: "10.0.0.5", id: "uuid-1" } } }));
  assert.equal(loadState().tvs["uuid-1"].key, "k1");
});

test("unreadable state is treated as empty", () => {
  writeFileSync(STATE, "not json");
  assert.deepEqual(loadState(), { version: 2, tvs: {} });
});

// --- Wake-on-LAN, discovery parsing ---

test("magicPacket: 6x FF then the MAC 16 times, any separator", () => {
  const p = magicPacket("0A-1b:2c.3D:4e:5f");
  assert.equal(p.length, 102);
  assert.equal(p.subarray(0, 6).toString("hex"), "ffffffffffff");
  assert.equal(p.subarray(6).toString("hex"), "0a1b2c3d4e5f".repeat(16));
  assert.throws(() => magicPacket("0a:1b:2c"), /MAC/);
  assert.throws(() => magicPacket("zz:zz:zz:zz:zz:zz"), /MAC/);
});

// Shapes copied from a real webOS 4.x TV, values neutralised.
const secondScreen = [
  "HTTP/1.1 200 OK", "Location: http://10.0.0.5:1673/", "Cache-Control: max-age=1800", "Server: WebOS/4.1.0 UPnP/1.0", "EXT: ",
  "USN: uuid:11111111-2222-3333-4444-555555555555::urn:lge-com:service:webos-second-screen:1",
  "ST: urn:lge-com:service:webos-second-screen:1", "",
].join("\r\n");
const dial = [
  "HTTP/1.1 200 OK", "Location: http://10.0.0.5:1444/", "USN: uuid:aaaa::urn:dial-multiscreen-org:service:dial:1",
  "ST: urn:dial-multiscreen-org:service:dial:1", "WAKEUP: MAC=0A:1B:2C:3D:4E:5F;Timeout=60", "",
].join("\r\n");
const sonos = ["HTTP/1.1 200 OK", "ST: upnp:rootdevice", "USN: uuid:RINCON::upnp:rootdevice", ""].join("\r\n");

test("parseSsdp: lowercases header names, keeps values (including colons)", () => {
  const h = parseSsdp(secondScreen);
  assert.equal(h.location, "http://10.0.0.5:1673/");
  assert.equal(h.ext, "");
});

test("absorb: webOS answer creates a TV with its uuid; DIAL adds the MAC; others ignored", () => {
  const found = new Map(), macs = new Map();
  absorb(found, macs, "10.0.0.5", dial);
  absorb(found, macs, "10.0.0.5", secondScreen);
  absorb(found, macs, "10.0.0.5", secondScreen);
  absorb(found, macs, "10.0.0.9", sonos);
  absorb(found, macs, "10.0.0.7", dial.replace(/WAKEUP.*\r\n/, "")); // DIAL-only device (e.g. Chromecast)
  assert.deepEqual([...found.values()], [{ host: "10.0.0.5", uuid: "11111111-2222-3333-4444-555555555555", location: "http://10.0.0.5:1673/" }]);
  assert.deepEqual([...macs], [["10.0.0.5", "0a:1b:2c:3d:4e:5f"]]);
});
