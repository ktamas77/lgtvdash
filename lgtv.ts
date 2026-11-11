#!/usr/bin/env node
// Client for LG webOS TVs: SSAP over wss with per-TV certificate pinning, SSDP discovery, Wake-on-LAN.
//   node lgtv.ts --discover                          -> list TVs on the network
//   node lgtv.ts                                     -> system info of the first TV found (pairs on first run)
//   LGTV_HOST=<ip> node lgtv.ts ssap://audio/setVolume '{"volume":10}'
// Pairing pops a prompt on the TV; keys and pinned certificates are kept per TV in .lgtv-state.json.
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createSocket } from "node:dgram";
import type { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";

const STATE = process.env.LGTV_STATE ?? fileURLToPath(new URL(".lgtv-state.json", import.meta.url));

// LGTV_DEBUG=1: connection lifecycle to stderr (stdout stays clean for the MCP protocol).
export const debug = (...a: unknown[]) => process.env.LGTV_DEBUG && console.error(new Date().toISOString(), "[lgtv]", ...a);

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
export type Target = { id: string; host: string };
export type Found = { host: string; uuid?: string; name?: string; model?: string; mac?: string };
// movedTo: an address discovery reported for this TV that hasn't passed the certificate check yet.
export type TvRecord = Found & { cert?: string; key?: string; seenAt?: string; movedTo?: string };
export type State = { version: 2; tvs: Record<string, TvRecord>; lastTv?: string };

// A TV's id: its discovery uuid when known (survives IP changes), else its address.
export const tvIdOf = (t: { uuid?: string; host: string }) => t.uuid ?? `host:${t.host}`;
export const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

// --- State: per-TV pairing key, pinned certificate, and what discovery saw ---
export function loadState(): State {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return { version: 2, tvs: {} };
  }
  return raw?.version === 2 ? { version: 2, tvs: raw.tvs ?? {}, lastTv: raw.lastTv } : migrateV1(raw);
}

export function saveState(update: (s: State) => void) {
  const s = loadState();
  update(s);
  writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
}

// v1 kept keys by IP ({ keys: {ip: key}, tvs: {ip: {id: uuid, ...}} }). Keys stay tied to the IP they were
// paired on until the first wss connection pins that TV's certificate.
export function migrateV1(raw: any): State {
  const keys: Record<string, string> = raw?.keys ?? {};
  const tvs: Record<string, TvRecord> = {};
  for (const t of Object.values<any>(raw?.tvs ?? {})) {
    if (typeof t?.host !== "string") continue;
    tvs[tvIdOf({ uuid: t.id, host: t.host })] = defined({ host: t.host, uuid: t.id, name: t.name, model: t.model, mac: t.mac, key: keys[t.host] });
  }
  for (const [host, key] of Object.entries(keys))
    if (!Object.values(tvs).some((r) => r.host === host)) tvs[`host:${host}`] = { host, key };
  return { version: 2, tvs };
}

// --- Transport ---
export interface Conn extends EventEmitter {
  send(text: string): void;
  close(): void;
}

// Emits "open" (with the TLS certificate's SHA-256 fingerprint), "message" (text), "close", "error".
export const transport = {
  open(url: string): Conn {
    // Chain verification is off on purpose: every webOS TV has its own self-signed certificate.
    // Trust comes from pinning that certificate's fingerprint per TV instead (see connect()).
    const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 8000 });
    const conn = Object.assign(new EventEmitter(), {
      send: (t: string) => ws.send(t),
      close: () => ws.terminate(),
    });
    let cert: string | undefined;
    ws.on("upgrade", (res) => (cert = (res.socket as TLSSocket).getPeerCertificate?.()?.fingerprint256));
    const path = url.replace(/\/resources\/.*/, "/resources/…");
    debug("open", path);
    ws.on("open", () => conn.emit("open", cert));
    ws.on("message", (d) => conn.emit("message", String(d)));
    ws.on("close", (code, reason) => (debug("closed", path, code, String(reason)), conn.emit("close")));
    ws.on("error", (e) => (debug("error", path, e.message), conn.emit("error", e)));
    return conn;
  },
};

