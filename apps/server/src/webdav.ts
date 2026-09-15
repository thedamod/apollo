import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import express from "express";
import { mimeHintFromExt, extOf } from "@home-server/shared/path";
import { resolveSharePath } from "./services/filesystem.ts";
import type { FilesystemService } from "./services/filesystem.ts";
import { verifyToken } from "./auth.ts";
import type { WebDavShare } from "./config.ts";
import { logger } from "./logger.ts";

/**
 * WebDAV view on top of FilesystemService — phase 1 of native mounts.
 *
 * Mounted at /dav by createHttpApp. URL mapping:
 *   /dav/               -> share listing (virtual collection)
 *   /dav/<share>/...    -> <share.path>/... via resolveSharePath
 *
 * No new FS logic: browse/stat/mkdir/rename/remove/copy all delegate to
 * FilesystemService; GET streams via fs.createReadStream (same semantics as
 * the /api/files sendFile helper: inline disposition + Accept-Ranges: bytes).
 * PROPPATCH is a 200 no-op, LOCK/UNLOCK are fake success (opaque token).
 * Symlinks are listed but never followed outside their share.
 */

export const DAV_REALM = "home server";
export const DAV_METHODS = [
  "OPTIONS",
  "GET",
  "HEAD",
  "PUT",
  "MKCOL",
  "DELETE",
  "MOVE",
  "COPY",
  "PROPFIND",
  "PROPPATCH",
  "LOCK",
  "UNLOCK",
] as const;

export function ensureWebDavShareDirs(shares: WebDavShare[]): void {
  for (const s of shares) {
    try {
      fs.mkdirSync(s.path, { recursive: true });
    } catch (e) {
      logger.warn(`[webdav] could not create share dir ${s.name}`, { error: (e as Error).message });
    }
  }
}

function unauthorized(res: express.Response): void {
  res.setHeader("WWW-Authenticate", `Basic realm="${DAV_REALM}"`);
  res.status(401).json({ error: { code: "unauthorized", message: "Valid Bearer token, Basic password, or ?token= required" } });
}

/** Bearer token, Basic (username ignored, password is the token), or ?token= fallback. */
export function verifyDavAuth(req: express.Request, expected: string): boolean {
  const hdr = req.headers.authorization as string | undefined;
  if (hdr) {
    if (hdr.startsWith("Bearer ")) return verifyToken(hdr, expected);
    if (hdr.startsWith("Basic ")) {
      try {
        const decoded = Buffer.from(hdr.slice(6).trim(), "base64").toString("utf8");
        const password = decoded.slice(decoded.indexOf(":") + 1);
        return verifyToken(password, expected);
      } catch {
        return false;
      }
    }
    return false;
  }
  const q = typeof req.query.token === "string" ? req.query.token.trim() : "";
  if (q) return verifyToken(`Bearer ${q}`, expected);
  return false;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function etagFor(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

interface DavResource {
  href: string;
  displayName: string;
  isCollection: boolean;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  contentType: string;
  etag: string;
}

function toResource(href: string, displayName: string, opts: Partial<DavResource> & { isCollection: boolean }): DavResource {
  const mtimeMs = opts.mtimeMs ?? Date.now();
  const size = opts.size ?? 0;
  return {
    href,
    displayName,
    isCollection: opts.isCollection,
    size,
    mtimeMs,
    birthtimeMs: opts.birthtimeMs ?? mtimeMs,
    contentType: opts.contentType ?? (opts.isCollection ? "httpd/unix-directory" : "application/octet-stream"),
    etag: opts.etag ?? etagFor(size, mtimeMs),
  };
}

function resourceXml(r: DavResource): string {
  const props = [
    `<D:displayname>${escapeXml(r.displayName)}</D:displayname>`,
    `<D:resourcetype>${r.isCollection ? "<D:collection/>" : ""}</D:resourcetype>`,
    `<D:getlastmodified>${new Date(r.mtimeMs).toUTCString()}</D:getlastmodified>`,
    `<D:creationdate>${new Date(r.birthtimeMs).toISOString()}</D:creationdate>`,
    `<D:getetag>${escapeXml(r.etag)}</D:getetag>`,
    `<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>`,
  ];
  if (r.isCollection) {
    props.push(`<D:getcontenttype>httpd/unix-directory</D:getcontenttype>`);
  } else {
    props.push(`<D:getcontentlength>${r.size}</D:getcontentlength>`);
    props.push(`<D:getcontenttype>${escapeXml(r.contentType)}</D:getcontenttype>`);
  }
  return (
    `<D:response><D:href>${escapeXml(r.href)}</D:href>` +
    `<D:propstat><D:prop>${props.join("")}</D:prop>` +
    `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  );
}

export function multistatusXml(resources: DavResource[]): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:multistatus xmlns:D="DAV:">${resources.map(resourceXml).join("")}</D:multistatus>`
  );
}

/** Split a router-relative path ("/media/a/b") into share + sub-path. */
function splitDavPath(rel: string): { shareName: string; subPath: string } | null {
  const trimmed = rel.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash < 0) return { shareName: trimmed, subPath: "" };
  return { shareName: trimmed.slice(0, slash), subPath: trimmed.slice(slash + 1) };
}

function davHref(shareName: string, subPath: string, isCollection: boolean): string {
  const segs = [shareName, ...subPath.split("/").filter(Boolean)].map(encodeURIComponent);
  const href = `/dav/${segs.join("/")}`;
  return isCollection ? `${href}/` : href;
}

/** Lexical + realpath confinement: the target must resolve inside the share root. */
async function confinedAbs(root: string, abs: string): Promise<boolean> {
  if (abs !== root && !abs.startsWith(root + path.sep)) return false;
  try {
    const real = await fsp.realpath(abs);
    return real === root || real.startsWith(root + path.sep);
  } catch {
    try {
      const realParent = await fsp.realpath(path.dirname(abs));
      return realParent === root || realParent.startsWith(root + path.sep);
    } catch {
      return true; // wholly new path (PUT/MKCOL create parents) — lexical check suffices
    }
  }
}

/** Parse a Destination header (absolute URL or /dav/... path) into share + sub-path. */
export function parseDestination(dest: string | undefined): { shareName: string; subPath: string } | null {
  if (!dest) return null;
  let p = dest.trim();
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
  } catch {
    return null;
  }
  p = decodeURIComponent(p);
  if (!p.startsWith("/dav/") && p !== "/dav") return null;
  return splitDavPath(p.slice(4) || "/");
}

