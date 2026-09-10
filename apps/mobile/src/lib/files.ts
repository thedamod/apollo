/**
 * File-explorer helpers for the mobile app.
 *
 * RN-safe port of the classification in `@home-server/shared/path`
 * (`fileKindFromName`, `isTextPreviewKind`) — shared/path imports
 * `node:path` so it can't be bundled by Metro. Keep the two in sync.
 *
 * Preview routing mirrors t3code
 * (`context/t3code/apps/web/src/components/files/FilePreviewPanel.tsx`:
 * image/video bypass the text RPC and stream over HTTP, everything else
 * goes through `readFile` with a 1 MiB truncation banner) with anyview
 * (`context/anyview/packages/viewer/src/core/format-detect.ts`) format
 * coverage for the metadata we display per type.
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

export interface ExplorerEntry {
  name: string;
  fullPath: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  mtimeMs: number;
  extension: string;
  mimeHint?: string;
}

export interface FileStat extends ExplorerEntry {
  parentPath: string;
  birthtimeMs: number;
  ctimeMs: number;
  mode: number;
  isHidden: boolean;
}

export interface TextPreview {
  fullPath: string;
  size: number;
  byteLength: number;
  truncated: boolean;
  isBinary: boolean;
  content: string;
  mtimeMs: number;
  extension: string;
  mimeHint: string;
}

export function extOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const idx = base.lastIndexOf(".");
  if (idx <= 0) return "";
  return base.slice(idx);
}

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

/** Kinds cheap to fetch as UTF-8 text through `filesystem.readFile`. */
export function isTextPreviewKind(kind: FileKind): boolean {
  return kind === "code" || kind === "markdown" || kind === "csv" || kind === "text" || kind === "ipynb";
}

/** Kinds rendered natively in-app (no OS handoff needed). */
export function isNativePreviewKind(kind: FileKind): boolean {
  return isTextPreviewKind(kind) || kind === "image" || kind === "video" || kind === "audio";
}

export function kindLabel(kind: FileKind, isDirectory: boolean): string {
  if (isDirectory) return "Folder";
  switch (kind) {
    case "code":
      return "Code";
    case "markdown":
      return "Markdown";
    case "csv":
      return "Spreadsheet (CSV)";
    case "html":
      return "Web page";
    case "ipynb":
      return "Notebook";
    case "text":
      return "Text";
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "pdf":
      return "PDF";
    case "office":
      return "Office document";
    case "archive":
      return "Archive";
    default:
      return "File";
  }
}

export function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

export function parentOf(p: string): string {
  const trimmed = p.replace(/\/$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx) || "/";
}

/** Last path segment. */
export function baseName(p: string): string {
  const trimmed = p.replace(/\/$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function stripTrailingSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Authed HTTP URLs for the file transfer endpoints
 * (`apps/server/src/http.ts`). Token rides the query string because
 * RN `Image` can't set headers (video/image preview). `fetch`-based
 * callers should prefer the `Authorization: Bearer` header instead.
 */
export function previewUrl(baseUrl: string, token: string, fullPath: string): string {
  return `${stripTrailingSlash(baseUrl)}/api/files/preview?path=${encodeURIComponent(fullPath)}&token=${encodeURIComponent(token)}`;
}

export function downloadUrl(baseUrl: string, token: string, fullPath: string): string {
  return `${stripTrailingSlash(baseUrl)}/api/files/download?path=${encodeURIComponent(fullPath)}&token=${encodeURIComponent(token)}`;
}

export function uploadUrl(baseUrl: string, dirPath: string, filename: string): string {
  return `${stripTrailingSlash(baseUrl)}/api/files/upload?path=${encodeURIComponent(dirPath)}&filename=${encodeURIComponent(filename)}`;
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Make a remote name safe for the local cache dir. */
export function safeLocalName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+/, "");
  return clean || "download";
}
