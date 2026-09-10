import { z } from "zod";

/**
 * Filesystem browse input — mirrors t3code filesystemBrowse but enriched with
 * metadata for NAS use (size, mtime, type). Extensible: add `includeHidden`,
 * `limit` etc. without breaking wire compat.
 */
export const FilesystemBrowseInput = z.object({
  /** Absolute or relative path to browse. Empty => cwd or HOME. */
  path: z.string().max(1024).optional().default(""),
  /** Base cwd for resolving relative `path` */
  cwd: z.string().max(1024).optional(),
  /** Whether to include dotfiles */
  includeHidden: z.boolean().optional().default(false),
  /** Max entries to return (pagination) */
  limit: z.number().int().min(1).max(5000).optional(),
  /** Offset for pagination */
  offset: z.number().int().min(0).optional().default(0),
});
export type FilesystemBrowseInput = z.infer<typeof FilesystemBrowseInput>;

export const FilesystemEntry = z.object({
  name: z.string(),
  fullPath: z.string(),
  isDirectory: z.boolean(),
  isFile: z.boolean(),
  isSymlink: z.boolean(),
  size: z.number().int().nonnegative(), // bytes, 0 for dirs
  mtimeMs: z.number(),
  extension: z.string(), // "" for dirs, ".ts" etc.
  mimeHint: z.string().optional(), // "text/x-typescript" best-effort
});
export type FilesystemEntry = z.infer<typeof FilesystemEntry>;

export const FilesystemBrowseResult = z.object({
  /** Resolved absolute parent path that was listed */
  parentPath: z.string(),
  /** Entries sorted dirs-first then alpha */
  entries: z.array(FilesystemEntry),
  totalCount: z.number().int().nonnegative(),
  /** Whether more entries exist beyond limit */
  hasMore: z.boolean(),
});
export type FilesystemBrowseResult = z.infer<typeof FilesystemBrowseResult>;

export const FilesystemBrowseErrorCode = z.enum([
  "not_found",
  "not_directory",
  "permission_denied",
  "too_many_entries",
  "invalid_path",
  "already_exists",
  "not_empty",
  "is_binary",
  "too_large",
  "unknown",
]);
export type FilesystemBrowseErrorCode = z.infer<typeof FilesystemBrowseErrorCode>;

/** Single-path input shared by stat/read/delete. */
export const FilesystemPathInput = z.object({
  path: z.string().min(1).max(4096),
  cwd: z.string().max(1024).optional(),
});
export type FilesystemPathInput = z.infer<typeof FilesystemPathInput>;

/**
 * Detailed stat — extends the browse entry with ownership/timestamps.
 * Mirrors NAS file managers (size/type/mtime) plus POSIX extras.
 */
export const FilesystemStatResult = z.object({
  name: z.string(),
  fullPath: z.string(),
  parentPath: z.string(),
  isDirectory: z.boolean(),
  isFile: z.boolean(),
  isSymlink: z.boolean(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  birthtimeMs: z.number(),
  ctimeMs: z.number(),
  mode: z.number().int().nonnegative(),
  extension: z.string(),
  mimeHint: z.string(),
  isHidden: z.boolean(),
});
export type FilesystemStatResult = z.infer<typeof FilesystemStatResult>;

/**
 * Text preview — t3code `projects.readFile` port.
 * Server reads at most `maxBytes` (default 1 MiB, like t3code's
 * PROJECT_READ_FILE_MAX_BYTES), rejects NUL-byte binaries with
 * `isBinary: true` and empty content, sets `truncated` when the
 * file is larger than what was returned.
 */
export const FilesystemReadInput = z.object({
  path: z.string().min(1).max(4096),
  cwd: z.string().max(1024).optional(),
  maxBytes: z.number().int().min(1).max(4 * 1024 * 1024).optional(),
  offset: z.number().int().min(0).optional().default(0),
});
export type FilesystemReadInput = z.infer<typeof FilesystemReadInput>;

export const FilesystemReadResult = z.object({
  path: z.string(),
  fullPath: z.string(),
  size: z.number().int().nonnegative(),
  byteLength: z.number().int().nonnegative(),
  truncated: z.boolean(),
  isBinary: z.boolean(),
  content: z.string(),
  mtimeMs: z.number(),
  extension: z.string(),
  mimeHint: z.string(),
});
export type FilesystemReadResult = z.infer<typeof FilesystemReadResult>;

export const FilesystemMkdirInput = z.object({
  path: z.string().min(1).max(4096),
  cwd: z.string().max(1024).optional(),
});
export type FilesystemMkdirInput = z.infer<typeof FilesystemMkdirInput>;

export const FilesystemMkdirResult = z.object({
  fullPath: z.string(),
});
export type FilesystemMkdirResult = z.infer<typeof FilesystemMkdirResult>;

export const FilesystemRenameInput = z.object({
  from: z.string().min(1).max(4096),
  to: z.string().min(1).max(4096),
  cwd: z.string().max(1024).optional(),
  overwrite: z.boolean().optional().default(false),
});
export type FilesystemRenameInput = z.infer<typeof FilesystemRenameInput>;

export const FilesystemRenameResult = z.object({
  from: z.string(),
  to: z.string(),
});
export type FilesystemRenameResult = z.infer<typeof FilesystemRenameResult>;

export const FilesystemDeleteInput = z.object({
  path: z.string().min(1).max(4096),
  cwd: z.string().max(1024).optional(),
  /** Required to delete a non-empty directory (NAS safety guard). */
  recursive: z.boolean().optional().default(false),
});
export type FilesystemDeleteInput = z.infer<typeof FilesystemDeleteInput>;

export const FilesystemDeleteResult = z.object({
  path: z.string(),
});
export type FilesystemDeleteResult = z.infer<typeof FilesystemDeleteResult>;
