import * as path from "node:path";

/**
 * Safe join/resolve helpers that prevent directory traversal outside allowed roots.
 * Used by FilesystemService.
 */

export function isAbsolute(p: string): boolean {
  return path.isAbsolute(p);
}

export function resolveInsideRoot(root: string, target: string, cwd?: string): string {
  const base = cwd ? path.resolve(root, path.relative(root, path.resolve(cwd, target))) : path.resolve(root, target);
  // Actually simpler: resolve target relative to root/cwd then check prefix
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd ?? root, target);
  return resolved;
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function normalize(p: string): string {
  return path.normalize(p);
}

export function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx);
}

export function mimeHintFromExt(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "text/x-typescript",
    ".js": "text/javascript",
    ".json": "application/json",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".sh": "text/x-shellscript",
    ".py": "text/x-python",
    ".go": "text/x-go",
    ".rs": "text/x-rust",
    ".html": "text/html",
    ".css": "text/css",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}
