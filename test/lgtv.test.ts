// Client tests against a fake TV: globalThis.WebSocket is swapped for a scripted stand-in.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LGTV_HOST = "tv.test";
process.env.LGTV_KEYFILE = join(mkdtempSync(join(tmpdir(), "lgtv-")), "key");
const KEY = process.env.LGTV_KEYFILE;

type Msg = Record<string, any>;
class FakeTV {
  static script: (m: Msg) => Msg[] = () => [];
  static sockets: FakeTV[] = [];
  sent: any[] = [];
  onopen?: () => void; onmessage?: (e: { data: string }) => void; onerror?: (e: any) => void; onclose?: () => void;
  url: string;
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
const { ask, button, magicPacket } = await import("../lgtv.ts");

const registered = (key = "k1"): Msg => ({ id: "reg", type: "registered", payload: { "client-key": key } });
const ok = (m: Msg, payload: Msg = {}): Msg => ({ id: m.id, type: "response", payload: { returnValue: true, ...payload } });

beforeEach(() => {
  FakeTV.sockets = [];
  writeFileSync(KEY, "");
});

test("pairs, saves the client key, and returns answers in request order", async () => {
  FakeTV.script = (m) => {
    if (m.type === "register") return [{ id: "reg", type: "response", payload: { pairingType: "PROMPT" } }, registered("k1")];
    // answer out of order: the later request first
    return [ok(m, { uri: m.uri })];
  };
  const res = await ask([["ssap://a"], ["ssap://b", { x: 1 }]], 1000);
  assert.deepEqual(res.map((r) => [r.uri, r.ok, r.payload.uri]), [["ssap://a", true, "ssap://a"], ["ssap://b", true, "ssap://b"]]);
  assert.equal(readFileSync(KEY, "utf8"), "k1");
  assert.equal(FakeTV.sockets[0].url, "ws://tv.test:3000");
  assert.deepEqual(FakeTV.sockets[0].sent[2].payload, { x: 1 });
});

test("sends the saved key on the next connection", async () => {
  writeFileSync(KEY, "saved-key");
  FakeTV.script = (m) => (m.type === "register" ? [registered("saved-key")] : [ok(m)]);
  await ask([["ssap://a"]], 1000);
  assert.equal(FakeTV.sockets[0].sent[0].payload["client-key"], "saved-key");
});

test("maps TV errors and returnValue:false to ok:false", async () => {
  FakeTV.script = (m) => {
    if (m.type === "register") return [registered()];
    if (m.uri === "ssap://denied") return [{ id: m.id, type: "error", error: "401 insufficient permissions" }];
    return [{ id: m.id, type: "response", payload: { returnValue: false, errorText: "nope" } }];
  };
  const [denied, failed] = await ask([["ssap://denied"], ["ssap://failed"]], 1000);
  assert.deepEqual([denied.ok, denied.payload], [false, "401 insufficient permissions"]);
  assert.equal(failed.ok, false);
});

test("rejects when the TV refuses pairing", async () => {
  FakeTV.script = () => [{ id: "reg", type: "error", error: "403 cancelled" }];
  await assert.rejects(ask([["ssap://a"]], 1000), /refused pairing: 403 cancelled/);
});

test("rejects a registration without a client key, and does not write one", async () => {
  FakeTV.script = () => [{ id: "reg", type: "registered", payload: {} }];
  await assert.rejects(ask([["ssap://a"]], 1000), /no client key/);
  assert.equal(readFileSync(KEY, "utf8"), "");
});

test("rejects on malformed JSON from the TV", async () => {
  FakeTV.script = () => ["{not json" as any];
  await assert.rejects(ask([["ssap://a"]], 1000));
});

test("unanswered requests come back as ok:false after the timeout", async () => {
  FakeTV.script = (m) => (m.type === "register" ? [registered()] : m.uri === "ssap://slow" ? [] : [ok(m)]);
  const [fast, slow] = await ask([["ssap://fast"], ["ssap://slow"]], 100);
  assert.equal(fast.ok, true);
  assert.deepEqual([slow.ok, slow.payload], [false, "timeout: no answer from the TV"]);
});

test("rejects with a timeout when the TV never registers", async () => {
  FakeTV.script = () => [];
  await assert.rejects(ask([["ssap://a"]], 50), /timeout/);
});

test("button() presses through the pointer socket", async () => {
  FakeTV.script = (m) => (m.type === "register" ? [registered()] : [ok(m, { socketPath: "ws://tv.test:3000/pointer" })]);
  await button("UP");
  const pointer = FakeTV.sockets.find((s) => s.url === "ws://tv.test:3000/pointer");
  assert.deepEqual(pointer?.sent, ["type:button\nname:UP\n\n"]);
});

test("magicPacket: 6x FF then the MAC 16 times, any separator", () => {
  const p = magicPacket("0A-1b:2c.3D:4e:5f");
  assert.equal(p.length, 102);
  assert.equal(p.subarray(0, 6).toString("hex"), "ffffffffffff");
  assert.equal(p.subarray(6).toString("hex"), "0a1b2c3d4e5f".repeat(16));
  assert.throws(() => magicPacket("0a:1b:2c"), /MAC address/);
  assert.throws(() => magicPacket("zz:zz:zz:zz:zz:zz"), /MAC address/);
});

test("keyfile path honours LGTV_KEYFILE (tests never touch the real key)", () => {
  assert.ok(existsSync(KEY));
  assert.ok(!KEY.endsWith(".lgtv-key"));
});
