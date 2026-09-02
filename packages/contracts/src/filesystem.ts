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
  "unknown",
]);
export type FilesystemBrowseErrorCode = z.infer<typeof FilesystemBrowseErrorCode>;
