import express from "express";
import cors from "cors";
import * as fs from "node:fs";
import { verifyToken, createPairingToken, consumePairingToken, pairingUrlFromConfig } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import { logger } from "./logger.ts";
import type { SystemService } from "./services/system.ts";
import type { FilesystemService } from "./services/filesystem.ts";

export function createHttpApp(opts: {
  config: ServerConfig;
  token: string;
  systemService: SystemService;
  filesystemService: FilesystemService;
}): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  // health (no auth)
  app.get("/health", (_req, res) => res.json({ ok: true, version: "0.1.0" }));

  // well-known for tailscale probe
  app.get("/.well-known/home-server", (_req, res) => res.json({ ok: true, name: "home-server" }));

  // pairing flow (like t3code pair)
  app.get("/pair", (req, res) => {
    const token = req.query.token as string | undefined;
    if (!token || !consumePairingToken(token)) {
      return res.status(401).json({ error: "invalid or expired pairing token" });
    }
    return res.json({ token: opts.token });
  });

  // auth middleware for /api/*
  app.use("/api", (req, res, next) => {
    const hdr = req.headers.authorization as string | undefined;
    const qToken = req.query.token as string | undefined;
    const provided = hdr ?? (qToken ? `Bearer ${qToken}` : undefined);
    if (!verifyToken(provided, opts.token)) {
      return res.status(401).json({ error: { code: "unauthorized", message: "Invalid token" } });
    }
    next();
  });

  // REST mirrors of WS RPC for easy curl testing
  app.post("/api/filesystem/browse", async (req, res) => {
    try {
      const result = await opts.filesystemService.browse(req.body ?? {});
      res.json(result);
    } catch (e: any) {
      res.status(400).json({ error: { code: e.code ?? "unknown", message: e.message } });
    }
  });

  app.get("/api/system/stats", async (req, res) => {
    try {
      const stats = await opts.systemService.getStats({ diskPaths: req.query.disks ? String(req.query.disks).split(",") : undefined });
      res.json(stats);
    } catch (e: any) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  app.get("/api/server/info", (_req, res) => {
    res.json({
      name: "home-server",
      version: "0.1.0",
      uptimeSeconds: Math.floor(process.uptime()),
      port: opts.config.port,
      host: opts.config.host,
      baseDir: opts.config.baseDir,
      tailscaleServeEnabled: opts.config.tailscaleServeEnabled,
    });
  });

  app.post("/api/pairing/create", (req, res) => {
    // requires auth
    const hdr = req.headers.authorization as string | undefined;
    if (!verifyToken(hdr, opts.token)) return res.status(401).json({ error: "unauthorized" });
    const pairing = createPairingToken();
    const url = pairingUrlFromConfig(opts.config.port, opts.config.host, pairing);
    res.json({ pairingToken: pairing, pairingUrl: url });
  });

  // fallback
  app.use((req, res) => res.status(404).json({ error: "not found", path: req.path }));

  return app;
}
