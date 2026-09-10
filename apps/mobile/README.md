# Aether — home-server mobile app (Expo)

Dark home-dashboard matching the mock: greeting, Tailscale pill, server card,
CPU/RAM/Disk/Uptime tiles with sparklines, Tailscale row, recent activity, and
a bottom tab bar (Home, Files, Terminal, Scripts, Services, Settings).

UI language follows the vendored reference `context/t3code/apps/mobile`
(DM Sans, near-black `#0b0b0c` screen, `#161617` cards, hairline white borders).

## Run

```bash
# terminal 1 — server (note the pairing URL it prints)
pnpm --filter @home-server/server dev

# terminal 2 — app
pnpm --filter @home-server/mobile start
# scan the QR with Expo Go (same Wi-Fi), or `pnpm ... ios/android`
```

In the app choose **Pairing URL** and paste the server's `pairingUrl:`
(`home-server pair` mints a fresh one), or enter the base URL + token
(`home-server token`) manually.

## Connecting over Tailscale

Start the server with tailscale serve enabled:

```bash
pnpm --filter @home-server/server dev -- --tailscale
# server runs: tailscale serve --bg --https=443 http://127.0.0.1:<port>
```

Then in the app use any of:
- `http://100.x.y.z:7070` (tailnet IP)
- `https://<machine>.<tailnet>.ts.net` (MagicDNS, via `tailscale serve`)
- `http://192.168.1.x:7070` (plain LAN)

No native Tailscale SDK is needed — the app is just an HTTPS/WS client
(`src/lib/client.ts`). Auth rides the `?token=` WS query (RN WebSocket has
no custom headers; the server accepts both). `tunnel.get` drives the
Settings → Tunnel row.

## Wire contract

All RPC shapes come from `@home-server/contracts` (`packages/contracts`):
`system.stats` + `system.statsSubscribe`, `filesystem.browse`,
`terminal.open/write/attach`, `scripts.*`, `services.*`, `tunnel.get`,
`server.getInfo`. Same envelopes as `cli/client.mjs`.
