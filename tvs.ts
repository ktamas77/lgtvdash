// TV registry shared by the web server and the MCP server: which TVs exist (tvs.json + discovery),
// one cached session per TV, the readable state, and every control action with its validation.
import { readFileSync } from "node:fs";
import {
  connect, discover, wake, loadState, saveState, tvIdOf, defined, debug, CertChangedError,
  type Found, type Req, type Res, type Session, type State,
} from "./lgtv.ts";

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

// Pushed by the TV on change (verified on webOS 4.x): used for live updates.
export const LIVE: Record<string, string> = {
  volume: "ssap://audio/getVolume",
  foreground: "ssap://com.webos.applicationManager/getForegroundAppInfo",
  power: "ssap://com.webos.service.tvpower/power/getPowerState",
};

export type ConfigTv = { host: string; name?: string; mac?: string; broadcast?: string; uuid?: string };
export type ListedTv = {
  id: string; host: string; name?: string; model?: string; mac?: string; broadcast?: string; uuid?: string;
  sources: ("config" | "discovered")[]; online: boolean; paired: boolean; certPinned: boolean; certChanged: boolean;
};
export type LiveEvent = { kind: string; ok: boolean; payload: any };

const HOST = /^[\w.-]{1,128}$/;
const ID = /^[\w.-]{1,128}$/;
const isId = (v: unknown) => typeof v === "string" && ID.test(v); // ID.test(undefined) tests the string "undefined"
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const isInt = (v: unknown, max: number): v is number => Number.isInteger(v) && Math.abs(v as number) <= max;

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
    if (typeof t?.host !== "string" || !HOST.test(t.host)) throw new Error(`${path}[${i}]: "host" must be an IP or hostname`);
    for (const k of ["name", "mac", "broadcast", "uuid"]) if (t[k] != null && typeof t[k] !== "string") throw new Error(`${path}[${i}]: "${k}" must be a string`);
    return { host: t.host, name: t.name, mac: t.mac, broadcast: t.broadcast, uuid: t.uuid };
  });
}

// Fold one discovery result into the state. SSDP answers are unauthenticated, so they never move a TV
// that has ever been paired (locked) or has a pinned certificate: a new IP is only recorded as `movedTo`,
// and the TV's address (and name, MAC, ...) changes only after that IP presents the pinned certificate
// (registry.session()). A spoofer can't, so it can't redirect the TV or steer a re-pair; a TV that was
// re-paired (no certificate now, still locked) re-pairs at its verified address only.
// A TV that was never paired just follows discovery: there is nothing to protect yet.
export function absorbFound(s: State, f: Found, now = new Date().toISOString()) {
  const id = tvIdOf(f);
  let rec = s.tvs[id];
  const byHost = `host:${f.host}`;
  if (f.uuid && !rec && s.tvs[byHost]) {
    rec = s.tvs[byHost]; // paired before discovery knew its uuid: same address, same TV
    delete s.tvs[byHost];
  }
  if (rec && rec.host !== f.host && (rec.cert || rec.locked || rec.key)) {
    s.tvs[id] = { ...rec, seenAt: now, movedTo: f.host };
    return;
  }
  s.tvs[id] = defined({ ...rec, ...defined(f), seenAt: now, movedTo: undefined });
}

// YouTube URL (watch, youtu.be, shorts, live, embed; www/m/music hosts) or a bare 11-char id -> video id.
export function parseYouTube(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 300) return;
  const s = v.trim();
  const VID = /^[\w-]{11}$/;
  if (VID.test(s)) return s;
  let u: URL;
  try { u = new URL(s); } catch { return; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return;
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  const id = host === "youtu.be" ? u.pathname.split("/")[1]
    : host === "youtube.com" ? u.searchParams.get("v") ?? u.pathname.match(/^\/(?:shorts|live|embed)\/([^/?]+)/)?.[1]
    : undefined;
  return id && VID.test(id) ? id : undefined;
}

