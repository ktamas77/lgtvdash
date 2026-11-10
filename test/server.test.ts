// HTTP layer tests: real server on a random port, fake TV functions injected.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";

process.env.LGTV_HOST = "tv.test";
const { app, QUERIES } = await import("../server.ts");

let calls: any[] = [];
let tvAnswer: (uri: string) => { ok: boolean; payload: any } = () => ({ ok: true, payload: {} });
let tvDown = false;
const tv = {
  ask: async (reqs: any[]) => {
    if (tvDown) throw new Error("websocket error: connection failed");
    calls.push(...reqs.map(([uri, payload]) => ({ uri, payload })));
    return reqs.map(([uri]) => ({ uri, ...tvAnswer(uri) }));
  },
  button: async (name: string) => void calls.push({ button: name }),
  wake: async (mac: string, bcast?: string) => void calls.push({ wake: mac, bcast }),
};

let server: Server, base: string, port: number;
before(async () => {
  server = createServer(app(tv as any));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});
after(() => server.close());
beforeEach(() => {
  calls = [];
  tvAnswer = () => ({ ok: true, payload: {} });
  tvDown = false;
  delete process.env.LGTV_MAC;
});

const cmd = (body: any, headers: Record<string, string> = { "content-type": "application/json" }) =>
  fetch(base + "/api/cmd", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

// fetch can't override Host, so use node:http for that one.
const withHost = (host: string) => new Promise<number>((resolve, reject) =>
  request({ port, path: "/api/info", headers: { host } }, (res) => resolve(res.statusCode!)).on("error", reject).end());

test("GET /api/info returns every query by name", async () => {
  const res = await fetch(base + "/api/info");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), Object.keys(QUERIES));
  assert.equal(calls.length, Object.keys(QUERIES).length);
});

test("GET /api/info is 502 when the TV is unreachable", async () => {
  tvDown = true;
  const res = await fetch(base + "/api/info");
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

test("valid actions map to the right TV call", async () => {
  const cases: [any, any][] = [
    [{ action: "volume", arg: 30 }, { uri: "ssap://audio/setVolume", payload: { volume: 30 } }],
    [{ action: "mute", arg: true }, { uri: "ssap://audio/setMute", payload: { mute: true } }],
    [{ action: "input", arg: "HDMI_1" }, { uri: "ssap://tv/switchInput", payload: { inputId: "HDMI_1" } }],
    [{ action: "launch", arg: "youtube.leanback.v4" }, { uri: "ssap://system.launcher/launch", payload: { id: "youtube.leanback.v4" } }],
    [{ action: "media", arg: "pause" }, { uri: "ssap://media.controls/pause", payload: undefined }],
    [{ action: "powerOff" }, { uri: "ssap://system/turnOff", payload: undefined }],
    [{ action: "button", arg: "HOME" }, { button: "HOME" }],
  ];
  for (const [body, expected] of cases) {
    calls = [];
    const res = await cmd(body);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(calls, [expected]);
  }
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

test("CSRF guard: cross-origin and non-JSON POSTs are 403", async () => {
  const body = { action: "powerOff" };
  assert.equal((await cmd(body, { "content-type": "application/json", origin: "https://evil.example" })).status, 403);
  assert.equal((await cmd(body, { "content-type": "text/plain" })).status, 403);
  assert.equal((await cmd(body, { "content-type": "application/x-www-form-urlencoded" })).status, 403);
  assert.equal((await cmd(body, { "content-type": "application/json", origin: base })).status, 200);
  assert.deepEqual(calls, [{ uri: "ssap://system/turnOff", payload: undefined }]);
});

test("malformed and oversized bodies are 400", async () => {
  assert.equal((await cmd("{not json")).status, 400);
  assert.equal((await cmd(JSON.stringify({ action: "volume", arg: 1, pad: "x".repeat(2000) }))).status, 400);
  assert.deepEqual(calls, []);
});

test("a TV-side refusal is a 502 with the TV's error", async () => {
  tvAnswer = () => ({ ok: false, payload: "401 insufficient permissions" });
  const res = await cmd({ action: "volume", arg: 10 });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "401 insufficient permissions");
});

test("powerOn needs LGTV_MAC, then wakes with the configured broadcast", async () => {
  const res = await cmd({ action: "powerOn" });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /LGTV_MAC/);

  process.env.LGTV_MAC = "aa:bb:cc:dd:ee:ff";
  process.env.LGTV_BROADCAST = "10.0.0.255";
  assert.equal((await cmd({ action: "powerOn" })).status, 200);
  assert.deepEqual(calls, [{ wake: "aa:bb:cc:dd:ee:ff", bcast: "10.0.0.255" }]);
  delete process.env.LGTV_BROADCAST;
});
