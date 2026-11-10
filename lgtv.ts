#!/usr/bin/env node
// Client for LG webOS TVs: SSAP websocket API, SSDP discovery, Wake-on-LAN. Library + CLI.
//   node lgtv.ts --discover                          -> list TVs on the network
//   node lgtv.ts                                     -> system info of the first TV found (pairs on first run)
//   LGTV_HOST=<ip> node lgtv.ts ssap://audio/setVolume '{"volume":10}'
// Pairing pops a prompt on the TV; granted keys are kept per TV in .lgtv-state.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createSocket } from "node:dgram";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATE = process.env.LGTV_STATE ?? fileURLToPath(new URL(".lgtv-state.json", import.meta.url));
const LEGACY_KEY = join(dirname(STATE), ".lgtv-key"); // single-TV key file from before multi-TV support

// Asked for up front: adding a permission later means a new prompt on the TV.
const permissions = [
  "LAUNCH", "LAUNCH_WEBAPP", "APP_TO_APP", "CLOSE", "TEST_OPEN", "TEST_PROTECTED",
  "CONTROL_AUDIO", "CONTROL_DISPLAY", "CONTROL_POWER", "CONTROL_TV_SCREEN", "CONTROL_TV_STANBY",
  "CONTROL_INPUT_JOYSTICK", "CONTROL_INPUT_MEDIA_PLAYBACK", "CONTROL_INPUT_MEDIA_RECORDING",
  "CONTROL_INPUT_TV", "CONTROL_INPUT_TEXT", "CONTROL_MOUSE_AND_KEYBOARD",
  "READ_APP_STATUS", "READ_INSTALLED_APPS", "READ_RUNNING_APPS", "READ_CURRENT_CHANNEL",
  "READ_TV_CHANNEL_LIST", "READ_INPUT_DEVICE_LIST", "READ_NETWORK_STATE", "READ_POWER_STATE",
  "READ_COUNTRY_INFO", "READ_SETTINGS", "READ_TV_CURRENT_TIME", "WRITE_NOTIFICATION_TOAST",
];

export type Req = [uri: string, payload?: object];
export type Res = { uri: string; ok: boolean; payload: any };
export type Tv = { host: string; name?: string; model?: string; mac?: string; id?: string };
export type State = { keys: Record<string, string>; tvs: Record<string, Tv> };

// Client keys and every TV seen so far (so a TV that is off can still be woken after a restart).
export function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(STATE, "utf8"));
    return { keys: s.keys ?? {}, tvs: s.tvs ?? {} };
  } catch {
    return { keys: {}, tvs: {} };
  }
}
export function saveState(update: (s: State) => void) {
  const s = loadState();
  update(s);
  writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
}

// ponytail: keys are per IP, so a TV that changes IP asks to pair again. Key by discovery id if that bites.
// The legacy single-TV key is only tried before any per-TV key exists, so it is never offered to a second TV.
const keyFor = (host: string) => {
  const { keys } = loadState();
  if (keys[host] || Object.keys(keys).length) return keys[host];
  return existsSync(LEGACY_KEY) ? readFileSync(LEGACY_KEY, "utf8").trim() || undefined : undefined;
};

// One connection: register, send every request, resolve once all have answered.
// Fails only if it never gets registered; after that, unanswered requests come back as ok:false.
// ponytail: connection per call, no subscriptions. Hold the socket open if you need live events.
export function ask(host: string, reqs: Req[], timeoutMs = 90_000): Promise<Res[]> {
  return new Promise((resolve, reject) => {
    const key = keyFor(host);
    const out: Res[] = [];
    let left = reqs.length, registered = false, settled = false;
    const ws = new WebSocket(`ws://${host}:3000`);
    const send = (o: object) => ws.send(JSON.stringify(o));
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (err && !registered) return reject(err);
      reqs.forEach(([uri], i) => (out[i] ??= { uri, ok: false, payload: err?.message ?? "no answer" }));
      resolve(out);
    };
    const timer = setTimeout(() => finish(new Error("timeout: no answer from the TV")), timeoutMs);

    ws.onerror = (e: any) => finish(new Error(`websocket error: ${e.message || "connection failed"}`));
    ws.onclose = () => finish(new Error("connection closed by the TV"));
    ws.onopen = () => send({
      type: "register", id: "reg",
      payload: { forcePairing: false, pairingType: "PROMPT", "client-key": key, manifest: { manifestVersion: 1, permissions } },
    });
    ws.onmessage = ({ data }) => { try { onMessage(JSON.parse(data)); } catch (e: any) { finish(e); } };
    const onMessage = (m: any) => {
      if (m.type === "registered") {
        const k = m.payload?.["client-key"];
        if (typeof k !== "string" || !k) return finish(new Error("TV sent no client key"));
        registered = true;
        if (k !== loadState().keys[host]) saveState((s) => (s.keys[host] = k));
        if (!left) return finish();
        return reqs.forEach(([uri, payload = {}], i) => send({ type: "request", id: String(i), uri, payload }));
      }
      if (m.id === "reg") {
        if (m.type === "error") return finish(new Error(`TV refused pairing: ${m.error}`));
        return console.error(`Waiting: accept the pairing prompt on the TV at ${host}...`);
      }
      const i = Number(m.id);
      if (!reqs[i] || out[i]) return;
      const failed = m.type === "error" || m.payload?.returnValue === false;
      out[i] = { uri: reqs[i][0], ok: !failed, payload: m.type === "error" ? m.error : m.payload };
      if (--left === 0) finish();
    };
  });
}

