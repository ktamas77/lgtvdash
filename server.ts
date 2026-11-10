// Web dashboard for the TV: node --env-file=.env server.ts -> http://localhost:8787
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { ask, type Req } from "./lgtv.ts";

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

createServer(async (req, res) => {
  // DNS-rebinding guard: a foreign page resolving its domain to 127.0.0.1 would send its own Host.
  if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(req.headers.host ?? "")) return res.writeHead(403).end();
  if (req.url === "/api/info") {
    try {
      const names = Object.keys(QUERIES);
      const results = await ask(Object.values(QUERIES), 15_000);
      const body = Object.fromEntries(names.map((n, i) => [n, results[i]]));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    } catch (e: any) {
      res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url === "/api/volume" && req.method === "POST") {
    // CSRF guard: other sites can't send JSON without a CORS preflight, and browsers always send Origin on POST.
    const origin = req.headers.origin;
    if ((origin && origin !== `http://${req.headers.host}`) || !req.headers["content-type"]?.startsWith("application/json"))
      return res.writeHead(403).end();
    let body = "", volume: any, muted: any;
    try {
      for await (const chunk of req) if ((body += chunk).length > 1024) throw new Error("too large");
      ({ volume, muted } = JSON.parse(body || "{}"));
    } catch {
      return res.writeHead(400).end("bad request body");
    }
    const reqs: Req[] = [];
    if (Number.isInteger(volume) && volume >= 0 && volume <= 100) reqs.push(["ssap://audio/setVolume", { volume }]);
    if (typeof muted === "boolean") reqs.push(["ssap://audio/setMute", { mute: muted }]);
    if (!reqs.length) return res.writeHead(400).end("expected {volume: 0-100} and/or {muted: boolean}");
    try {
      const out = await ask(reqs, 10_000);
      const bad = out.find((r) => !r.ok);
      res.writeHead(bad ? 502 : 200, { "content-type": "application/json" }).end(JSON.stringify(bad ?? { ok: true }));
    } catch (e: any) {
      res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url === "/") {
    // Read per request so page edits show up without a restart.
    res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(new URL("index.html", import.meta.url)));
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, "127.0.0.1", () => console.log(`http://localhost:${PORT}`));