type Ctx = {
  tv: ListedTv;
  req: (uri: string, payload?: object) => Promise<any>;
  pointer: (frame: string) => Promise<void>;
  wake: (mac: string, broadcast?: string) => Promise<void>;
};
const BUTTONS = new Set(["UP", "DOWN", "LEFT", "RIGHT", "ENTER", "BACK", "HOME", "EXIT", "MENU", "INFO"]);
const MEDIA = new Set(["play", "pause", "stop", "rewind", "fastForward"]);

// Allowlisted actions. Each validates its own argument and throws 400 on bad input, before touching the TV.
export const ACTIONS: Record<string, (c: Ctx, arg: any) => Promise<unknown>> = {
  volume: async (c, v) => { if (!isInt(v, 100) || v < 0) throw 400; return c.req("ssap://audio/setVolume", { volume: v }); },
  mute: async (c, m) => { if (typeof m !== "boolean") throw 400; return c.req("ssap://audio/setMute", { mute: m }); },
  input: async (c, id) => { if (!isId(id)) throw 400; return c.req("ssap://tv/switchInput", { inputId: id }); },
  launch: async (c, id) => { if (!isId(id)) throw 400; return c.req("ssap://system.launcher/launch", { id }); },
  media: async (c, m) => { if (!MEDIA.has(m)) throw 400; return c.req(`ssap://media.controls/${m}`); },
  button: async (c, b) => { if (!BUTTONS.has(b)) throw 400; return c.pointer(`type:button\nname:${b}\n\n`); },
  powerOff: (c) => c.req("ssap://system/turnOff"),
  powerOn: async (c) => {
    if (!c.tv.mac) throw new Error(`No MAC known for ${c.tv.name ?? c.tv.host}: scan while the TV is on, or add "mac" in tvs.json`);
    return c.wake(c.tv.mac, c.tv.broadcast ?? process.env.LGTV_BROADCAST);
  },
  // A plain alert with an OK button. Deliberately no onClick/onclose handlers: those can call internal services.
  alert: async (c, msg) => {
    if (!isStr(msg, 200)) throw 400;
    return c.req("ssap://system.notifications/createAlert", { message: msg.trim(), buttons: [{ label: "OK", focus: true }] });
  },
  youtube: async (c, url) => {
    const v = parseYouTube(url);
    if (!v) throw 400;
    return c.req("ssap://system.launcher/launch", { id: "youtube.leanback.v4", contentTarget: `https://www.youtube.com/tv?v=${v}` });
  },
  // Typing goes into whichever text field has focus on the TV.
  text: async (c, t) => { if (!isStr(t, 500)) throw 400; return c.req("ssap://com.webos.service.ime/insertText", { text: t, replace: false }); },
  key: async (c, k) => {
    if (k === "enter") return c.req("ssap://com.webos.service.ime/sendEnterKey");
    if (k === "backspace") return c.req("ssap://com.webos.service.ime/deleteCharacters", { count: 1 });
    throw 400;
  },
  pointer: async (c, a) => {
    if (!isInt(a?.dx, 500) || !isInt(a?.dy, 500)) throw 400;
    return c.pointer(`type:move\ndx:${a.dx}\ndy:${a.dy}\ndown:0\n\n`);
  },
  click: (c) => c.pointer("type:click\n\n"),
  scroll: async (c, a) => { if (!isInt(a?.dy, 500)) throw 400; return c.pointer(`type:scroll\ndx:0\ndy:${a.dy}\n\n`); },
};

export type Deps = { connect: typeof connect; discover: typeof discover; wake: typeof wake };

