import express from "express";
import cors from "cors";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { mimeHintFromExt, extOf } from "@home-server/shared/path";
import { resolveUserPath } from "./services/filesystem.ts";
import { verifyToken, createPairingToken, consumePairingToken, getPairingTokenFromUrl, pairingUrlFromConfig } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import { getWebDavShares } from "./config.ts";
import { createWebDavRouter, ensureWebDavShareDirs } from "./webdav.ts";
import { logger } from "./logger.ts";
import type { SystemService } from "./services/system.ts";
import type { FilesystemService } from "./services/filesystem.ts";
import type { ScriptService } from "./services/scripts.ts";

export function createHttpApp(opts: {
  config: ServerConfig;
  token: string;
  systemService: SystemService;
  filesystemService: FilesystemService;
  scriptService?: ScriptService;
}): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  // health (no auth)
  app.get("/health", (_req, res) => res.json({ ok: true, version: "0.1.0" }));

  // well-known for tailscale probe
  app.get("/.well-known/home-server", (_req, res) => res.json({ ok: true, name: "home-server" }));

  // pairing flow (like t3code pair — token in hash #token=..., client extracts and sends as ?token=)
  app.get("/pair", (req, res) => {
    // Accept token from query (?token=), hash-derived query, or X-Pairing-Token header.
    // Also parse full URL hash if client sent pairing URL as redirect.
    let token = (req.query.token as string | undefined)?.trim();
    if (!token) {
      const raw = req.headers["x-pairing-token"] as string | undefined;
      if (raw?.trim()) token = raw.trim();
    }
    if (!token) {
      // fallback: try to extract from Referer or raw url hash (if client did fetch(pairingUrl) the hash is stripped, so we handle both)
      try {
        const full = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
        token = getPairingTokenFromUrl(new URL(full)) ?? undefined;
      } catch {}
    }
    if (!token || !consumePairingToken(token)) {
      return res.status(401).json({ error: "invalid or expired pairing token" });
    }
    return res.json({ token: opts.token });
  });

  // WebDAV mount (additive view over FilesystemService, same token auth).
  // No new port: served on the existing HTTP(S) listener behind Tailscale.
  const davShares = getWebDavShares();
  ensureWebDavShareDirs(davShares);
  app.use(
    "/dav",
    createWebDavRouter({ token: opts.token, filesystemService: opts.filesystemService, getShares: getWebDavShares }),
  );

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
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      res.status(statusForCode(err.code)).json({ error: { code: err.code ?? "unknown", message: err.message ?? String(e) } });
    }
  });

  app.post("/api/filesystem/stat", async (req, res) => {
    try {
      res.json(await opts.filesystemService.stat(req.body ?? {}));
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      res.status(statusForCode(err.code)).json({ error: { code: err.code ?? "unknown", message: err.message ?? String(e) } });
    }
  });

  app.post("/api/filesystem/read", async (req, res) => {
    try {
      res.json(await opts.filesystemService.readFile(req.body ?? {}));
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      res.status(statusForCode(err.code)).json({ error: { code: err.code ?? "unknown", message: err.message ?? String(e) } });
    }
  });

  app.post("/api/filesystem/mkdir", async (req, res) => {
    try {
      res.json(await opts.filesystemService.mkdir(req.body ?? {}));
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      res.status(statusForCode(err.code)).json({ error: { code: err.code ?? "unknown", message: err.message ?? String(e) } });
    }
  });

  app.post("/api/filesystem/rename", async (req, res) => {
    try {
      res.json(await opts.filesystemService.rename(req.body ?? {}));
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      res.status(statusForCode(err.code)).json({ error: { code: err.code ?? "unknown", message: err.message ?? String(e) } });
    }
  });

  app.post("/api/filesystem/delete", async (req, res) => {
    try {
      res.json(await opts.filesystemService.remove(req.body ?? {}));
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      res.status(statusForCode(err.code)).json({ error: { code: err.code ?? "unknown", message: err.message ?? String(e) } });
    }
  });

  // Binary download (attachment) + inline preview (t3code signed-asset style).
  // Both support Range requests so video/audio seekers work.
  app.get("/api/files/download", async (req, res) => {
    try {
      const target = resolveUserPath(String(req.query.path ?? ""), optQuery(req.query.cwd));
      await sendFile(req, res, target, "attachment");
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      if (!res.headersSent) res.status(statusForCode(err.code)).json({ error: { code: err.code ?? "unknown", message: err.message ?? String(e) } });
    }
  });

  app.get("/api/files/preview", async (req, res) => {
    try {
      const target = resolveUserPath(String(req.query.path ?? ""), optQuery(req.query.cwd));
      await sendFile(req, res, target, "inline");
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      if (!res.headersSent) res.status(statusForCode(err.code)).json({ error: { code: err.code ?? "unknown", message: err.message ?? String(e) } });
    }
  });

  // Raw-binary upload: POST /api/files/upload?path=<dir-or-file>&filename=<name>
  // Body is the file bytes (Content-Type: application/octet-stream). Also
  // accepts JSON { content: <base64>, filename } for small text uploads.
  app.post("/api/files/upload", express.raw({ type: "*/*", limit: "200mb" }), async (req, res) => {
    try {
      const cwd = optQuery(req.query.cwd);
      const dirOrFile = String(req.query.path ?? "");
      if (!dirOrFile.trim()) {
        res.status(400).json({ error: { code: "invalid_path", message: "query ?path= is required" } });
        return;
      }
      let filename = optQuery(req.query.filename) ?? (req.headers["x-filename"] as string | undefined);
      let data: Buffer;
      const ctype = String(req.headers["content-type"] ?? "");
      if (ctype.includes("application/json")) {
        const body = (req.body as unknown as { content?: string; filename?: string }) ?? {};
        const raw = typeof body === "string" ? body : (body.content ?? "");
        if (!raw) {
          res.status(400).json({ error: { code: "invalid_path", message: "JSON body needs { content: <base64|utf8> }" } });
          return;
        }
        data = Buffer.from(raw, "base64");
        // if base64 round-trip looks wrong, fall back to utf8
        if (data.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "").replace(/\s/g, "")) {
          data = Buffer.from(raw, "utf8");
        }
        filename = filename ?? body.filename;
      } else {
        data = Buffer.isBuffer(req.body) ? req.body : Buffer.from((req.body as unknown as string) ?? "", "binary");
      }
      let target = resolveUserPath(dirOrFile, cwd);
      try {
        const st = await fsp.stat(target);
        if (st.isDirectory()) {
          if (!filename?.trim()) {
            res.status(400).json({ error: { code: "invalid_path", message: "target is a directory — pass ?filename= or X-Filename" } });
            return;
          }
          target = path.join(target, path.basename(filename.trim()));
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        // target doesn't exist: if it has no extension and no filename given,
        // treat it as a directory path (mkdir -p happens in writeFile anyway
        // for the parent, so just use it as the file path).
        if (!filename?.trim() && !path.extname(target)) {
          res.status(400).json({ error: { code: "invalid_path", message: "pass ?filename= or a full file ?path=" } });
          return;
        }
        if (filename?.trim() && !path.extname(path.basename(target))) {
          target = path.join(target, path.basename(filename.trim()));
        }
      }
      if (!data || data.length === 0) {
        res.status(400).json({ error: { code: "invalid_path", message: "empty upload body" } });
        return;
      }
      const stat = await opts.filesystemService.writeFile(target, data);
      res.json(stat);
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      res.status(statusForCode(err.code)).json({ error: { code: err.code ?? "unknown", message: err.message ?? String(e) } });
    }
  });

  app.get("/api/system/stats", async (req, res) => {
    try {
      const stats = await opts.systemService.getStats({ diskPaths: req.query.disks ? String(req.query.disks).split(",") : undefined });
      res.json(stats);
    } catch (e: unknown) {
      res.status(500).json({ error: { message: (e as Error).message ?? String(e) } });
    }
  });

  // Timer callback target: systemd timers POST here to trigger a script run
  // through the normal run path (history, logs, live WS output).
  app.post("/api/scripts/run", async (req, res) => {
    try {
      if (!opts.scriptService) {
        res.status(501).json({ error: { code: "not_implemented", message: "scripts unavailable" } });
        return;
      }
      const id = String((req.body as { id?: unknown } | undefined)?.id ?? "");
      if (!id.trim()) {
        res.status(400).json({ error: { code: "invalid_id", message: "body { id } is required" } });
        return;
      }
      // timer runs use defaults and never fail on missing required values
      const params = (req.body as { params?: Record<string, string | number | boolean> } | undefined)?.params;
      res.json(await opts.scriptService.runScript(id, params, { lenient: true }));
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      res.status(statusForCode(err.code)).json({ error: { code: err.code ?? "unknown", message: err.message ?? String(e) } });
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
      davEnabled: true,
      davPath: "/dav",
      davShares: davShares.map((s) => ({ name: s.name, readOnly: s.readOnly })),
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

function statusForCode(code: string | undefined): number {
  switch (code) {
    case "not_found":
      return 404;
    case "permission_denied":
      return 403;
    case "already_exists":
      return 409;
    case "not_empty":
      return 409;
    case "invalid_path":
    case "not_directory":
    case "windows_path_unsupported":
      return 400;
    default:
      return 400;
  }
}

function optQuery(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

/** Stream a file with Content-Type + Range support (video/audio/PDF seeking). */
async function sendFile(
  req: express.Request,
  res: express.Response,
  target: string,
  disposition: "inline" | "attachment",
): Promise<void> {
  if (!target || target === "/" || target === os.homedir()) {
    res.status(400).json({ error: { code: "invalid_path", message: "refusing to serve root/home" } });
    return;
  }
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    res.status(code === "ENOENT" ? 404 : 403).json({
      error: { code: code === "ENOENT" ? "not_found" : "permission_denied", message: String(e) },
    });
    return;
  }
  if (stat.isDirectory()) {
    res.status(400).json({ error: { code: "not_directory", message: `Not a file: ${target}` } });
    return;
  }
  const name = path.basename(target);
  const ext = extOf(name);
  const contentType = ext ? mimeHintFromExt(ext) : "application/octet-stream";
  const total = stat.size;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Disposition", `${disposition}; filename="${name.replace(/"/g, "")}"`);
  res.setHeader("Last-Modified", stat.mtime.toUTCString());

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : total - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < total) {
        const clampedEnd = Math.min(end, total - 1);
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${clampedEnd}/${total}`);
        res.setHeader("Content-Length", String(clampedEnd - start + 1));
        fs.createReadStream(target, { start, end: clampedEnd }).pipe(res);
        return;
      }
      res.status(416);
      res.setHeader("Content-Range", `bytes */${total}`);
      res.end();
      return;
    }
  }
  res.setHeader("Content-Length", String(total));
  fs.createReadStream(target).pipe(res);
}