export class CertChangedError extends Error {}

const toRes = (uri: string, m: any): Res => ({
  uri,
  ok: m.type !== "error" && m.payload?.returnValue !== false,
  payload: m.type === "error" ? m.error : m.payload,
});

// A registered connection to one TV: requests, subscriptions, and the pointer socket (buttons, mouse).
export class Session {
  target: Target;
  closed = false;
  #conn: Conn;
  #n = 0;
  #pending = new Map<string, (m: any) => void>();
  #subs = new Map<string, (r: Res) => void>();
  #onClose = new Set<() => void>();
  #pointer?: Promise<Conn>;

  constructor(target: Target, conn: Conn) {
    this.target = target;
    this.#conn = conn;
    conn.on("message", (text: string) => {
      let m: any;
      try { m = JSON.parse(text); } catch { return; }
      this.#pending.get(m.id)?.(m) ?? this.#subs.get(m.id)?.(m);
    });
    conn.on("close", () => this.#shutdown());
    conn.on("error", () => this.#shutdown());
  }

  request(uri: string, payload: object = {}, timeoutMs = 10_000): Promise<Res> {
    if (this.closed) return Promise.resolve({ uri, ok: false, payload: "connection closed" });
    const id = `r${++this.#n}`;
    return new Promise((resolve) => {
      const done = (r: Res) => (clearTimeout(timer), this.#pending.delete(id), resolve(r));
      const timer = setTimeout(() => done({ uri, ok: false, payload: "timeout: no answer from the TV" }), timeoutMs);
      this.#pending.set(id, (m) => done(m.type === "closed" ? { uri, ok: false, payload: "connection closed" } : toRes(uri, m)));
      this.#conn.send(JSON.stringify({ type: "request", id, uri, payload }));
    });
  }

  // The TV answers once with the current value, then again on every change. Returns an unsubscribe function.
  subscribe(uri: string, cb: (r: Res) => void): () => void {
    const id = `s${++this.#n}`;
    this.#subs.set(id, (m) => cb(toRes(uri, m)));
    this.#conn.send(JSON.stringify({ type: "subscribe", id, uri, payload: {} }));
    return () => {
      if (this.#subs.delete(id) && !this.closed) this.#conn.send(JSON.stringify({ type: "unsubscribe", id }));
    };
  }

  onClose(cb: () => void) {
    if (this.closed) cb();
    else this.#onClose.add(cb);
  }

  // Raw pointer-socket frame: "type:button\nname:UP\n\n", "type:move\ndx:5\ndy:0\ndown:0\n\n", "type:click\n\n".
  async pointer(frame: string) {
    this.#pointer ??= this.#openPointer().catch((e) => {
      this.#pointer = undefined;
      throw e;
    });
    (await this.#pointer).send(frame);
  }

  async #openPointer(): Promise<Conn> {
    const r = await this.request("ssap://com.webos.service.networkinput/getPointerInputSocket");
    if (!r.ok) throw new Error(`pointer socket: ${r.payload}`);
    const c = transport.open(r.payload.socketPath);
    await new Promise<void>((resolve, reject) => {
      c.once("open", () => resolve());
      c.once("error", () => reject(new Error("pointer socket connection failed")));
    });
    c.on("close", () => (this.#pointer = undefined));
    c.on("error", () => (this.#pointer = undefined));
    return c;
  }

  close() {
    if (!this.closed) debug("session close() by us", this.target.host, new Error().stack?.split("\n")[2]?.trim());
    this.#conn.close();
    this.#shutdown();
  }

  #shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const h of [...this.#pending.values()]) h({ type: "closed" });
    this.#subs.clear();
    this.#pointer?.then((c) => c.close(), () => {});
    for (const cb of this.#onClose) cb();
  }
}

// Open a session. The pairing key is only sent after the TV proves it is the TV that issued it:
// its certificate must match the pinned one; a key with no pinned certificate yet (paired before
// pinning existed) is only sent to the address it was paired on.
export function connect(target: Target, { timeoutMs = 90_000 } = {}): Promise<Session> {
  return new Promise((resolve, reject) => {
    const rec = loadState().tvs[target.id];
    const conn = transport.open(`wss://${target.host}:3001`);
    let cert: string | undefined, done = false;
    const fail = (e: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.close();
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error("timeout: no answer from the TV")), timeoutMs);
    conn.on("error", (e: Error) => fail(new Error(`connection failed: ${e.message || "unreachable"}`)));
    conn.on("close", () => fail(new Error("connection closed by the TV")));
    conn.on("open", (fp?: string) => {
      if (!fp) return fail(new Error("TV presented no TLS certificate"));
      if (rec?.cert && rec.cert !== fp)
        return fail(new CertChangedError(`certificate changed for ${target.id} at ${target.host}: pairing key withheld. Re-pair if the TV was reset or updated.`));
      cert = fp;
      const key = rec?.key && (rec.cert || rec.host === target.host) ? rec.key : undefined;
      conn.send(JSON.stringify({
        type: "register", id: "reg",
        payload: { forcePairing: false, pairingType: "PROMPT", "client-key": key, manifest: { manifestVersion: 1, permissions } },
      }));
    });
    const onMessage = (text: string) => {
      let m: any;
      try { m = JSON.parse(text); } catch { return fail(new Error("unreadable message from the TV")); }
      if (m.id !== "reg") return;
      if (m.type === "error") return fail(new Error(`TV refused pairing: ${m.error}`));
      if (m.type !== "registered") return console.error(`Waiting: accept the pairing prompt on the TV at ${target.host}...`);
      const k = m.payload?.["client-key"];
      if (typeof k !== "string" || !k) return fail(new Error("TV sent no client key"));
      done = true;
      clearTimeout(timer);
      conn.off("message", onMessage);
      saveState((s) => (s.tvs[target.id] = defined({ ...s.tvs[target.id], host: target.host, cert, key: k, movedTo: undefined })));
      resolve(new Session(target, conn));
    };
    conn.on("message", onMessage);
  });
}

// One-shot: connect, send every request, close. Rejects only if the connection or pairing fails.
export async function ask(target: Target, reqs: Req[], timeoutMs = 90_000): Promise<Res[]> {
  const s = await connect(target, { timeoutMs });
  try {
    return await Promise.all(reqs.map(([uri, payload]) => s.request(uri, payload, timeoutMs)));
  } finally {
    s.close();
  }
}

// --- Power on: Wake-on-LAN (needs "Turn on via Wi-Fi/LAN" enabled on the TV) ---
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

// Fold one SSDP answer into the TVs found so far. Only webOS answers create an entry.
export function absorb(found: Map<string, Found & { location?: string }>, macs: Map<string, string>, host: string, text: string) {
  const h = parseSsdp(text);
  if (h.st === SECOND_SCREEN && !found.has(host)) found.set(host, { host, uuid: h.usn?.match(/uuid:([^:]+)/)?.[1], location: h.location });
  const mac = h.wakeup?.match(/MAC=([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i)?.[1];
  if (mac) macs.set(host, mac.toLowerCase());
}

const tag = (xml: string, t: string) => xml.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];

export async function discover(timeoutMs = 3000): Promise<Found[]> {
  const found = new Map<string, Found & { location?: string }>(), macs = new Map<string, string>();
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
    return defined(tv);
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
  const known = Object.entries(loadState().tvs).find(([, r]) => r.host === host)?.[0];
  const [r] = await ask({ id: known ?? `host:${host}`, host }, [[first, JSON.parse(payload)]]).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
  console.log(typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload, null, 2));
  process.exit(r.ok ? 0 : 1);
}