// TV access is passed in so tests can run without a TV.
export function registry({ deps = { connect, discover, wake } as Deps, config = [] as ConfigTv[] } = {}) {
  let online = new Set<string>();
  const certChanged = new Set<string>();
  const sessions = new Map<string, Promise<Session>>();
  let scanning: Promise<void> | undefined;

  const scan = () => (scanning ??= deps.discover()
    .then((found) => {
      online = new Set(found.map(tvIdOf));
      if (found.length) saveState((s) => found.forEach((f) => absorbFound(s, f)));
    })
    .finally(() => (scanning = undefined)));

  // Config entries match a known TV by uuid (then discovery keeps its IP current) or by host.
  // Config values win; discovery fills in the rest. TVs only paired via the CLI are not listed.
  const list = (): ListedTv[] => {
    const state = loadState();
    const out = new Map<string, ListedTv>();
    const entry = (id: string, c?: ConfigTv): ListedTv => {
      const r = state.tvs[id];
      const host = (c?.uuid && r?.host) || c?.host || r!.host;
      return {
        ...defined({ name: r?.name, model: r?.model, mac: r?.mac, uuid: r?.uuid }), ...defined(c ?? {}), id, host,
        sources: [...(c ? ["config" as const] : []), ...(r?.seenAt ? ["discovered" as const] : [])],
        online: online.has(id), paired: !!r?.key, certPinned: !!r?.cert, certChanged: certChanged.has(id),
      };
    };
    for (const c of config) {
      const id = (c.uuid && (state.tvs[c.uuid] ? c.uuid : undefined))
        ?? Object.entries(state.tvs).find(([, r]) => r.host === c.host)?.[0]
        ?? c.uuid ?? `host:${c.host}`;
      out.set(id, entry(id, c));
    }
    for (const [id, r] of Object.entries(state.tvs)) if (!out.has(id) && r.seenAt) out.set(id, entry(id));
    return [...out.values()];
  };

  const pick = (id: unknown): ListedTv => {
    const t = typeof id === "string" ? list().find((t) => t.id === id) : undefined;
    if (!t) throw 404;
    return t;
  };

  // Default TV for callers that don't name one (MCP): the one used last, else the only (or only online) one.
  const resolve = (id?: string): ListedTv => {
    if (id) return pick(id);
    const all = list();
    const last = all.find((t) => t.id === loadState().lastTv);
    const only = all.length === 1 ? all[0] : all.filter((t) => t.online).length === 1 ? all.find((t) => t.online) : undefined;
    if (last ?? only) return (last ?? only)!;
    throw new Error(all.length ? `Several TVs: name one of ${all.map((t) => t.id).join(", ")}` : "No TVs known yet: scan with the TV on");
  };

  // Connect at the TV's verified address. If that fails and discovery reported a new address (movedTo),
  // try there: connect() only proceeds if the TV presents the pinned certificate, and then saves the new
  // address. A different certificate there means a spoofer (or another TV): the candidate is dropped.
  const connectVerified = async (t: ListedTv): Promise<Session> => {
    try {
      return await deps.connect({ id: t.id, host: t.host }, { timeoutMs: 60_000 });
    } catch (e) {
      const rec = loadState().tvs[t.id];
      // Only a pinned certificate can vouch for a new address; without one, stay at the verified address.
      if (!rec?.movedTo || !rec.cert || e instanceof CertChangedError) throw e;
      const movedTo = rec.movedTo;
      debug("trying address from discovery", t.id, movedTo);
      try {
        const s = await deps.connect({ id: t.id, host: movedTo }, { timeoutMs: 60_000, requirePinned: true });
        saveState((st) => st.tvs[t.id] && (st.tvs[t.id] = defined({ ...st.tvs[t.id], host: movedTo, movedTo: undefined })));
        return s;
      } catch (e2) {
        if (e2 instanceof CertChangedError) {
          debug("discovery address failed the certificate check; ignoring it", t.id, movedTo);
          saveState((st) => st.tvs[t.id] && (st.tvs[t.id] = defined({ ...st.tvs[t.id], movedTo: undefined })));
        }
        throw e; // report the problem with the TV's real address
      }
    }
  };

  // One shared session per TV; reconnects after the TV drops or changes IP.
  const session = (t: ListedTv): Promise<Session> => {
    const cached = sessions.get(t.id);
    if (cached) {
      return cached.then((s) => {
        if (!s.closed && s.target.host === t.host) return s;
        debug("session stale", t.id, { closed: s.closed, host: s.target.host, now: t.host });
        s.close();
        if (sessions.get(t.id) === cached) sessions.delete(t.id);
        return session(t);
      }, () => session(t));
    }
    debug("session connect", t.id, t.host);
    const p = connectVerified(t).then(
      (s) => {
        certChanged.delete(t.id);
        s.onClose(() => sessions.get(t.id) === p && sessions.delete(t.id));
        return s;
      },
      (e) => {
        sessions.delete(t.id);
        if (e instanceof CertChangedError) certChanged.add(t.id);
        throw e;
      },
    );
    sessions.set(t.id, p);
    return p;
  };

  // The TV occasionally drops a healthy connection (seen on webOS 4.x with no close reason, not tied to idle
  // time, connection count or anything we send). A request that only failed because the connection closed
  // is retried once on a fresh session.
  const closedFail = (r: Res) => !r.ok && r.payload === "connection closed";
  const request = async (t: ListedTv, uri: string, payload?: object, timeoutMs?: number): Promise<Res> => {
    const r = await (await session(t)).request(uri, payload, timeoutMs);
    if (!closedFail(r)) return r;
    debug("retry after dropped connection", t.id, uri);
    return (await session(t)).request(uri, payload, timeoutMs);
  };

  const info = async (t: ListedTv): Promise<Record<string, Res>> => {
    const results = await Promise.all(Object.values(QUERIES).map(([uri, payload]) => request(t, uri, payload, 15_000)));
    return Object.fromEntries(Object.keys(QUERIES).map((n, i) => [n, results[i]]));
  };

  const run = async (t: ListedTv, action: unknown, arg: unknown) => {
    const fn = typeof action === "string" && Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
    if (!fn) throw 400;
    const result = await fn({
      tv: t,
      req: async (uri, payload) => {
        const r = await request(t, uri, payload);
        if (!r.ok) throw new Error(String(r.payload));
        return r.payload;
      },
      pointer: async (frame) => (await session(t)).pointer(frame),
      wake: deps.wake,
    }, arg);
    if (loadState().lastTv !== t.id) saveState((s) => (s.lastTv = t.id));
    return result;
  };

  // Live updates: calls back with the TV's current value, then on every change; "offline" when it drops.
  const watch = async (t: ListedTv, cb: (e: LiveEvent) => void): Promise<() => void> => {
    const s = await session(t);
    const offs = Object.entries(LIVE).map(([kind, uri]) => s.subscribe(uri, (r) => cb({ kind, ok: r.ok, payload: r.payload })));
    let stopped = false;
    s.onClose(() => !stopped && cb({ kind: "offline", ok: false, payload: "connection to the TV closed" }));
    return () => {
      stopped = true;
      offs.forEach((off) => off());
    };
  };

  // Re-pair: drop the key and pinned certificate; the next connection shows a new prompt on the TV.
  // It goes to the last verified address only: an unverified discovery address is dropped too.
  const forget = async (t: ListedTv) => {
    const s = sessions.get(t.id);
    sessions.delete(t.id);
    s?.then((x) => x.close(), () => {});
    certChanged.delete(t.id);
    saveState((st) => {
      // Lock first: the address must stay put even if this record predates the lock flag.
      if (st.tvs[t.id]) st.tvs[t.id] = defined({ ...st.tvs[t.id], locked: true, key: undefined, cert: undefined, movedTo: undefined });
    });
  };

  return { scan, list, pick, resolve, session, request, info, run, watch, forget };
}
export type Registry = ReturnType<typeof registry>;
