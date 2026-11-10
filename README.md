# lgtvdash

Minimal local dashboard for an LG webOS TV, talking to its SSAP websocket API (port 3000).
No dependencies, no build step: Node 24+ runs the TypeScript directly.

Shows power state, current input, volume (adjustable, with mute), picture levels, network info,
inputs, installed apps and the TV's model flags.

## Run

```sh
echo "LGTV_HOST=<tv-ip>" > .env
node --env-file=.env server.ts        # http://localhost:8787
```

The first connection shows a pairing prompt on the TV; accept it with the remote.
The granted key is saved to `.lgtv-key` (gitignored). Anyone with that file can control the TV.

CLI for one-off calls:

```sh
node --env-file=.env lgtv.ts                                   # system info
node --env-file=.env lgtv.ts ssap://audio/setVolume '{"volume":10}'
```

Find the TV's IP in your router, or with an SSDP search for `urn:lge-com:service:webos-second-screen:1`.

## Limits

- Picture settings are read-only: the TV answers `401 insufficient permissions` to third-party writes.
- Picture mode, sharpness, color temperature, energy saving, sound mode and time settings
  aren't readable over SSAP (`500 Application error`).
- The server binds to `127.0.0.1` only, rejects foreign `Host` headers, and has no auth.
- TV traffic (including the client key) is plain `ws://` on the LAN. The TV also serves `wss://` on 3001
  with a self-signed certificate, which Node's built-in WebSocket rejects.

Tested on a 2019 LG webOS TV.

## License

MIT
