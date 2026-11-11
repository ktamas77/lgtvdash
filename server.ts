// Web dashboard for LG webOS TVs: node --env-file-if-exists=.env server.ts -> http://localhost:8787
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registry, loadConfig, type Registry } from "./tvs.ts";

const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

// CSRF guard: other sites can't send JSON without a CORS preflight, and browsers always send Origin on POST.
async function readJson(req: IncomingMessage): Promise<any> {
  const origin = req.headers.origin;
  if ((origin && origin !== `http://${req.headers.host}`) || !req.headers["content-type"]?.startsWith("application/json")) throw 403;
  let body = "";
  try {
    for await (const chunk of req) if ((body += chunk).length > 2048) throw 0;
    return JSON.parse(body || "{}");
  } catch {
    throw 400;
  }
}

export function app(tvs: Registry = registry()) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    // DNS-rebinding guard: a foreign page resolving its domain to 127.0.0.1 would send its own Host.
    const port = req.socket.localPort;
    if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.host ?? "")) return res.writeHead(403).end();
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/tvs" && req.method === "GET") return json(res, 200, tvs.list());
      if (url.pathname === "/api/scan" && req.method === "POST") {
        await readJson(req);
        await tvs.scan();
        return json(res, 200, tvs.list());
      }
      if (url.pathname === "/api/info" && req.method === "GET") {
        const t = tvs.pick(url.searchParams.get("tv"));
        try {
          return json(res, 200, await tvs.info(t));
        } catch (e: any) {
          return json(res, 502, { error: e.message });
        }
      }
      // await: an unknown TV throws 404 inside events(), and must land in the catch below.
      if (url.pathname === "/api/events" && req.method === "GET") return await events(tvs, url.searchParams.get("tv"), req, res);
      if (url.pathname === "/api/cmd" && req.method === "POST") {
        const { tv, action, arg } = await readJson(req);
        const t = tvs.pick(tv);
        if (action === "forget") {
          await tvs.forget(t);
          return json(res, 200, { ok: true });
        }
        try {
          await tvs.run(t, action, arg);
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
      if (res.headersSent) return res.end();
      if (typeof e !== "number") return json(res, 500, { error: e.message }); // never let a request crash the server
      json(res, e, { error: e === 403 ? "forbidden" : e === 404 ? "unknown TV" : "bad request" });
    }
  };
}

// Server-sent events: the TV's current volume / foreground app / power state, then every change.
// When the TV drops, an "offline" event ends the stream; the browser's EventSource reconnects by itself.
async function events(tvs: Registry, id: string | null, req: IncomingMessage, res: ServerResponse) {
  const t = tvs.pick(id);
  // Headers first: the TV answers subscriptions immediately, possibly before watch() returns.
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  res.write("retry: 5000\n\n");
  const send = (e: object) => !res.writableEnded && res.write(`data: ${JSON.stringify(e)}\n\n`);
  let stop: (() => void) | undefined, gone = false;
  req.on("close", () => ((gone = true), stop?.()));
  try {
    stop = await tvs.watch(t, (e) => {
      send(e);
      if (e.kind === "offline") res.end();
    });
    if (gone) stop(); // the browser left while we were connecting
  } catch (e: any) {
    send({ kind: "offline", ok: false, payload: e.message });
    res.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PORT = Number(process.env.PORT ?? 8787);
  const tvs = registry({ config: loadConfig(process.env.LGTV_CONFIG ?? fileURLToPath(new URL("tvs.json", import.meta.url))) });
  createServer(app(tvs)).listen(PORT, "127.0.0.1", () => console.log(`http://localhost:${PORT}`));
  tvs.scan().then(() => console.log(`TVs: ${tvs.list().map((t) => `${t.name ?? "?"} @ ${t.host}`).join(", ") || "none found"}`));
}
