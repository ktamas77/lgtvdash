// Shared fake TV for registry / server / MCP tests: a fake connect() returning scripted sessions.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LGTV_STATE = join(mkdtempSync(join(tmpdir(), "lgtv-fake-")), "state.json");
const { CertChangedError, loadState } = await import("../lgtv.ts");
const { registry } = await import("../tvs.ts");

export const TV1 = { host: "10.0.0.5", uuid: "uuid-1", name: "Living room TV", model: "M1", mac: "aa:aa:aa:aa:aa:aa" };
export const TV2 = { host: "10.0.0.6", uuid: "uuid-2", name: "Bedroom TV", model: "M2", mac: "bb:bb:bb:bb:bb:bb" };

export class FakeSession {
  closed = false;
  target: { id: string; host: string };
  subs = new Map<string, (r: any) => void>();
  #onClose: (() => void)[] = [];
  constructor(target: { id: string; host: string }) { this.target = target; }
  async request(uri: string, payload?: object) {
    tv.calls.push({ id: this.target.id, uri, payload });
    return { uri, ...tv.answer(uri, payload) };
  }
  subscribe(uri: string, cb: (r: any) => void) {
    this.subs.set(uri, cb);
    return () => this.subs.delete(uri);
  }
  push(uri: string, payload: any) { this.subs.get(uri)?.({ uri, ok: true, payload }); }
  async pointer(frame: string) { tv.calls.push({ id: this.target.id, frame }); }
  onClose(cb: () => void) { this.#onClose.push(cb); }
  close() { this.closed = true; this.#onClose.forEach((cb) => cb()); }
}

export const tv = {
  calls: [] as any[],
  connects: [] as { id: string; host: string }[],
  sessions: [] as FakeSession[],
  found: [] as any[],
  down: false,
  certChanged: false,
  unreachable: new Set<string>(), // hosts that refuse connections
  badCert: new Set<string>(), // hosts presenting a different certificate than the pinned one
  answer: (_uri: string, _payload?: object): { ok: boolean; payload: any } => ({ ok: true, payload: {} }),
  deps: {
    connect: async (target: { id: string; host: string }, opts: { requirePinned?: boolean } = {}) => {
      tv.connects.push(target);
      if (opts.requirePinned && !loadState().tvs[target.id]?.cert) throw new CertChangedError("no pinned certificate");
      if (tv.down || tv.unreachable.has(target.host)) throw new Error("connection failed: unreachable");
      if (tv.certChanged || tv.badCert.has(target.host)) throw new CertChangedError(`certificate changed for ${target.id}`);
      const s = new FakeSession(target);
      tv.sessions.push(s);
      return s;
    },
    discover: async () => tv.found,
    wake: async (mac: string, broadcast?: string) => void tv.calls.push({ wake: mac, broadcast }),
  },
  reset() {
    tv.calls = []; tv.connects = []; tv.sessions = []; tv.found = []; tv.down = false; tv.certChanged = false;
    tv.unreachable = new Set(); tv.badCert = new Set();
    tv.answer = () => ({ ok: true, payload: {} });
    rmSync(process.env.LGTV_STATE!, { force: true });
    delete process.env.LGTV_BROADCAST;
  },
};

export const makeRegistry = (config: any[] = []) => registry({ deps: tv.deps as any, config });
