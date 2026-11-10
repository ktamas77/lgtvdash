# lgtvdash

Minimal local dashboard for an LG webOS TV, talking to its SSAP websocket API (port 3000).
No dependencies, no build step: Node 24+ runs the TypeScript directly.

Shows power state, current input, volume, picture levels, network info, inputs, installed apps
and the TV's model flags.

Controls: power on (Wake-on-LAN) / off, volume + mute, input switching, app launching,
remote pad (arrows, OK, Back, Home, Settings) and media keys.

## Run

```sh
cat > .env <<EOF
LGTV_HOST=<tv-ip>
LGTV_MAC=<tv-mac>              # optional, for power on; the MAC of the interface the TV uses (Wi-Fi or wired)
LGTV_BROADCAST=<subnet-bcast>  # optional, e.g. 192.168.1.255; default 255.255.255.255
EOF
node --env-file=.env server.ts        # http://localhost:8787
```

Power on needs the TV's "Turn on via Wi-Fi" (or LAN) option enabled.

The first connection shows a pairing prompt on the TV; accept it with the remote.
The granted key is saved to `.lgtv-key` (gitignored). Anyone with that file can control the TV.

CLI for one-off calls:

```sh
node --env-file=.env lgtv.ts                                   # system info
node --env-file=.env lgtv.ts ssap://audio/setVolume '{"volume":10}'
```

Find the TV's IP in your router, or with an SSDP search for `urn:lge-com:service:webos-second-screen:1`.

## Limits

- Settings are read-only: the TV answers `401 insufficient permissions` to any `setSystemSettings`
  call (picture, SIMPLINK, audio guidance, Wake-on-LAN).
- Picture mode, sharpness, color temperature, energy saving, sound mode and time settings
  aren't readable over SSAP (`500 Application error`).
- The server binds to `127.0.0.1` only, rejects foreign `Host` headers, and has no auth.
- TV traffic (including the client key) is plain `ws://` on the LAN. The TV also serves `wss://` on 3001
  with a self-signed certificate, which Node's built-in WebSocket rejects.

Tested on a 2019 LG webOS TV.

## License

MIT
