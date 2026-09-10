# home-server

Home-lab control plane — daemon + Expo app for files, terminal, services over Tailscale.

Run one persistent daemon on your home machine (file browser, PTY terminal, system stats, scripts, service supervisor, Tailscale Serve), and control it from an Expo mobile app or any WebSocket client. Wire contract is Zod-typed and shared across server, app, and CLI.

## Features

- **Server daemon** (`apps/server`) — HTTP + WebSocket on `127.0.0.1:7070` by default, token auth with pairing URLs, graceful shutdown.
- **Files** — browse/stat/read/mkdir/rename/delete, preview with Shiki highlighting, upload/download.
- **Terminal** — real PTY via `node-pty` (swappable `PtyAdapter`), multi-session, log replay.
- **System** — live CPU/RAM/disk/uptime stats + `system.statsSubscribe` push every 2s.
- **Scripts** — short-lived scripts with run/log history.
- **Services** — supervise long-running daemons (e.g. Jellyfin) with health checks, auto-restart, and `shell` / `systemd` / `docker` drivers. Persisted to `userdata/services.json`.
- **Tunnel** — Tailscale Serve lifecycle (`serve --bg --https=443 …` on start, `off` on shutdown) plus `tunnel.get` status.
- **Mobile app** (`apps/mobile`) — Expo + React Native dark dashboard: Home (stats + sparklines), Files, Terminal, Scripts, Services, Settings/Appearance/Environments. Pairs via QR/pairing URL or base URL + token.
- **Contracts** (`packages/contracts`) — single source of truth for RPC (`system`, `filesystem`, `terminal`, `scripts`, `services`, `tunnel`, `server.getInfo`). Add a method there, register it in `apps/server/src/rpc/registry.ts`.
- **Shared / Tailscale** (`packages/shared`, `packages/tailscale`) — runtime utils (net, shell, labels, path) and `tailscale serve` wrapper.

## Monorepo layout

```
apps/
  server/   # persistent daemon (http + ws, auth, terminal, fs, stats, scripts, services, tunnel)
  mobile/   # Expo app (dashboard, files, terminal, scripts, services, pairing)
packages/
  contracts/ # zod-typed RPC schemas (shared wire contract)
  shared/    # runtime utils
  tailscale/ # tailscale serve lifecycle
cli/
  client.mjs # throwaway WS test client (not published)
```

## Requirements

- Node `>=20.12.0`
- `pnpm@9.12.0`
- For the app: Expo Go (same Wi-Fi) or `ios`/`android` build tooling
- Optional: `tailscale` CLI on the server for remote access

## Quick start

```bash
pnpm i

# terminal 1 — server (default 127.0.0.1:7070)
pnpm --filter @home-server/server dev
# production:
pnpm --filter @home-server/server build
pnpm --filter @home-server/server start

# terminal 2 — mobile app
pnpm --filter @home-server/mobile start
# scan the QR with Expo Go (same Wi-Fi), or run:
# pnpm --filter @home-server/mobile ios
# pnpm --filter @home-server/mobile android
```

Open the app → **Pairing URL** → paste the `pairingUrl:` the server prints on boot (or `home-server pair`), or enter base URL + token manually (`home-server token`).

## Server CLI

```bash
home-server start [--port <n>] [--host <ip>] [--base-dir <path>] [--tailscale]
home-server pair  [--port <n>] [--base-dir <path>]   # print pairing URL
home-server token [--base-dir <path>]                # print auth token

# env overrides:
# HOME_SERVER_PORT, HOME_SERVER_HOST, HOME_SERVER_HOME,
# HOME_SERVER_TAILSCALE=1, HOME_SERVER_TAILSCALE_PORT
```

State lives in `~/.home-server/userdata` (or `$HOME_SERVER_HOME`): `secrets/token`, `scripts.json`, `services.json`, `logs/`, `server-runtime.json`.

Health check: `GET /health`. WebSocket: `ws://<host>:<port>/ws?token=<token>` (token in query because RN WebSocket has no custom headers).

## Remote access (Tailscale)

```bash
pnpm --filter @home-server/server dev -- --tailscale
# server runs: tailscale serve --bg --https=443 http://127.0.0.1:<port>
# on shutdown: tailscale serve --https=443 off
```

Then connect the app via any of:

- `http://100.x.y.z:7070` (tailnet IP)
- `https://<machine>.<tailnet>.ts.net` (MagicDNS via `tailscale serve`)
- `http://192.168.1.x:7070` (plain LAN)

No native Tailscale SDK needed — the app is just an HTTPS/WS client (`apps/mobile/src/lib/client.ts`).

## Services — run & monitor Jellyfin (and any daemon)

`ServiceManager` (`apps/server/src/services/serviceManager.ts`) supervises daemons with health checks, auto-restart, and multi-backend drivers:

- **shell** — direct binary (`jellyfin`, `python3 -m http.server 8096`, …). Spawns via `child_process`, captures pid, streams logs to `userdata/logs/services/<id>.log`, polls `port`/`http`/`process` health, restarts on failure (`restartDelayMs`, `maxRestarts`).
- **systemd** — unit `jellyfin.service` (`systemctl start/stop/is-active`, `journalctl -u`).
- **docker** — container `jellyfin` image `jellyfin/jellyfin` (`docker start/stop/inspect/logs`).

```bash
# via WS (or cli/client.mjs):
# services.create {id:"jellyfin", name:"Jellyfin", command:"jellyfin", type:"shell", port:8096,
#   healthCheck:{type:"http", target:"http://127.0.0.1:8096/health"}, autoRestart:true, enabled:true}
# services.create {id:"jellyfin", name:"Jellyfin", type:"systemd", systemdUnit:"jellyfin.service", port:8096}
# services.create {id:"jellyfin", name:"Jellyfin", type:"docker", dockerContainer:"jellyfin", dockerImage:"jellyfin/jellyfin", port:8096}
```

RPC: `services.list/get/create/update/delete/start/stop/restart/logs/status/subscribe` (see `packages/contracts/src/services.ts`, `packages/contracts/src/rpc.ts`). Auto-starts entries with `enabled:true`.

```bash
node cli/client.mjs --port 7070 services create
node cli/client.mjs --port 7070 --token $TOKEN probe   # also lists services
```

## Extensibility

- `FilesystemService` — plug allowed roots, search backends
- `TerminalManager` — `PtyAdapter` is swappable (node-pty / conpty test double)
- `ScriptService` — short-lived scripts; `ServiceManager` — long-running daemons via `ServiceDriver` (`shell`/`systemd`/`docker`)
- `TunnelService` — implement `TunnelProvider` (`tailscale`, `cloudflared`, `frp`)

To add an RPC method: define its Zod schema in `packages/contracts`, register the handler in `apps/server/src/rpc/registry.ts`, call it from `RpcClient` (mobile) or `cli/client.mjs`.

## Scripts

```bash
pnpm dev          # all workspaces in parallel
pnpm dev:server   # server only
pnpm build        # all workspaces
pnpm typecheck
pnpm test         # vitest (server)
pnpm lint
pnpm fmt          # prettier --write .
```
