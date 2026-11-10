# lgtvdash

Minimal local dashboard and remote for LG webOS TVs, talking to their SSAP websocket API (port 3000).
No dependencies, no build step: Node 24+ runs the TypeScript directly.

**Finds TVs automatically** on the local network (SSDP), one or several, and lets you switch between them.
TVs can also be added by hand in `tvs.json`.

**Shows:** power state, current input, volume, sound output, picture levels, network info, inputs,
installed apps and the TV's model flags.

**Controls:** power on (Wake-on-LAN) / off, volume + mute, input switching, app launching,
remote pad (arrows, OK, Back, Home, Settings) and media keys.

## Run

```sh
npm start        # http://localhost:8787
```

That's it: the server scans the network on startup, and the **Scan** button scans again.
Pick a TV in the header; the page remembers the choice per browser.

The first connection to each TV shows a pairing prompt on it; accept it with the remote.
Keys are kept per TV in `.lgtv-state.json` (gitignored). Anyone with that file can control the TVs.

### Adding TVs by hand (optional)

For TVs discovery can't see (another subnet, multicast blocked) or to give them names, create `tvs.json`
(gitignored; see `tvs.example.json`):

```json
[
  { "name": "Living room", "host": "192.168.1.20", "mac": "aa:bb:cc:dd:ee:ff" },
  { "name": "Bedroom", "host": "192.168.1.21", "broadcast": "192.168.1.255" }
]
```

Only `host` is required. A TV that is both configured and discovered is merged into one entry:
config values win, discovery fills in the rest (name, model, MAC).

### Power on

Wake-on-LAN needs the TV's MAC and its "Turn on via Wi-Fi" (or LAN) option enabled. Discovery picks the
MAC up automatically (from the TV's DIAL `WAKEUP` header) and remembers it, so a TV that was seen once
can be woken after a restart even while it's off. Set `mac` in `tvs.json` to override it.

| Environment (optional, e.g. in `.env`) | Purpose |
|---|---|
| `LGTV_BROADCAST` | Wake-on-LAN broadcast address, e.g. `192.168.1.255`. Default `255.255.255.255`. Per-TV `broadcast` in `tvs.json` wins. |
| `LGTV_CONFIG` | Path to the TV list. Default `tvs.json`. |
| `LGTV_STATE` | Path to the keys + seen-TVs file. Default `.lgtv-state.json`. |
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
| `GET /api/tvs` | | Known TVs: config + discovered, with `online` and `paired` flags |
| `POST /api/scan` | `{}` | Rescan the network, returns the TV list |
| `GET /api/info?tv=<host>` | | All readable state of one TV |
| `POST /api/cmd` | `{"tv": "<host>", "action": "...", "arg": ...}` | One control action |

Only TVs in that list can be addressed; anything else is a 404.

Actions: `volume` (0–100), `mute` (bool), `input` (input id, e.g. `HDMI_1`), `launch` (app id),
`button` (`UP` `DOWN` `LEFT` `RIGHT` `ENTER` `BACK` `HOME` `EXIT` `MENU` `INFO`),
`media` (`play` `pause` `stop` `rewind` `fastForward`), `powerOff`, `powerOn`.

## What the TV allows

Probed on a 2019 webOS TV with an unsigned client manifest:

| Works | Refused |
|---|---|
| System info, power state, volume, sound output, foreground app, TV clock, network MACs, input list, app list and app info, 3D status, config flags (`tv.model.*`, `tv.hw.*`, `tv.config.*`, `tv.conti.*`, `tv.rmm.*`, `system.*`) | Firmware version (`401`) |
| Settings reads: backlight, contrast, brightness, color, country, audio guidance, store mode, device name, Wake-on-LAN, SIMPLINK | Picture mode and other picture options, sound mode, time zone, parental lock (`500`) |
| Volume, mute, sound output, input switch, app launch, remote buttons, media keys, power off | Any `setSystemSettings` write, picture included (`401`) |

## Tests

```sh
npm test         # node --test, no TV needed
```

The client tests replace `WebSocket` with a scripted fake TV and feed real-shaped SSDP answers to the
discovery parser; the server tests run the HTTP handler on a random port with fake TV and discovery
functions. Keys go to a temp state file (`LGTV_STATE`).

## Security

- The server binds to `127.0.0.1` only and has no auth.
- It rejects foreign `Host` headers (DNS rebinding) and cross-origin or non-JSON POSTs (CSRF).
- It only connects to TVs from `tvs.json` or discovery, never to a host named in a request, and only
  fetches a discovered TV's description URL when it points back at the IP that answered.
- Keys are per TV: one TV's key is never offered to another.
- TV traffic, including the client key, is plain `ws://` on the LAN. The TV also serves `wss://` on 3001
  with a self-signed certificate, which Node's built-in WebSocket rejects.

## License

MIT
