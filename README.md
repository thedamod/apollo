# home-server

Home server control plane — inspired by [t3code](https://github.com/pingdotgg/t3code) architecture.

Monorepo layout mirrors `t3code`:

```
apps/
  server/   # persistent daemon on the machine (ws + http, tailscale serve, terminal, fs, stats, scripts)
packages/
  contracts/ # zod-typed RPC schemas (shared wire contract)
  shared/    # runtime utils (net, shell, labels, path)
  tailscale/ # tailscale serve lifecycle (port of t3code @t3tools/tailscale)
context/
  t3code/   # vendored reference (gitignored)
```

## Quick start

```bash
pnpm i
pnpm --filter @home-server/server dev          # start server (default 127.0.0.1:7070)
pnpm --filter @home-server/server start        # production (node dist/bin.mjs)
```

## Remote access

The server exposes `tailscaleServeEnabled` in its config. When enabled it runs:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:<port>
```

on startup and `tailscale serve --https=443 off` on shutdown — same lifecycle as `t3code:3773:apps/server/src/server.ts:559`.

## Contracts

All wire types live in `packages/contracts`. Add a method there, register its handler in `apps/server/src/rpc/registry.ts`, and clients auto-pick it up.

## Services — run & monitor Jellyfin (and any daemon)

`ServiceManager` (`apps/server/src/services/serviceManager.ts`) supervises long-running daemons with **health checks, auto-restart, and multi-backend drivers**. Works with:

- **shell** — direct binary (`jellyfin`, `python3 -m http.server 8096`, any command). Spawns via `child_process`, captures pid, streams logs to `userdata/logs/services/<id>.log`, polls health via `port`/`http`/`process`, restarts on failure (configurable `restartDelayMs`, `maxRestarts`).
- **systemd** — unit `jellyfin.service` (`systemctl start/stop/is-active`, `journalctl -u`). Use when Jellyfin is installed via apt.
- **docker** — container `jellyfin` image `jellyfin/jellyfin` (`docker start/stop/inspect/logs`). Use when running `jellyfin/jellyfin`.

```bash
# create jellyfin as shell service
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7070/api/... # or via WS:
# WS: services.create {id:"jellyfin", name:"Jellyfin", command:"jellyfin", type:"shell", port:8096, healthCheck:{type:"http",target:"http://127.0.0.1:8096/health"}, autoRestart:true, enabled:true}
# WS: services.create {id:"jellyfin", name:"Jellyfin", type:"systemd", systemdUnit:"jellyfin.service", port:8096}
# WS: services.create {id:"jellyfin", name:"Jellyfin", type:"docker", dockerContainer:"jellyfin", dockerImage:"jellyfin/jellyfin", port:8096}
```

RPC: `services.list/get/create/update/delete/start/stop/restart/logs/status/subscribe` (see `packages/contracts/src/services.ts` and `packages/contracts/src/rpc.ts`). All persisted to `userdata/services.json` and auto-started if `enabled:true`.

Example via test CLI (not committed, `cli/client.mjs`):
```bash
node cli/client.mjs --port 7070 services create   # demo jellyfin on 18096
node cli/client.mjs --port 7070 --token $TOKEN probe   # also lists services
```

## Extensibility

- `FilesystemService` — plug allowed roots, search backends
- `TerminalManager` — `PtyAdapter` is swappable (node-pty / conpty test double)
- `ScriptService` — short-lived scripts; `ServiceManager` — long-running daemons (jellyfin) via `ServiceDriver` interface (shell/systemd/docker)
- `TunnelService` — implement `TunnelProvider` (tailscale, cloudflared, frp)
