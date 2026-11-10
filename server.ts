// Web dashboard for the TV: node --env-file=.env server.ts -> http://localhost:8787
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { ask, button, wake, type Req } from "./lgtv.ts";

const PORT = Number(process.env.PORT ?? 8787);
const set = (category: string, keys: string[]): Req => ["ssap://settings/getSystemSettings", { category, keys }];

// Only endpoints/keys verified to answer on a 2019 LG webOS TV. The rest of the
// picture/sound/time keys return "500 Application error" to third-party clients.
const QUERIES: Record<string, Req> = {
  system: ["ssap://system/getSystemInfo"],
  power: ["ssap://com.webos.service.tvpower/power/getPowerState"],
  volume: ["ssap://audio/getVolume"],
  soundOutput: ["ssap://com.webos.service.apiadapter/audio/getSoundOutput"],
  foreground: ["ssap://com.webos.applicationManager/getForegroundAppInfo"],
  time: ["ssap://com.webos.service.tv.time/getCurrentTime"],
  network: ["ssap://com.webos.service.connectionmanager/getinfo"],
  inputs: ["ssap://tv/getExternalInputList"],
  apps: ["ssap://com.webos.applicationManager/listLaunchPoints"],
  services: ["ssap://api/getServiceList"],
  config: ["ssap://config/getConfigs", { configNames: ["tv.model.*"] }],
  backlight: set("picture", ["backlight"]),
  contrast: set("picture", ["contrast"]),
  brightness: set("picture", ["brightness"]),
  color: set("picture", ["color"]),
  country: set("option", ["country"]),
  audioGuidance: set("option", ["audioGuidance"]),
  netSettings: set("network", ["deviceName", "wolwowlOnOff"]),
  simplink: set("other", ["simplinkEnable"]),
};

const BUTTONS = new Set(["UP", "DOWN", "LEFT", "RIGHT", "ENTER", "BACK", "HOME", "EXIT", "MENU", "INFO"]);
const MEDIA = new Set(["play", "pause", "stop", "rewind", "fastForward"]);
const ID = /^[\w.-]{1,128}$/;

const ssap = async (uri: string, payload?: object) => {
  const [r] = await ask([[uri, payload]], 10_000);
  if (!r.ok) throw new Error(String(r.payload));
};

// Allowlisted actions. Each validates its own argument; anything else is a 400.
const ACTIONS: Record<string, (arg: any) => Promise<void> | void> = {
  volume: (v) => { if (!Number.isInteger(v) || v < 0 || v > 100) throw 400; return ssap("ssap://audio/setVolume", { volume: v }); },
  mute: (m) => { if (typeof m !== "boolean") throw 400; return ssap("ssap://audio/setMute", { mute: m }); },
  input: (id) => { if (!ID.test(id)) throw 400; return ssap("ssap://tv/switchInput", { inputId: id }); },
  launch: (id) => { if (!ID.test(id)) throw 400; return ssap("ssap://system.launcher/launch", { id }); },
  media: (m) => { if (!MEDIA.has(m)) throw 400; return ssap(`ssap://media.controls/${m}`); },
  button: (b) => { if (!BUTTONS.has(b)) throw 400; return button(b); },
  powerOff: () => ssap("ssap://system/turnOff"),
  powerOn: () => {
    if (!process.env.LGTV_MAC) throw new Error("Set LGTV_MAC in .env to power on via Wake-on-LAN");
    return wake(process.env.LGTV_MAC, process.env.LGTV_BROADCAST);
  },
};

const json = (res: ServerResponse, status: number, body: object) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

// CSRF guard: other sites can't send JSON without a CORS preflight, and browsers always send Origin on POST.
async function readJson(req: IncomingMessage): Promise<any> {
  const origin = req.headers.origin;
  if ((origin && origin !== `http://${req.headers.host}`) || !req.headers["content-type"]?.startsWith("application/json")) throw 403;
  let body = "";
  try {
    for await (const chunk of req) if ((body += chunk).length > 1024) throw 0;
    return JSON.parse(body || "{}");
  } catch {
    throw 400;
  }
}

createServer(async (req, res) => {
  // DNS-rebinding guard: a foreign page resolving its domain to 127.0.0.1 would send its own Host.
  if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(req.headers.host ?? "")) return res.writeHead(403).end();
  if (req.url === "/api/info") {
    try {
      const names = Object.keys(QUERIES);
      const results = await ask(Object.values(QUERIES), 15_000);
      return json(res, 200, Object.fromEntries(names.map((n, i) => [n, results[i]])));
    } catch (e: any) {
      return json(res, 502, { error: e.message });
    }
  }
  if (req.url === "/api/cmd" && req.method === "POST") {
    try {
      const { action, arg } = await readJson(req);
      const fn = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
      if (!fn) throw 400;
      await fn(arg);
      return json(res, 200, { ok: true });
    } catch (e: any) {
      if (typeof e === "number") return json(res, e, { error: e === 403 ? "forbidden" : "bad request" });
      return json(res, 502, { error: e.message });
    }
  }
  if (req.url === "/") {
    // Read per request so page edits show up without a restart.
    return res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(new URL("index.html", import.meta.url)));
  }
  res.writeHead(404).end();
}).listen(PORT, "127.0.0.1", () => console.log(`http://localhost:${PORT}`));
