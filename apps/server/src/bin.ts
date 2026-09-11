#!/usr/bin/env node
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadOrCreateConfig } from "./config.ts";
import { ensureToken, createPairingToken, pairingUrlFromConfig } from "./auth.ts";
import { logger } from "./logger.ts";
import { createHttpApp } from "./http.ts";
import { attachWsRouter } from "./ws.ts";
import { RpcRegistry } from "./rpc/registry.ts";
import { registerFilesystemHandlers } from "./rpc/handlers/filesystem.ts";
import { registerTerminalHandlers } from "./rpc/handlers/terminal.ts";
import { registerSystemHandlers } from "./rpc/handlers/system.ts";
import { registerScriptHandlers } from "./rpc/handlers/scripts.ts";
import { registerServiceHandlers } from "./rpc/handlers/services.ts";
import { registerTunnelHandlers } from "./rpc/handlers/tunnel.ts";
import { registerMetaHandlers } from "./rpc/handlers/meta.ts";
import { FilesystemService } from "./services/filesystem.ts";
import { SystemService } from "./services/system.ts";
import { ScriptService } from "./services/scripts.ts";
import { ServiceManager } from "./services/serviceManager.ts";
import { TunnelService } from "./services/tunnel.ts";
import { TerminalManager } from "./services/terminal/manager.ts";
import * as tailscale from "@home-server/tailscale";

function printHelp(): void {
  console.log(`
home-server — persistent home-lab daemon

Usage:
  home-server start [--port <n>] [--host <ip>] [--base-dir <path>] [--tailscale]
  home-server pair  [--port <n>] [--base-dir <path>]   # print pairing URL
  home-server token [--base-dir <path>]                # print auth token
  home-server --help

Env:
  HOME_SERVER_PORT, HOME_SERVER_HOST, HOME_SERVER_HOME,
  HOME_SERVER_TAILSCALE=1, HOME_SERVER_TAILSCALE_PORT

Data dir: ~/.home-server/userdata  (or $HOME_SERVER_HOME)
`);
}

function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string | boolean> } {
  const opts: Record<string, string | boolean> = {};
  let cmd = argv[2] ?? "start";
  if (cmd.startsWith("-")) cmd = "start";
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--tailscale") opts.tailscale = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true";
      opts[k] = v;
    }
  }
  if (argv.includes("--help") || argv.includes("-h")) opts.help = true;
  return { cmd, opts };
}

async function main(): Promise<void> {
  const { cmd, opts } = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  if (cmd === "token") {
    const baseDir = opts["base-dir"] ? String(opts["base-dir"]) : undefined;
    const cfg = loadOrCreateConfig({ baseDir });
    const token = ensureToken(cfg.tokenPath);
    console.log(token);
    return;
  }

  if (cmd === "pair") {
    const baseDir = opts["base-dir"] ? String(opts["base-dir"]) : undefined;
    const cfg = loadOrCreateConfig({ baseDir, port: opts.port ? Number(opts.port) : undefined });
    ensureToken(cfg.tokenPath);
    const pairing = createPairingToken();
    const url = pairingUrlFromConfig(cfg.port, cfg.host, pairing);
    console.log(url);
    return;
  }

  if (cmd !== "start") {
    console.error(`Unknown command: ${cmd}`);
    printHelp();
    process.exit(1);
  }

  const config = loadOrCreateConfig({
    port: opts.port ? Number(opts.port) : opts["port"] ? Number(opts["port"]) : undefined,
    host: opts.host ? String(opts.host) : opts["host"] ? String(opts["host"]) : undefined,
    baseDir: opts["base-dir"] ? String(opts["base-dir"]) : undefined,
    tailscaleServeEnabled: Boolean(opts.tailscale),
  });

  const token = ensureToken(config.tokenPath);
  logger.info(`home-server starting`, { port: config.port, host: config.host, baseDir: config.baseDir });

  // services (extensible — all constructed here, injected into registry)
  const filesystemService = new FilesystemService();
  const systemService = new SystemService();
  const scriptService = new ScriptService(config.scriptsPath, config.logsDir, undefined, {
    timerCallback: { port: config.port, tokenPath: config.tokenPath },
  });
  await scriptService.init();
  const serviceManager = new ServiceManager(config.servicesPath, config.logsDir);
  await serviceManager.init();
  const terminalManager = new TerminalManager(config.terminalLogsDir);
  await terminalManager.init();
  const tunnelService = new TunnelService(config.port, config.tailscaleServeEnabled ? "tailscale" : "disabled", config.tailscaleServePort);

  // rpc registry — single place to add new methods
  const registry = new RpcRegistry();
  registerMetaHandlers(registry, config);
  registerFilesystemHandlers(registry, filesystemService);
  registerTerminalHandlers(registry, terminalManager);
  registerSystemHandlers(registry, systemService);
  registerScriptHandlers(registry, scriptService);
  registerServiceHandlers(registry, serviceManager);
  registerTunnelHandlers(registry, tunnelService);

  const app = createHttpApp({ config, token, systemService, filesystemService, scriptService });
  const server = http.createServer(app);

  attachWsRouter({
    server,
    registry,
    expectedToken: token,
    terminalManager,
    scriptService,
    serviceManager,
    systemService,
  });

  // persist runtime state (like t3code serverRuntimeState)
  const runtimeStatePath = config.runtimeStatePath;
  function writeRuntimeState(port: number): void {
    try {
      fs.writeFileSync(runtimeStatePath, JSON.stringify({ port, host: config.host, pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
    } catch {}
  }
  function clearRuntimeState(): void {
    try {
      fs.unlinkSync(runtimeStatePath);
    } catch {}
  }

  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, config.host, () => {
      const addr = server.address() as unknown as { port: number } | string | null;
      const actualPort = typeof addr === "object" && addr !== null && "port" in addr ? (addr as { port: number }).port : config.port;
      writeRuntimeState(actualPort);
      logger.info(`home-server listening`, { host: config.host, port: actualPort });
      const pairing = createPairingToken();
      const pairingUrl = pairingUrlFromConfig(actualPort, config.host, pairing);
      console.log(`\n  home-server ready on http://${config.host}:${actualPort}`);
      console.log(`  pairingUrl: ${pairingUrl}`);
      console.log(`  token: ${token.slice(0, 8)}... (use 'home-server token' to print full)`);
      console.log(`  ws: ws://${config.host}:${actualPort}/ws?token=<token>`);
      console.log(`  health: http://${config.host}:${actualPort}/health\n`);

      // tailscale serve (like t3code:300:apps/server/src/server.ts:559)
      if (config.tailscaleServeEnabled) {
        tailscale
          .tryEnsureTailscaleServe({ localPort: actualPort, servePort: config.tailscaleServePort })
          .then((ok) => {
            if (ok) logger.info("Tailscale Serve configured", { localPort: actualPort, servePort: config.tailscaleServePort });
          });
      }

      resolve();
    });
    server.on("error", reject);
  });

  // graceful shutdown — matches t3code lifecycle (clear runtime, disable tailscale)
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    clearRuntimeState();
    await terminalManager.shutdown().catch(() => {});
    await serviceManager.shutdown().catch(() => {});
    await tunnelService.shutdown().catch(() => {});
    server.close(() => {
      logger.info("home-server stopped");
      process.exit(0);
    });
    // force after 5s
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
