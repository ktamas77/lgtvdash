#!/usr/bin/env node
// Client for the LG webOS TV's SSAP websocket API. Library (ask) + CLI.
//   node --env-file=.env lgtv.ts                   -> system info (pairs on first run)
//   node --env-file=.env lgtv.ts ssap://audio/setVolume '{"volume":10}'
// First run pops a pairing prompt on the TV; the granted client key lands in .lgtv-key.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HOST = process.env.LGTV_HOST;
if (!HOST) throw new Error("Set LGTV_HOST to the TV's IP (e.g. in .env, see README)");
const KEYFILE = new URL(".lgtv-key", import.meta.url);

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

// One connection: register, send every request, resolve once all have answered.
// Fails only if it never gets registered; after that, unanswered requests come back as ok:false.
// ponytail: connection per call, no subscriptions. Hold the socket open if you need live events.
export function ask(reqs: Req[], timeoutMs = 90_000): Promise<Res[]> {
  return new Promise((resolve, reject) => {
    const key = existsSync(KEYFILE) ? readFileSync(KEYFILE, "utf8").trim() : undefined;
    const out: Res[] = [];
    let left = reqs.length, registered = false, settled = false;
    const ws = new WebSocket(`ws://${HOST}:3000`);
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
        writeFileSync(KEYFILE, k, { mode: 0o600 });
        if (!left) return finish();
        return reqs.forEach(([uri, payload = {}], i) => send({ type: "request", id: String(i), uri, payload }));
      }
      if (m.id === "reg") {
        if (m.type === "error") return finish(new Error(`TV refused pairing: ${m.error}`));
        return console.error("Waiting: accept the pairing prompt on the TV...");
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
export async function button(name: string): Promise<void> {
  const [r] = await ask([["ssap://com.webos.service.networkinput/getPointerInputSocket"]], 10_000);
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
export async function wake(mac: string, broadcast = "255.255.255.255"): Promise<void> {
  const hex = mac.replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 12) throw new Error("LGTV_MAC must be a MAC address like aa:bb:cc:dd:ee:ff");
  const packet = Buffer.from("ff".repeat(6) + hex.repeat(16), "hex");
  const { createSocket } = await import("node:dgram");
  const sock = createSocket("udp4");
  await new Promise<void>((resolve, reject) => sock.bind(() => {
    sock.setBroadcast(true);
    sock.send(packet, 9, broadcast, (e) => (sock.close(), e ? reject(e) : resolve()));
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [uri = "ssap://system/getSystemInfo", payload = "{}"] = process.argv.slice(2);
  const [r] = await ask([[uri, JSON.parse(payload)]]).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
  console.log(typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload, null, 2));
  process.exit(r.ok ? 0 : 1);
}
