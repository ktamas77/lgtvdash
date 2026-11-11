// MCP server tests: a real MCP client talks to the server over the SDK's in-memory transport; fake TV.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tv, TV1, TV2, makeRegistry } from "./fake.ts";
const { createMcp } = await import("../mcp.ts");

let client: Client, reg: ReturnType<typeof makeRegistry>;
before(async () => {
  reg = makeRegistry();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcp(reg).connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});
beforeEach(async () => {
  tv.reset();
  tv.found = [TV1];
  await reg.scan();
  tv.calls = [];
});

const call = async (name: string, args: object = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { error: !!r.isError, text: r.content?.[0]?.text as string };
};

test("lists every tool, with read-only and destructive hints", async () => {
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), [
    "launch_app", "list_apps", "list_tvs", "media", "mute", "play_youtube", "power_off", "power_on",
    "press_button", "scan_tvs", "set_volume", "show_alert", "switch_input", "tv_status", "type_text",
  ]);
  assert.equal(byName.tv_status.annotations?.readOnlyHint, true);
  assert.equal(byName.power_off.annotations?.destructiveHint, true);
  assert.equal(byName.set_volume.annotations?.readOnlyHint, false);
});

test("list_tvs and the default TV (the only one)", async () => {
  const { text } = await call("list_tvs");
  assert.deepEqual(JSON.parse(text).map((t: any) => [t.id, t.online]), [["uuid-1", true]]);
  await call("set_volume", { volume: 12 });
  assert.deepEqual(tv.calls, [{ id: "uuid-1", uri: "ssap://audio/setVolume", payload: { volume: 12 } }]);
});

test("with several TVs, an unnamed call is an error until one was used", async () => {
  tv.found = [TV1, TV2];
  await reg.scan();
  const before = await call("set_volume", { volume: 5 });
  assert.equal(before.error, true);
  assert.match(before.text, /Several TVs/);
  assert.equal((await call("set_volume", { tv: "uuid-2", volume: 5 })).error, false);
  await call("mute", { muted: true }); // now defaults to the TV used last
  assert.deepEqual(tv.calls.at(-1), { id: "uuid-2", uri: "ssap://audio/setMute", payload: { mute: true } });
});

test("tv_status summarises power, what's on screen and volume", async () => {
  tv.answer = (uri) => ({
    ok: true,
    payload: uri.endsWith("getPowerState") ? { state: "Active" }
      : uri.endsWith("getForegroundAppInfo") ? { appId: "com.webos.app.hdmi3" }
      : uri.endsWith("getVolume") ? { volume: 20, muted: false }
      : { devices: [{ id: "HDMI_3", label: "HDMI 3", appId: "com.webos.app.hdmi3" }] },
  });
  assert.deepEqual(JSON.parse((await call("tv_status")).text), { tv: TV1.name, power: "Active", showing: "HDMI 3", volume: 20, muted: false });
});

test("launch_app and switch_input match by title/label; ambiguity and misses are errors", async () => {
  tv.answer = (uri) => ({
    ok: true,
    payload: uri.endsWith("listLaunchPoints")
      ? { launchPoints: [{ id: "netflix", title: "Netflix" }, { id: "yt", title: "YouTube" }, { id: "ytk", title: "YouTube Kids" }] }
      : uri.endsWith("getExternalInputList") ? { devices: [{ id: "HDMI_1", label: "HDMI 1" }] } : {},
  });
  assert.equal((await call("launch_app", { app: "netflix" })).text, "Launched Netflix.");
  assert.equal((await call("launch_app", { app: "YouTube" })).text, "Launched YouTube."); // exact title wins over partial
  assert.match((await call("launch_app", { app: "you" })).text, /Several apps match/);
  assert.match((await call("launch_app", { app: "Hulu" })).text, /No app matches/);
  assert.equal((await call("switch_input", { input: "hdmi 1" })).text, "Switched to HDMI 1.");
  assert.match((await call("switch_input", { input: "HDMI 9" })).text, /No input "HDMI 9"/);
  assert.deepEqual(tv.calls.filter((c) => c.uri?.includes("launch") || c.uri?.includes("switchInput")).map((c) => c.payload), [
    { id: "netflix" }, { id: "yt" }, { inputId: "HDMI_1" },
  ]);
});

test("show_alert, play_youtube, type_text with enter", async () => {
  await call("show_alert", { message: "Build finished" });
  await call("play_youtube", { video: "https://youtu.be/dQw4w9WgXcQ" });
  await call("type_text", { text: "cats", enter: true });
  assert.deepEqual(tv.calls.map((c) => c.uri), [
    "ssap://system.notifications/createAlert", "ssap://system.launcher/launch",
    "ssap://com.webos.service.ime/insertText", "ssap://com.webos.service.ime/sendEnterKey",
  ]);
});

test("validation: schema limits and our own checks both come back as tool errors", async () => {
  for (const [name, args] of [
    ["set_volume", { volume: 101 }], ["press_button", { button: "REBOOT" }], ["show_alert", { message: "" }],
  ] as const) {
    const r: any = await client.callTool({ name, arguments: args }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
    assert.equal(r.isError, true, name);
  }
  const yt = await call("play_youtube", { video: "https://evil.example/x" });
  assert.deepEqual(yt, { error: true, text: "Invalid argument." });
  const unknown = await call("power_off", { tv: "nope" });
  assert.match(unknown.text, /Unknown TV "nope"/);
  assert.deepEqual(tv.calls, []);
});

test("TV errors surface as tool errors with the TV's message", async () => {
  tv.answer = () => ({ ok: false, payload: "401 insufficient permissions" });
  assert.deepEqual(await call("set_volume", { volume: 3 }), { error: true, text: "401 insufficient permissions" });
});
