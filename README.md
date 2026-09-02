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

## Extensibility

- `FilesystemService` — plug allowed roots, search backends
- `TerminalManager` — `PtyAdapter` is swappable (node-pty / conpty test double)
- `ScriptService` — add runners (shell, systemd, docker) via `ScriptDriver` interface
- `TunnelService` — implement `TunnelProvider` (tailscale, cloudflared, frp)
