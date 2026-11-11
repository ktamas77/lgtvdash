# lgtvdash

Local dashboard, remote and MCP server for LG webOS TVs, talking to their SSAP API over encrypted
websockets (`wss://`, port 3001) with each TV's certificate pinned. Node 24+ runs the TypeScript directly;
no build step.

**Finds TVs automatically** on the local network (SSDP), one or several, and lets you switch between them.
TVs can also be added by hand in `tvs.json`. A TV that changes IP is followed by its id.

**Shows** power state, what's on screen, volume, sound output, picture levels, network info, inputs,
installed apps and the TV's model flags, with **live updates**: volume, app/input and power changes made
with the physical remote show up on the page within a second.

**Controls:** power on (Wake-on-LAN) / off, volume + mute, input switching, app launching, remote pad
(arrows, OK, Back, Home, Settings), media keys, **pop-up messages** on the TV, **YouTube links** played on
the TV, **typing** into the TV's focused text field, and a **trackpad** for the TV's pointer.

**From Claude:** `mcp.ts` is an MCP server, so "what's on the TV?", "turn it down to 10" or "play this
YouTube link on the TV" work from any Claude session.

## Run

```sh
npm install
npm start        # http://localhost:8787
```

The server scans the network on startup, and the **Scan** button scans again. Pick a TV in the header;
the page remembers the choice per browser.

The first connection to each TV shows a pairing prompt on it; accept it with the remote. Keys and pinned
certificates are kept per TV in `.lgtv-state.json` (gitignored). Anyone with that file can control the TVs.

### MCP server (Claude Code, Claude Desktop, other MCP clients)

```sh
claude mcp add lgtv --scope user -- node /absolute/path/to/lgtvdash/mcp.ts
```

Tools: `list_tvs`, `scan_tvs`, `tv_status`, `list_apps`, `launch_app` (by title, e.g. "Netflix"),
`switch_input` (e.g. "HDMI 1"), `set_volume`, `mute`, `press_button`, `media`, `power_on`, `power_off`,
`show_alert`, `play_youtube`, `type_text`. The `tv` argument is optional: it defaults to the TV used
last, or the only one. It shares TVs, keys and certificates with the dashboard, and doesn't need the
dashboard running.

### Adding TVs by hand (optional)

For TVs discovery can't see (another subnet, multicast blocked) or to give them names, create `tvs.json`
(gitignored; see `tvs.example.json`):

```json
[
  { "name": "Living room", "host": "192.168.1.20", "mac": "aa:bb:cc:dd:ee:ff" },
  { "name": "Bedroom", "host": "192.168.1.21", "broadcast": "192.168.1.255" }
]
```

Only `host` is required. A TV that is both configured and discovered is merged into one entry: config
values win, discovery fills in the rest (name, model, MAC). Add the TV's discovery `uuid` (from
`node lgtv.ts --discover`) to let discovery keep its IP current; without it, the entry stays on `host`.

### Power on

