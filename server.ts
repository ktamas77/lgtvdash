// Web dashboard for LG webOS TVs: node --env-file-if-exists=.env server.ts -> http://localhost:8787
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ask, button, wake, discover, loadState, saveState, type Req, type Tv } from "./lgtv.ts";

const set = (category: string, keys: string[]): Req => ["ssap://settings/getSystemSettings", { category, keys }];

// Only endpoints/keys verified to answer on a 2019 LG webOS TV. The rest of the
// picture/sound/time keys return "500 Application error" to third-party clients.
export const QUERIES: Record<string, Req> = {
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
const isId = (v: unknown) => typeof v === "string" && ID.test(v); // ID.test(undefined) tests the string "undefined"

export type ConfigTv = Tv & { broadcast?: string };
export type ListedTv = ConfigTv & { sources: ("config" | "discovered")[]; online: boolean; paired: boolean };

// tvs.json: [{ "host": "192.168.1.20", "name": "Living room", "mac": "aa:bb:cc:dd:ee:ff" }, ...]
export function loadConfig(path: string): ConfigTv[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw new Error(`${path}: ${e.message}`);
  }
  if (!Array.isArray(raw)) throw new Error(`${path}: expected an array of TVs`);
  return raw.map((t: any, i) => {
    if (!isId(t?.host)) throw new Error(`${path}[${i}]: "host" must be an IP or hostname`);
    for (const k of ["name", "mac", "broadcast"]) if (t[k] != null && typeof t[k] !== "string") throw new Error(`${path}[${i}]: "${k}" must be a string`);
    return { host: t.host, name: t.name, mac: t.mac, broadcast: t.broadcast };
  });
}

const json = (res: ServerResponse, status: number, body: unknown) =>
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

// TV access is passed in so tests can run without a TV.
export function app({ tv = { ask, button, wake, discover }, config = [] as ConfigTv[] } = {}) {
  let online = new Set<string>();
  let scanning: Promise<void> | undefined;

  // Discovered TVs are remembered in the state file, so a TV that is off now still shows up (and can be woken).
  const scan = () => (scanning ??= tv.discover()
    .then((found) => {
      online = new Set(found.map((t) => t.host));
      if (found.length) saveState((s) => found.forEach((t) => (s.tvs[t.host] = { ...s.tvs[t.host], ...defined(t) })));
    })
    .finally(() => (scanning = undefined)));

  // Config entries come first and win on conflicts; discovery fills in what config leaves out.
  const list = (): ListedTv[] => {
    const state = loadState();
    const byHost = new Map<string, ListedTv>();
    for (const c of config) byHost.set(c.host, { ...c, sources: ["config"], online: false, paired: false });
    for (const d of Object.values(state.tvs)) {
      const t = byHost.get(d.host);
      if (t) byHost.set(d.host, { ...d, ...defined(t), sources: ["config", "discovered"] });
      else byHost.set(d.host, { ...d, sources: ["discovered"], online: false, paired: false });
    }
    return [...byHost.values()].map((t) => ({ ...t, online: online.has(t.host), paired: !!state.keys[t.host] }));
  };

  const ssap = async (host: string, uri: string, payload?: object) => {
    const [r] = await tv.ask(host, [[uri, payload]], 10_000);
    if (!r.ok) throw new Error(String(r.payload));
  };

  // Allowlisted actions. Each validates its own argument; anything else is a 400.
  const ACTIONS: Record<string, (t: ListedTv, arg: any) => Promise<void>> = {
    volume: async (t, v) => { if (!Number.isInteger(v) || v < 0 || v > 100) throw 400; await ssap(t.host, "ssap://audio/setVolume", { volume: v }); },
    mute: async (t, m) => { if (typeof m !== "boolean") throw 400; await ssap(t.host, "ssap://audio/setMute", { mute: m }); },
    input: async (t, id) => { if (!isId(id)) throw 400; await ssap(t.host, "ssap://tv/switchInput", { inputId: id }); },
    launch: async (t, id) => { if (!isId(id)) throw 400; await ssap(t.host, "ssap://system.launcher/launch", { id }); },
    media: async (t, m) => { if (!MEDIA.has(m)) throw 400; await ssap(t.host, `ssap://media.controls/${m}`); },
    button: async (t, b) => { if (!BUTTONS.has(b)) throw 400; await tv.button(t.host, b); },
    powerOff: (t) => ssap(t.host, "ssap://system/turnOff"),
    powerOn: async (t) => {
      if (!t.mac) throw new Error(`No MAC known for ${t.host}: scan while the TV is on, or add "mac" in tvs.json`);
      await tv.wake(t.mac, t.broadcast ?? process.env.LGTV_BROADCAST);
    },
  };

  // Only TVs from config or discovery are reachable: the API never connects to an arbitrary host.
  const pick = (host: unknown) => {
    const t = typeof host === "string" ? list().find((t) => t.host === host) : undefined;
    if (!t) throw 404;
    return t;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    // DNS-rebinding guard: a foreign page resolving its domain to 127.0.0.1 would send its own Host.
    const port = req.socket.localPort;
    if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.host ?? "")) return res.writeHead(403).end();
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/tvs" && req.method === "GET") return json(res, 200, list());
      if (url.pathname === "/api/scan" && req.method === "POST") {
        await readJson(req);
        await scan();
        return json(res, 200, list());
      }
      if (url.pathname === "/api/info" && req.method === "GET") {
        const t = pick(url.searchParams.get("tv"));
        try {
          const results = await tv.ask(t.host, Object.values(QUERIES), 15_000);
          return json(res, 200, Object.fromEntries(Object.keys(QUERIES).map((n, i) => [n, results[i]])));
        } catch (e: any) {
          return json(res, 502, { error: e.message });
        }
      }
      if (url.pathname === "/api/cmd" && req.method === "POST") {
        const { tv: host, action, arg } = await readJson(req);
        const fn = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
        if (!fn) throw 400;
        const t = pick(host);
        try {
          await fn(t, arg);
        } catch (e: any) {
          if (typeof e === "number") throw e;
          return json(res, 502, { error: e.message });
        }
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/" && req.method === "GET") {
        // Read per request so page edits show up without a restart.
        return res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(new URL("index.html", import.meta.url)));
      }
      res.writeHead(404).end();
    } catch (e: any) {
      if (typeof e !== "number") return json(res, 500, { error: e.message }); // never let a request crash the server
      json(res, e, { error: e === 403 ? "forbidden" : e === 404 ? "unknown TV" : "bad request" });
    }
  };
  return Object.assign(handler, { scan, list });
}

const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PORT = Number(process.env.PORT ?? 8787);
  const handler = app({ config: loadConfig(process.env.LGTV_CONFIG ?? fileURLToPath(new URL("tvs.json", import.meta.url))) });
  createServer(handler).listen(PORT, "127.0.0.1", () => console.log(`http://localhost:${PORT}`));
  handler.scan().then(() => console.log(`TVs: ${handler.list().map((t) => `${t.name ?? "?"} @ ${t.host}`).join(", ") || "none found"}`));
}
