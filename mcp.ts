#!/usr/bin/env node
// MCP server: control LG webOS TVs from Claude (or any MCP client) over stdio.
//   claude mcp add lgtv --scope user -- node /path/to/mcp.ts
// Shares TVs, keys and pinned certificates with the dashboard (tvs.json, .lgtv-state.json).
// stdout carries the protocol only; anything human-readable goes to stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { registry, loadConfig, type Registry, type ListedTv } from "./tvs.ts";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ ...text(msg), isError: true });
const tvArg = { tv: z.string().optional().describe("TV id from list_tvs. Optional: defaults to the TV used last, or the only one.") };
const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export function createMcp(tvs: Registry) {
  const server = new McpServer({ name: "lgtv", version: "1.0.0" });

  // Resolve the TV, run, and turn validation (400) and TV errors into readable tool errors.
  const on = <A extends { tv?: string }>(fn: (t: ListedTv, a: A) => Promise<unknown>) => async (a: A) => {
    try {
      const t = tvs.resolve(a.tv);
      return text((await fn(t, a)) ?? `Done on ${t.name ?? t.host}.`);
    } catch (e: any) {
      if (e === 400) return fail("Invalid argument.");
      if (e === 404) return fail(`Unknown TV "${a.tv}". Use list_tvs.`);
      return fail(e?.message ?? String(e));
    }
  };
  const request = async (t: ListedTv, uri: string, payload?: object) => {
    const r = await tvs.request(t, uri, payload);
    if (!r.ok) throw new Error(String(r.payload));
    return r.payload;
  };

  server.registerTool("list_tvs", {
    title: "List TVs",
    description: "LG webOS TVs known from tvs.json and network discovery, with id, name, IP, and whether each is on the network and paired.",
    annotations: READ,
  }, async () => text(tvs.list().map(({ id, name, host, model, online, paired }) => ({ id, name, host, model, online, paired }))));

  server.registerTool("scan_tvs", {
    title: "Scan for TVs",
    description: "Search the local network for LG webOS TVs (about 3 seconds), then list them.",
    annotations: READ,
  }, async () => {
    await tvs.scan();
    return text(tvs.list().map(({ id, name, host, online }) => ({ id, name, host, online })));
  });

  server.registerTool("tv_status", {
    title: "TV status",
    description: "What the TV is doing: power state, the app or input on screen, volume and mute.",
    inputSchema: tvArg,
    annotations: READ,
  }, on(async (t) => {
    const [power, fg, vol, inputs] = await Promise.all([
      request(t, "ssap://com.webos.service.tvpower/power/getPowerState"),
      request(t, "ssap://com.webos.applicationManager/getForegroundAppInfo"),
      request(t, "ssap://audio/getVolume"),
      request(t, "ssap://tv/getExternalInputList"),
    ]);
    const input = inputs.devices?.find((d: any) => d.appId === fg.appId);
    return { tv: t.name ?? t.host, power: power.state, showing: input ? input.label : fg.appId, volume: vol.volume, muted: vol.muted };
  }));

  server.registerTool("list_apps", {
    title: "List apps",
    description: "Apps installed on the TV (id and title).",
    inputSchema: tvArg,
    annotations: READ,
  }, on(async (t) => (await request(t, "ssap://com.webos.applicationManager/listLaunchPoints")).launchPoints.map((a: any) => ({ id: a.id, title: a.title }))));

  server.registerTool("launch_app", {
    title: "Launch app",
    description: "Open an app on the TV by id or by (part of) its title, e.g. 'Netflix'.",
    inputSchema: { ...tvArg, app: z.string().min(1).max(128) },
    annotations: WRITE,
  }, on(async (t, a: { app: string }) => {
    const apps = (await request(t, "ssap://com.webos.applicationManager/listLaunchPoints")).launchPoints as any[];
    const q = a.app.toLowerCase();
    const exact = apps.find((x) => x.id === a.app || x.title.toLowerCase() === q);
    const matches = exact ? [exact] : apps.filter((x) => x.title.toLowerCase().includes(q));
    if (matches.length !== 1)
      throw new Error(matches.length ? `Several apps match: ${matches.map((x) => x.title).join(", ")}` : `No app matches "${a.app}". Use list_apps.`);
    await tvs.run(t, "launch", matches[0].id);
    return `Launched ${matches[0].title}.`;
  }));

  server.registerTool("switch_input", {
    title: "Switch input",
    description: "Switch to an input by id or label, e.g. 'HDMI_1' or 'HDMI 1'.",
    inputSchema: { ...tvArg, input: z.string().min(1).max(64) },
    annotations: WRITE,
  }, on(async (t, a: { input: string }) => {
    const devices = (await request(t, "ssap://tv/getExternalInputList")).devices as any[];
    const norm = (s: string) => s.toLowerCase().replace(/[\s_]/g, "");
    const d = devices.find((x) => norm(x.id) === norm(a.input) || norm(x.label) === norm(a.input));
    if (!d) throw new Error(`No input "${a.input}". Inputs: ${devices.map((x) => x.label).join(", ")}`);
    await tvs.run(t, "input", d.id);
    return `Switched to ${d.label}.`;
  }));

  server.registerTool("set_volume", {
    title: "Set volume",
    description: "Set the TV volume (0-100).",
    inputSchema: { ...tvArg, volume: z.number().int().min(0).max(100) },
    annotations: WRITE,
  }, on((t, a: { volume: number }) => tvs.run(t, "volume", a.volume).then(() => `Volume set to ${a.volume}.`)));

  server.registerTool("mute", {
    title: "Mute",
    description: "Mute or unmute the TV.",
    inputSchema: { ...tvArg, muted: z.boolean() },
    annotations: WRITE,
  }, on((t, a: { muted: boolean }) => tvs.run(t, "mute", a.muted).then(() => (a.muted ? "Muted." : "Unmuted."))));

  server.registerTool("press_button", {
    title: "Press remote button",
    description: "Press a remote-control button.",
    inputSchema: { ...tvArg, button: z.enum(["UP", "DOWN", "LEFT", "RIGHT", "ENTER", "BACK", "HOME", "EXIT", "MENU", "INFO"]) },
    annotations: WRITE,
  }, on((t, a: { button: string }) => tvs.run(t, "button", a.button)));

  server.registerTool("media", {
    title: "Media control",
    description: "Play, pause, stop, rewind or fast-forward in the app on screen.",
    inputSchema: { ...tvArg, action: z.enum(["play", "pause", "stop", "rewind", "fastForward"]) },
    annotations: WRITE,
  }, on((t, a: { action: string }) => tvs.run(t, "media", a.action)));

  server.registerTool("power_on", {
    title: "Power on",
    description: "Turn the TV on with Wake-on-LAN.",
    inputSchema: tvArg,
    annotations: WRITE,
  }, on((t) => tvs.run(t, "powerOn", undefined).then(() => "Wake-on-LAN sent; the TV takes a few seconds to come up.")));

  server.registerTool("power_off", {
    title: "Power off",
    description: "Turn the TV off.",
    inputSchema: tvArg,
    annotations: { ...WRITE, destructiveHint: true },
  }, on((t) => tvs.run(t, "powerOff", undefined).then(() => "Turned off.")));

  server.registerTool("show_alert", {
    title: "Show message on TV",
    description: "Show a pop-up message with an OK button on the TV screen.",
    inputSchema: { ...tvArg, message: z.string().min(1).max(200) },
    annotations: WRITE,
  }, on((t, a: { message: string }) => tvs.run(t, "alert", a.message).then(() => "Shown on the TV.")));

  server.registerTool("play_youtube", {
    title: "Play YouTube video",
    description: "Play a YouTube video on the TV, from a YouTube link or an 11-character video id.",
    inputSchema: { ...tvArg, video: z.string().min(1).max(300) },
    annotations: WRITE,
  }, on((t, a: { video: string }) => tvs.run(t, "youtube", a.video).then(() => "Playing on the TV.")));

  server.registerTool("type_text", {
    title: "Type text",
    description: "Type text into the text field that has focus on the TV (e.g. a search box), optionally pressing Enter.",
    inputSchema: { ...tvArg, text: z.string().min(1).max(500), enter: z.boolean().optional() },
    annotations: WRITE,
  }, on(async (t, a: { text: string; enter?: boolean }) => {
    await tvs.run(t, "text", a.text);
    if (a.enter) await tvs.run(t, "key", "enter");
    return "Typed.";
  }));

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tvs = registry({ config: loadConfig(process.env.LGTV_CONFIG ?? fileURLToPath(new URL("tvs.json", import.meta.url))) });
  await createMcp(tvs).connect(new StdioServerTransport());
  tvs.scan().catch(() => {}); // background: online flags, and follows a TV that changed IP
  // Sessions keep the process alive; close them when the client disconnects.
  process.stdin.on("close", () => process.exit(0));
}