async function readBody(req: express.Request, limit = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as string);
    total += buf.length;
    if (total > limit) throw Object.assign(new Error("request body too large"), { code: "too_large" });
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Stream a file with inline disposition + Range support (mirrors sendFile in http.ts). */
async function sendDavFile(req: express.Request, res: express.Response, target: string, stat: fs.Stats): Promise<void> {
  const name = path.basename(target);
  const ext = extOf(name);
  const contentType = ext ? mimeHintFromExt(ext) : "application/octet-stream";
  const total = stat.size;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Disposition", `inline; filename="${name.replace(/"/g, "")}"`);
  res.setHeader("Last-Modified", stat.mtime.toUTCString());
  res.setHeader("ETag", etagFor(total, stat.mtimeMs));
  if (req.method === "HEAD") {
    res.setHeader("Content-Length", String(total));
    res.status(200).end();
    return;
  }
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

export function createWebDavRouter(opts: {
  token: string;
  filesystemService: FilesystemService;
  getShares: () => WebDavShare[];
}): express.Router {
  const router = express.Router({ mergeParams: true });
  const fss = opts.filesystemService;

  router.use(async (req, res) => {
    if (!verifyDavAuth(req, opts.token)) {
      unauthorized(res);
      return;
    }
    const method = req.method.toUpperCase();
    if (method === "OPTIONS") {
      res.setHeader("DAV", "1");
      res.setHeader("Allow", DAV_METHODS.join(", "));
      res.setHeader("MS-Author-Via", "DAV");
      res.setHeader("Content-Length", "0");
      res.status(200).end();
      return;
    }
    try {
      await handleDav(req, res);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (!res.headersSent) {
        res.status(500).json({ error: { code: err.code ?? "unknown", message: err.message ?? String(e) } });
      }
    }
  });

  async function handleDav(req: express.Request, res: express.Response): Promise<void> {
    const method = req.method.toUpperCase();
    const rel = req.path || "/";
    const shares = opts.getShares();
    const byName = new Map(shares.map((s) => [s.name, s]));

    // Service root: virtual collection of shares
    if (rel === "/" || rel === "") {
      if (method === "PROPFIND") {
        const depth = (req.headers.depth as string | undefined ?? "1").trim().toLowerCase();
        if (!["0", "1", "infinity"].includes(depth)) {
          res.status(400).end();
          return;
        }
        const resources: DavResource[] = [
          toResource("/dav/", "dav", { isCollection: true }),
        ];
        if (depth !== "0") {
          for (const s of shares) {
            let mtime = Date.now();
            try {
              mtime = (await fsp.stat(s.path)).mtimeMs;
            } catch {}
            resources.push(toResource(`/dav/${encodeURIComponent(s.name)}/`, s.name, { isCollection: true, mtimeMs: mtime }));
          }
        }
        res.status(207).setHeader("Content-Type", "application/xml; charset=utf-8").send(multistatusXml(resources));
        return;
      }
      if (method === "GET" || method === "HEAD") {
        res.status(403).json({ error: { code: "permission_denied", message: "refusing to serve /dav itself as a file" } });
        return;
      }
      if (method === "PROPPATCH") {
        res.status(207).setHeader("Content-Type", "application/xml; charset=utf-8").send(multistatusXml([]));
        return;
      }
      if (method === "LOCK") return fakeLock(req, res, "/dav/");
      if (method === "UNLOCK") {
        res.status(204).end();
        return;
      }
      res.status(405).setHeader("Allow", DAV_METHODS.join(", ")).end();
      return;
    }

    const split = splitDavPath(rel);
    const share = split ? byName.get(split.shareName) : undefined;
    if (!split || !share) {
      res.status(404).json({ error: { code: "not_found", message: `No such share: ${rel}` } });
      return;
    }
    let abs: string;
    try {
      abs = resolveSharePath(share.path, split.subPath);
    } catch {
      res.status(403).json({ error: { code: "permission_denied", message: "path escapes share root" } });
      return;
    }
    const hrefBase = (sub: string, isCol: boolean) => davHref(share.name, sub, isCol);
    const relSub = split.subPath;

    switch (method) {
      case "PROPFIND": {
        const depth = ((req.headers.depth as string | undefined) ?? "infinity").trim().toLowerCase();
        if (!["0", "1", "infinity"].includes(depth)) {
          res.status(400).end();
          return;
        }
        await readBody(req).catch(() => Buffer.alloc(0)); // Finder probe body is irrelevant in v1
        const lst = await fsp.lstat(abs).catch(() => null);
        if (!lst) {
          res.status(404).json({ error: { code: "not_found", message: rel } });
          return;
        }
        const resources: DavResource[] = [await statResource(abs, relSub, hrefBase, lst, share.path)];
        if (depth !== "0" && resources[0].isCollection) {
          const kids = await collectChildren(abs, relSub, hrefBase, share.path, depth === "infinity" ? Infinity : 1, 0);
          resources.push(...kids);
        }
        res.status(207).setHeader("Content-Type", "application/xml; charset=utf-8").send(multistatusXml(resources));
        return;
      }
      case "GET":
      case "HEAD": {
        const lst = await fsp.lstat(abs).catch(() => null);
        if (!lst) {
          res.status(404).json({ error: { code: "not_found", message: rel } });
          return;
        }
        if (lst.isDirectory() && !lst.isSymbolicLink()) {
          res.status(403).json({ error: { code: "permission_denied", message: `refusing to serve collection as a file: ${rel}` } });
          return;
        }
        if (!(await confinedAbs(share.path, abs))) {
          res.status(403).json({ error: { code: "permission_denied", message: "symlink target outside share" } });
          return;
        }
        const st = await fsp.stat(abs).catch(() => null);
        if (!st || st.isDirectory()) {
          res.status(403).json({ error: { code: "permission_denied", message: `refusing to serve collection as a file: ${rel}` } });
          return;
        }
        await sendDavFile(req, res, abs, st);
        return;
      }
      case "PUT": {
        if (share.readOnly) {
          res.status(403).json({ error: { code: "permission_denied", message: `share ${share.name} is read-only` } });
          return;
        }
        const lst = await fsp.lstat(abs).catch(() => null);
        if (lst?.isDirectory() && !lst.isSymbolicLink()) {
          res.status(403).json({ error: { code: "permission_denied", message: `target is a collection: ${rel}` } });
          return;
        }
        if (!(await confinedAbs(share.path, abs))) {
          res.status(403).json({ error: { code: "permission_denied", message: "symlink target outside share" } });
          return;
        }
        const existed = !!lst;
        try {
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await pipeline(req, fs.createWriteStream(abs));
        } catch (e) {
          res.status(403).json({ error: { code: "permission_denied", message: String(e) } });
          return;
        }
        const st = await fsp.stat(abs).catch(() => null);
        if (!st) {
          res.status(403).json({ error: { code: "permission_denied", message: "write failed" } });
          return;
        }
        res.setHeader("ETag", etagFor(st.size, st.mtimeMs));
        res.status(existed ? 204 : 201).end();
        return;
      }
      case "MKCOL": {
        if (share.readOnly) {
          res.status(403).json({ error: { code: "permission_denied", message: `share ${share.name} is read-only` } });
          return;
        }
        await readBody(req).catch(() => Buffer.alloc(0)); // extended MKCOL body unsupported in v1
        const lst = await fsp.lstat(abs).catch(() => null);
        if (lst) {
          res.status(405).json({ error: { code: "already_exists", message: rel } });
          return;
        }
        try {
          await fss.mkdir({ path: abs });
        } catch (e) {
          res.status(403).json({ error: { code: "permission_denied", message: (e as Error).message } });
          return;
        }
        res.status(201).end();
        return;
      }
      case "DELETE": {
        if (share.readOnly) {
          res.status(403).json({ error: { code: "permission_denied", message: `share ${share.name} is read-only` } });
          return;
        }
        if (!(await confinedAbs(share.path, abs))) {
          res.status(403).json({ error: { code: "permission_denied", message: "symlink target outside share" } });
          return;
        }
        try {
          await fss.remove({ path: abs, recursive: true });
        } catch (e) {
          const code = (e as { code?: string }).code;
          res.status(code === "not_found" ? 404 : 403).json({ error: { code: code ?? "unknown", message: (e as Error).message } });
          return;
        }
        res.status(204).end();
        return;
      }
      case "MOVE":
      case "COPY": {
        const dest = parseDestination(req.headers.destination as string | undefined);
        const destShare = dest ? byName.get(dest.shareName) : undefined;
        if (!dest || !destShare) {
          res.status(400).json({ error: { code: "invalid_path", message: "Destination header must be a /dav/<share>/... URL" } });
          return;
        }
        if (share.readOnly || (method === "COPY" && destShare.readOnly)) {
          res.status(403).json({ error: { code: "permission_denied", message: "share is read-only" } });
          return;
        }
        if (method === "MOVE" && destShare.readOnly) {
          res.status(403).json({ error: { code: "permission_denied", message: `share ${destShare.name} is read-only` } });
          return;
        }
        let destAbs: string;
        try {
          destAbs = resolveSharePath(destShare.path, dest.subPath);
        } catch {
          res.status(403).json({ error: { code: "permission_denied", message: "destination escapes share root" } });
          return;
        }
        if (!(await confinedAbs(share.path, abs)) || !(await confinedAbs(destShare.path, destAbs))) {
          res.status(403).json({ error: { code: "permission_denied", message: "symlink target outside share" } });
          return;
        }
        const srcLst = await fsp.lstat(abs).catch(() => null);
        if (!srcLst) {
          res.status(404).json({ error: { code: "not_found", message: rel } });
          return;
        }
        const overwrite = ((req.headers.overwrite as string | undefined) ?? "T").trim().toUpperCase() !== "F";
        const destExists = await fsp.lstat(destAbs).then(() => true, () => false);
        if (destExists && !overwrite) {
          res.status(412).json({ error: { code: "precondition_failed", message: "destination exists and Overwrite: F" } });
          return;
        }
        try {
          if (method === "MOVE") {
            await fss.rename({ from: abs, to: destAbs, overwrite });
          } else {
            await fss.copy({ from: abs, to: destAbs, overwrite });
          }
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === "already_exists") {
            res.status(412).json({ error: { code: "precondition_failed", message: (e as Error).message } });
            return;
          }
          res.status(code === "not_found" ? 404 : 403).json({ error: { code: code ?? "unknown", message: (e as Error).message } });
          return;
        }
        res.status(destExists ? 204 : 201).end();
        return;
      }
      case "PROPPATCH": {
        await readBody(req).catch(() => Buffer.alloc(0)); // dead props are a no-op store in v1
        const lst = await fsp.lstat(abs).catch(() => null);
        if (!lst) {
          res.status(404).json({ error: { code: "not_found", message: rel } });
          return;
        }
        const r = await statResource(abs, relSub, hrefBase, lst, share.path);
        res
          .status(207)
          .setHeader("Content-Type", "application/xml; charset=utf-8")
          .send(
            `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">` +
              `<D:response><D:href>${escapeXml(r.href)}</D:href>` +
              `<D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat>` +
              `</D:response></D:multistatus>`,
          );
        return;
      }
      case "LOCK": {
        await readBody(req).catch(() => Buffer.alloc(0));
        const lst = await fsp.lstat(abs).catch(() => null);
        if (!lst) {
          res.status(404).json({ error: { code: "not_found", message: rel } });
          return;
        }
        return fakeLock(req, res, davHref(share.name, relSub, lst.isDirectory()));
      }
      case "UNLOCK": {
        res.status(204).end();
        return;
      }
      default: {
        res.status(405).setHeader("Allow", DAV_METHODS.join(", ")).end();
        return;
      }
    }
  }

  /** Fake exclusive write lock — v1 is single-writer, so always succeed. */
  function fakeLock(_req: express.Request, res: express.Response, href: string): void {
    const token = `opaquelocktoken:${crypto.randomUUID()}`;
    res.setHeader("Lock-Token", `<${token}>`);
    res
      .status(200)
      .setHeader("Content-Type", "application/xml; charset=utf-8")
      .send(
        `<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:">` +
          `<D:lockdiscovery><D:activelock>` +
          `<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>` +
          `<D:depth>infinity</D:depth><D:locktoken><D:href>${escapeXml(token)}</D:href></D:locktoken>` +
          `</D:activelock></D:lockdiscovery></D:prop>`,
      );
    void href;
  }

  /** lstat-based resource: symlinks listed, never followed outside the share. */
  async function statResource(
    abs: string,
    relSub: string,
    hrefBase: (sub: string, isCol: boolean) => string,
    lst: fs.Stats,
    root: string,
  ): Promise<DavResource> {
    const displayName = relSub.split("/").filter(Boolean).pop() ?? "";
    if (lst.isSymbolicLink()) {
      const inside = await confinedAbs(root, abs);
      if (!inside) {
        return toResource(hrefBase(relSub, false), displayName, {
          isCollection: false,
          size: 0,
          mtimeMs: lst.mtimeMs,
          birthtimeMs: lst.birthtimeMs,
        });
      }
      const target = await fsp.stat(abs).catch(() => null);
      if (target?.isDirectory()) {
        return toResource(hrefBase(relSub, true), displayName, {
          isCollection: true,
          mtimeMs: target.mtimeMs,
          birthtimeMs: target.birthtimeMs,
        });
      }
      const name = displayName;
      const ext = extOf(name);
      return toResource(hrefBase(relSub, false), displayName, {
        isCollection: false,
        size: target?.size ?? 0,
        mtimeMs: target?.mtimeMs ?? lst.mtimeMs,
        birthtimeMs: target?.birthtimeMs ?? lst.birthtimeMs,
        contentType: ext ? mimeHintFromExt(ext) : "application/octet-stream",
      });
    }
    if (lst.isDirectory()) {
      return toResource(hrefBase(relSub, true), displayName, {
        isCollection: true,
        mtimeMs: lst.mtimeMs,
        birthtimeMs: lst.birthtimeMs,
      });
    }
    const ext = extOf(displayName);
    return toResource(hrefBase(relSub, false), displayName, {
      isCollection: false,
      size: lst.size,
      mtimeMs: lst.mtimeMs,
      birthtimeMs: lst.birthtimeMs,
      contentType: ext ? mimeHintFromExt(ext) : "application/octet-stream",
    });
  }

  async function collectChildren(
    dirAbs: string,
    dirRel: string,
    hrefBase: (sub: string, isCol: boolean) => string,
    root: string,
    maxDepth: number,
    depth: number,
    budget = { left: 5000 },
  ): Promise<DavResource[]> {
    if (depth >= maxDepth || budget.left <= 0) return [];
    let listing: { entries: { name: string }[] };
    try {
      listing = await fss.browse({ path: dirAbs, includeHidden: true, limit: 5000 });
    } catch {
      return [];
    }
    const out: DavResource[] = [];
    for (const e of listing.entries) {
      if (budget.left-- <= 0) break;
      const childRel = dirRel ? `${dirRel}/${e.name}` : e.name;
      const childAbs = path.join(dirAbs, e.name);
      const lst = await fsp.lstat(childAbs).catch(() => null);
      if (!lst) continue;
      const r = await statResource(childAbs, childRel, hrefBase, lst, root);
      out.push(r);
      // never descend into symlinks; only real dirs, and only for infinity
      if (r.isCollection && !lst.isSymbolicLink() && maxDepth === Infinity) {
        out.push(...(await collectChildren(childAbs, childRel, hrefBase, root, maxDepth, depth + 1, budget)));
      }
    }
    return out;
  }

  return router;
}