// Remote-control button press via the TV's pointer socket (UP, DOWN, LEFT, RIGHT, ENTER, BACK, HOME, ...).
// ponytail: fresh socket per press (~2 round trips). Keep it open if you need fast key repeat.
export async function button(host: string, name: string): Promise<void> {
  const [r] = await ask(host, [["ssap://com.webos.service.networkinput/getPointerInputSocket"]], 10_000);
  if (!r.ok) throw new Error(`pointer socket: ${r.payload}`);
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(r.payload.socketPath);
    ws.onerror = () => reject(new Error("pointer socket connection failed"));
    ws.onopen = () => {
      ws.send(`type:button\nname:${name}\n\n`);
      setTimeout(() => (ws.close(), resolve()), 100); // let the frame flush before closing
    };
  });
}

// Power on: Wake-on-LAN magic packet (needs "Turn on via Wi-Fi/LAN" enabled on the TV).
export function magicPacket(mac: string): Buffer {
  const hex = mac.replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 12) throw new Error("MAC must look like aa:bb:cc:dd:ee:ff");
  return Buffer.from("ff".repeat(6) + hex.repeat(16), "hex");
}

export async function wake(mac: string, broadcast = "255.255.255.255"): Promise<void> {
  const packet = magicPacket(mac);
  const sock = createSocket("udp4");
  await new Promise<void>((resolve, reject) => sock.bind(() => {
    sock.setBroadcast(true);
    sock.send(packet, 9, broadcast, (e) => (sock.close(), e ? reject(e) : resolve()));
  }));
}

// --- Discovery (SSDP) ---
// webos-second-screen answers identify webOS TVs (uuid + description URL with the friendly name);
// DIAL answers from the same TV carry "WAKEUP: MAC=..;Timeout=.." with the Wake-on-LAN MAC.
const SECOND_SCREEN = "urn:lge-com:service:webos-second-screen:1";
const DIAL = "urn:dial-multiscreen-org:service:dial:1";

export function parseSsdp(text: string): Record<string, string> {
  const h: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return h;
}

// Fold one SSDP answer into the map of TVs found so far. Only webOS answers create an entry.
export function absorb(found: Map<string, Tv & { location?: string }>, macs: Map<string, string>, host: string, text: string) {
  const h = parseSsdp(text);
  if (h.st === SECOND_SCREEN && !found.has(host)) found.set(host, { host, id: h.usn?.match(/uuid:([^:]+)/)?.[1], location: h.location });
  const mac = h.wakeup?.match(/MAC=([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i)?.[1];
  if (mac) macs.set(host, mac.toLowerCase());
}

const tag = (xml: string, t: string) => xml.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];

export async function discover(timeoutMs = 3000): Promise<Tv[]> {
  const found = new Map<string, Tv & { location?: string }>(), macs = new Map<string, string>();
  const sock = createSocket("udp4");
  sock.on("message", (buf, rinfo) => absorb(found, macs, rinfo.address, buf.toString()));
  await new Promise<void>((r) => sock.bind(r));
  const search = () => [SECOND_SCREEN, DIAL].forEach((st) =>
    sock.send(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`, 1900, "239.255.255.250"));
  // UDP can drop: search again a second later (measured ~1 miss in 10 single-shot scans).
  search();
  const again = setTimeout(search, Math.min(1000, timeoutMs / 2));
  await new Promise((r) => setTimeout(r, timeoutMs));
  clearTimeout(again);
  sock.close();

  return Promise.all([...found.values()].map(async ({ location, ...tv }) => {
    tv.mac = macs.get(tv.host);
    try {
      // Only follow a description URL that points back at the TV that answered.
      if (location && new URL(location).hostname === tv.host) {
        const xml = await (await fetch(location, { signal: AbortSignal.timeout(2000) })).text();
        tv.name = tag(xml, "friendlyName");
        tv.model = tag(xml, "modelNumber");
      }
    } catch {} // name is cosmetic; the TV is still usable without it
    return tv;
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [first = "ssap://system/getSystemInfo", payload = "{}"] = process.argv.slice(2);
  if (first === "--discover") {
    console.log(JSON.stringify(await discover(), null, 2));
    process.exit(0);
  }
  const host = process.env.LGTV_HOST ?? (await discover())[0]?.host;
  if (!host) {
    console.error("No TV found. Set LGTV_HOST=<ip> or check the TV is on and on this network.");
    process.exit(1);
  }
  const [r] = await ask(host, [[first, JSON.parse(payload)]]).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
  console.log(typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload, null, 2));
  process.exit(r.ok ? 0 : 1);
}