Wake-on-LAN needs the TV's MAC and its "Turn on via Wi-Fi" (or LAN) option enabled. Discovery picks the
MAC up automatically (from the TV's DIAL `WAKEUP` header) and remembers it, so a TV that was seen once
can be woken after a restart even while it's off. Set `mac` in `tvs.json` to override it.

| Environment (optional, e.g. in `.env`) | Purpose |
|---|---|
| `LGTV_BROADCAST` | Wake-on-LAN broadcast address, e.g. `192.168.1.255`. Default `255.255.255.255`. Per-TV `broadcast` in `tvs.json` wins. |
| `LGTV_CONFIG` | Path to the TV list. Default `tvs.json`. |
| `LGTV_STATE` | Path to the keys / certificates / seen-TVs file. Default `.lgtv-state.json`. |
| `LGTV_DEBUG` | `1` logs the TV connection lifecycle to stderr (opens, closes with code, who closed, retries). |
| `PORT` | Dashboard port. Default `8787`. |

## CLI

```sh
node lgtv.ts --discover                                        # list TVs on the network
node lgtv.ts                                                   # system info of the first TV found
LGTV_HOST=192.168.1.20 node lgtv.ts ssap://audio/setVolume '{"volume":10}'
LGTV_HOST=192.168.1.20 node lgtv.ts ssap://tv/switchInput '{"inputId":"HDMI_1"}'
```

## HTTP API

| Endpoint | Body | |
|---|---|---|
| `GET /api/tvs` | | Known TVs (config + discovered) with `id`, `online`, `paired`, `certPinned`, `certChanged` |
| `POST /api/scan` | `{}` | Rescan the network, returns the TV list |
| `GET /api/info?tv=<id>` | | All readable state of one TV |
| `GET /api/events?tv=<id>` | | Server-sent events: `volume`, `foreground`, `power` on every change; `offline` when the TV drops |
| `POST /api/cmd` | `{"tv": "<id>", "action": "...", "arg": ...}` | One control action |

Only TVs in that list can be addressed; anything else is a 404. Actions:

| Action | `arg` |
|---|---|
| `volume` | 0–100 |
| `mute` | `true` / `false` |
| `input` | input id, e.g. `HDMI_1` |
| `launch` | app id |
| `button` | `UP` `DOWN` `LEFT` `RIGHT` `ENTER` `BACK` `HOME` `EXIT` `MENU` `INFO` |
| `media` | `play` `pause` `stop` `rewind` `fastForward` |
| `powerOff`, `powerOn` | |
| `alert` | message, 1–200 chars: a pop-up with an OK button |
| `youtube` | YouTube link (watch, youtu.be, shorts, live, embed) or 11-char video id |
| `text` | 1–500 chars, typed into the focused text field |
| `key` | `enter` / `backspace` |
| `pointer` | `{"dx": n, "dy": n}`, integers up to ±500 |
| `click` | |
| `scroll` | `{"dy": n}` |
| `forget` | Re-pair: drop this TV's key and pinned certificate |

## What the TV allows

Probed on a 2019 webOS TV with an unsigned client manifest:

| Works | Refused |
|---|---|
| System info, power state, volume, sound output, foreground app, TV clock, network MACs, input list, app list and app info, 3D status, config flags (`tv.model.*`, `tv.hw.*`, `tv.config.*`, `tv.conti.*`, `tv.rmm.*`, `system.*`) | Firmware version (`401`) |
| Settings reads: backlight, contrast, brightness, color, country, audio guidance, store mode, device name, Wake-on-LAN, SIMPLINK | Picture mode and other picture options, sound mode, time zone, parental lock (`500`) |
| Volume, mute, sound output, input switch, app launch, remote buttons, media keys, power off; subscriptions to volume, foreground app and power state push every change | Any `setSystemSettings` write, picture included (`401`) |

## Tests

```sh
npm test         # node --test, no TV needed
```

- `test/lgtv.test.ts`: the client against a scripted fake transport that presents a chosen certificate
  fingerprint (pinning, pairing, sessions, subscriptions, pointer socket, state migration, SSDP parsing).
- `test/tvs.test.ts`: the registry with a fake `connect()` (TV list and merge, IP changes, sessions and
  retries, every action and its validation, YouTube link parsing).
- `test/server.test.ts`: the HTTP API on a random port, including the event stream and the security guards.
- `test/mcp.test.ts`: a real MCP client over the SDK's in-memory transport.

## Security

- The dashboard binds to `127.0.0.1` only and has no auth. It rejects foreign `Host` headers (DNS
  rebinding) and cross-origin or non-JSON POSTs (CSRF); the event stream sends no CORS headers.
- TV traffic is `wss://`. Every webOS TV has its own self-signed certificate, so the certificate chain
  isn't verified; instead the certificate's SHA-256 fingerprint is pinned per TV on first contact, and the
  pairing key is only sent to a TV presenting that same certificate. A TV whose certificate changed
  (factory reset, possibly a firmware update) shows **Re-pair** instead of receiving the key.
- Discovery answers (SSDP) are unauthenticated, so they never move a known TV by themselves. A pinned TV's
  id showing up at a new IP is only recorded as a candidate; the TV's address changes once that IP presents
  the pinned certificate. A spoofed answer fails that check and is dropped, and **Re-pair** always targets
  the last verified address. A TV paired before pinning existed must re-pair after an IP change.
- It only connects to TVs from `tvs.json` or discovery, never to a host named in a request, and only
  fetches a discovered TV's description URL when it points back at the IP that answered.
- Pop-up messages use a plain OK button: no `onClick` service calls.
- App icons are loaded from the TV's plain `http://<tv>:3000/resources/…` (the `https://…:3001` URLs the TV
  hands out are refused by browsers); icons aren't sensitive.

## License

MIT
