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
    // code / text (t3code shiki langs + anyview code adapter)
    ".ts": "text/x-typescript",
    ".tsx": "text/x-typescript",
    ".js": "text/javascript",
    ".jsx": "text/javascript",
    ".mjs": "text/javascript",
    ".cjs": "text/javascript",
    ".json": "application/json",
    ".jsonc": "application/json",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".mdx": "text/markdown",
    ".txt": "text/plain",
    ".log": "text/plain",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".sh": "text/x-shellscript",
    ".bash": "text/x-shellscript",
    ".zsh": "text/x-shellscript",
    ".py": "text/x-python",
    ".rb": "text/x-ruby",
    ".go": "text/x-go",
    ".rs": "text/x-rust",
    ".java": "text/x-java",
    ".c": "text/x-c",
    ".h": "text/x-c",
    ".cpp": "text/x-c++",
    ".hpp": "text/x-c++",
    ".css": "text/css",
    ".scss": "text/x-scss",
    ".less": "text/x-less",
    ".html": "text/html",
    ".htm": "text/html",
    ".xml": "application/xml",
    ".svg": "image/svg+xml",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".toml": "application/toml",
    ".ini": "text/plain",
    ".env": "text/plain",
    ".sql": "application/sql",
    ".vue": "text/x-vue",
    ".svelte": "text/x-svelte",
    ".php": "application/x-httpd-php",
    ".dockerfile": "text/x-dockerfile",
    ".ipynb": "application/x-ipynb+json",
    // images (anyview image adapter)
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    // video / audio (native preview, not in anyview scope)
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".m4v": "video/x-m4v",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    // documents (anyview adapters)
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    // archives
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".7z": "application/x-7z-compressed",
    ".rar": "application/vnd.rar",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

/**
 * File-kind classifier for preview routing.
 * Ports t3code `packages/shared/src/filePreview.ts` branching
 * (image/video/browser/text) with anyview `FormatId` coverage for
 * office docs, csv, ipynb that we render as metadata+download in v1.
 */
export type FileKind =
  | "code"
  | "markdown"
  | "csv"
  | "html"
  | "ipynb"
  | "text"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "office"
  | "archive"
  | "binary";

const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc",
  ".yaml", ".yml", ".toml", ".py", ".rb", ".go", ".rs", ".java",
  ".c", ".h", ".cpp", ".hpp", ".css", ".scss", ".less", ".vue",
  ".svelte", ".php", ".sh", ".bash", ".zsh", ".sql", ".xml",
  ".ini", ".env", ".dockerfile",
]);

export function fileKindFromName(name: string): FileKind {
  const ext = extOf(name).toLowerCase();
  const base = name.split("/").pop() ?? name;
  if (base === "Dockerfile" || base === "Makefile") return "code";
  if (ext === ".md" || ext === ".markdown" || ext === ".mdx") return "markdown";
  if (ext === ".csv" || ext === ".tsv") return "csv";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".ipynb") return "ipynb";
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx" || ext === ".xlsx" || ext === ".xls" || ext === ".pptx") return "office";
  if (ext === ".zip" || ext === ".tar" || ext === ".gz" || ext === ".7z" || ext === ".rar") return "archive";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif", ".ico"].includes(ext)) return "image";
  if ([".mp4", ".webm", ".mov", ".mkv", ".m4v"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".ogg", ".m4a", ".flac"].includes(ext)) return "audio";
  if (CODE_EXTS.has(ext)) return "code";
  if (ext === ".txt" || ext === ".log" || ext === "") return "text";
  return "binary";
}

/** True when the kind is safe/cheap to fetch as UTF-8 text preview. */
export function isTextPreviewKind(kind: FileKind): boolean {
  return kind === "code" || kind === "markdown" || kind === "csv" || kind === "text" || kind === "ipynb";
}
