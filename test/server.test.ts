// HTTP layer tests: real server on a random port, registry with a fake TV.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tv, TV1, makeRegistry } from "./fake.ts";
const { app } = await import("../server.ts");
const { QUERIES } = await import("../tvs.ts");

let server: Server, base: string, port: number, reg: ReturnType<typeof makeRegistry>;
const ID = "host:10.0.0.5";
before(async () => {
  reg = makeRegistry([{ host: "10.0.0.5", name: "Living room" }]);
  server = createServer(app(reg));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});
after(() => (server.closeAllConnections(), server.close()));
beforeEach(() => {
  tv.reset();
  tv.sessions.splice(0); // fresh sessions per test
  reg.list().forEach((t) => reg.session(t).then((s) => s.close(), () => {}));
});

const JSONH = { "content-type": "application/json" };
const post = (path: string, body: any, headers: Record<string, string> = JSONH) =>
  fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const cmd = (body: any, headers?: Record<string, string>) => post("/api/cmd", { tv: ID, ...body }, headers);
const withHost = (host: string, path = "/api/tvs") => new Promise<number>((resolve, reject) =>
  request({ port, path, headers: { host } }, (res) => (res.resume(), resolve(res.statusCode!))).on("error", reject).end());

test("GET /api/tvs lists TVs by id", async () => {
  const list = await (await fetch(base + "/api/tvs")).json();
  assert.deepEqual(list.map((t: any) => [t.id, t.name]), [[ID, "Living room"]]);
});

test("POST /api/scan returns the merged list", async () => {
  tv.found = [TV1];
  const list = await (await post("/api/scan", {})).json();
  assert.deepEqual(list.map((t: any) => [t.id, t.sources.join("+"), t.online]), [["uuid-1", "config+discovered", true]]);
});

test("GET /api/info?tv= returns every query by name", async () => {
  const res = await fetch(`${base}/api/info?tv=${encodeURIComponent(ID)}`);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(await res.json()), Object.keys(QUERIES));
});

test("unknown or missing TVs are 404 and never contacted", async () => {
  tv.connects = [];
  assert.equal((await fetch(`${base}/api/info?tv=10.9.9.9`)).status, 404);
  assert.equal((await fetch(`${base}/api/info`)).status, 404);
  assert.equal((await fetch(`${base}/api/events?tv=evil`)).status, 404);
  assert.equal((await post("/api/cmd", { tv: "host:evil.example", action: "powerOff" })).status, 404);
  assert.deepEqual(tv.connects, []);
});

test("GET /api/info is 502 when the TV is unreachable", async () => {
  tv.down = true;
  const res = await fetch(`${base}/api/info?tv=${encodeURIComponent(ID)}`);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /unreachable/);
});

test("commands: 200 on success, 400 on bad input, 502 with the TV's error on refusal", async () => {
  assert.equal((await cmd({ action: "alert", arg: "hi" })).status, 200);
  assert.equal((await cmd({ action: "alert", arg: "" })).status, 400);
  assert.equal((await cmd({ action: "nope" })).status, 400);
  tv.answer = () => ({ ok: false, payload: "401 insufficient permissions" });
  const res = await cmd({ action: "volume", arg: 3 });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "401 insufficient permissions");
});

test("forget clears pairing for that TV", async () => {
  assert.equal((await cmd({ action: "forget" })).status, 200);
});

test("serves the page; unknown paths 404", async () => {
  assert.match(await (await fetch(base + "/")).text(), /<title>/);
  assert.equal((await fetch(base + "/nope")).status, 404);
});

test("rejects a foreign Host header (DNS rebinding), including the event stream", async () => {
  assert.equal(await withHost("evil.example:" + port), 403);
  assert.equal(await withHost("evil.example:" + port, `/api/events?tv=${encodeURIComponent(ID)}`), 403);
  assert.equal(await withHost("localhost:" + port), 200);
});

test("CSRF guard: cross-origin and non-JSON POSTs are 403, for commands and scans", async () => {
  const body = { action: "powerOff" };
  assert.equal((await cmd(body, { ...JSONH, origin: "https://evil.example" })).status, 403);
  assert.equal((await cmd(body, { "content-type": "text/plain" })).status, 403);
  assert.equal((await post("/api/scan", {}, { "content-type": "text/plain" })).status, 403);
  assert.equal((await cmd(body, { ...JSONH, origin: base })).status, 200);
});

test("malformed and oversized bodies are 400", async () => {
  assert.equal((await post("/api/cmd", "{not json")).status, 400);
  assert.equal((await cmd({ action: "text", arg: "x".repeat(3000) })).status, 400);
});

// Read SSE "data:" events from a streaming response until `n` arrive or the stream ends.
async function readEvents(res: Response, n: number) {
  const out: any[] = [];
  const reader = res.body!.getReader();
  let buf = "";
  while (out.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) {
      const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
      if (line) out.push(JSON.parse(line.slice(6)));
    }
  }
  return { out, reader };
}

test("GET /api/events streams pushes and ends with offline when the TV drops", async () => {
  const res = await fetch(`${base}/api/events?tv=${encodeURIComponent(ID)}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  await new Promise((r) => setTimeout(r, 20));
  const s = tv.sessions.at(-1)!;
  s.push("ssap://audio/getVolume", { volume: 12, muted: false });
  s.push("ssap://com.webos.applicationManager/getForegroundAppInfo", { appId: "netflix" });
  s.close();
  const { out } = await readEvents(res, 3);
  assert.deepEqual(out.map((e) => [e.kind, e.payload]), [
    ["volume", { volume: 12, muted: false }],
    ["foreground", { appId: "netflix" }],
    ["offline", "connection to the TV closed"],
  ]);
});

test("GET /api/events on an unreachable TV sends offline and ends (EventSource retries)", async () => {
  tv.down = true;
  const res = await fetch(`${base}/api/events?tv=${encodeURIComponent(ID)}`);
  assert.equal(res.status, 200);
  const { out } = await readEvents(res, 1);
  assert.deepEqual(out, [{ kind: "offline", ok: false, payload: "connection failed: unreachable" }]);
});

test("closing the event stream unsubscribes from the TV", async () => {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events?tv=${encodeURIComponent(ID)}`, { signal: ac.signal });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 20));
  const s = tv.sessions.at(-1)!;
  assert.equal(s.subs.size, 3);
  ac.abort();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.subs.size, 0);
});
