# lgtvdash

Minimal local dashboard and remote for an LG webOS TV, talking to its SSAP websocket API (port 3000).
No dependencies, no build step: Node 24+ runs the TypeScript directly.

**Shows:** power state, current input, volume, sound output, picture levels, network info, inputs,
installed apps and the TV's model flags.

**Controls:** power on (Wake-on-LAN) / off, volume + mute, input switching, app launching,
remote pad (arrows, OK, Back, Home, Settings) and media keys.

## Run

```sh
cat > .env <<EOF
LGTV_HOST=<tv-ip>
LGTV_MAC=<tv-mac>
LGTV_BROADCAST=<subnet-broadcast>
EOF
node --env-file=.env server.ts        # http://localhost:8787
```

| Variable | Required | Purpose |
|---|---|---|
| `LGTV_HOST` | yes | The TV's IP. Find it in your router, or with an SSDP search for `urn:lge-com:service:webos-second-screen:1`. |
| `LGTV_MAC` | for power on | MAC of the interface the TV is connected with (Wi-Fi or wired). |
| `LGTV_BROADCAST` | no | Wake-on-LAN broadcast address, e.g. `192.168.1.255`. Default `255.255.255.255`. |
| `PORT` | no | Dashboard port. Default `8787`. |

The first connection shows a pairing prompt on the TV; accept it with the remote.
The granted key is saved to `.lgtv-key` (gitignored). Anyone with that file can control the TV.

Power on needs the TV's "Turn on via Wi-Fi" (or LAN) option enabled.

## CLI

```sh
node --env-file=.env lgtv.ts                                        # system info
node --env-file=.env lgtv.ts ssap://audio/setVolume '{"volume":10}'
node --env-file=.env lgtv.ts ssap://tv/switchInput '{"inputId":"HDMI_1"}'
```

## HTTP API

| Endpoint | Body | |
|---|---|---|
| `GET /api/info` | | All readable state in one call |
| `POST /api/cmd` | `{"action": "...", "arg": ...}` | One control action, JSON only |

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

## Security

- The server binds to `127.0.0.1` only and has no auth.
- It rejects foreign `Host` headers (DNS rebinding) and cross-origin or non-JSON POSTs (CSRF).
- TV traffic, including the client key, is plain `ws://` on the LAN. The TV also serves `wss://` on 3001
  with a self-signed certificate, which Node's built-in WebSocket rejects.

## License

MIT
