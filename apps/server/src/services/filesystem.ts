import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { mimeHintFromExt, extOf } from "@home-server/shared/path";
import type { FilesystemBrowseInput, FilesystemBrowseResult, FilesystemEntry } from "@home-server/contracts";

/**
 * FilesystemService — NAS browse primitive.
 * Traversing only for v1; upload/download/rename/delete are stubbed as
 * extensible methods that throw "not_implemented" until wired.
 *
 * Security: no chroot by default, but rejects Windows paths on non-win32
 * (mirrors t3code filesystem.ts: windows_path_unsupported). Resolves relative
 * paths against cwd/HOME.
 */
export class FilesystemService {
  constructor(private readonly allowedRoots?: string[]) {}

  async browse(input: FilesystemBrowseInput): Promise<FilesystemBrowseResult> {
    const rawPath = (input.path ?? "").trim();
    const cwd = (input.cwd ?? "").trim();

    // windows_path_unsupported guard
    if (process.platform !== "win32" && /^[a-zA-Z]:[\\/]/.test(rawPath)) {
      throw Object.assign(new Error("Windows paths unsupported on this platform"), {
        code: "windows_path_unsupported",
      });
    }

    const home = os.homedir();
    let target: string;
    if (!rawPath) {
      target = cwd ? path.resolve(cwd) : home;
    } else if (path.isAbsolute(rawPath)) {
      target = path.resolve(rawPath);
    } else {
      const base = cwd ? path.resolve(cwd) : home;
      target = path.resolve(base, rawPath);
    }

    // If target points to a file, browse its parent (like t3code partialPath behavior)
    let stat: fs.Stats | null = null;
    try {
      stat = await fsp.stat(target);
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        // try partial: treat as prefix search — browse parent and filter
        const parent = path.dirname(target);
        try {
          const parentStat = await fsp.stat(parent);
          if (!parentStat.isDirectory()) throw e;
          // fall through to parent browse with prefix filter
          return this.listDir(parent, {
            includeHidden: input.includeHidden ?? false,
            limit: input.limit,
            offset: input.offset ?? 0,
            prefix: path.basename(target).toLowerCase(),
          });
        } catch {
          throw Object.assign(new Error(`Path not found: ${target}`), { code: "not_found", parentPath: parent });
        }
      }
      throw Object.assign(new Error(`Failed to stat ${target}: ${e.message}`), { code: "unknown", cause: e });
    }

    if (stat.isFile() || stat.isSymbolicLink()) {
      const parent = path.dirname(target);
      return this.listDir(parent, {
        includeHidden: input.includeHidden ?? false,
        limit: input.limit,
        offset: input.offset ?? 0,
      });
    }
    if (!stat.isDirectory()) {
      throw Object.assign(new Error(`Not a directory: ${target}`), { code: "not_directory" });
    }

    return this.listDir(target, {
      includeHidden: input.includeHidden ?? false,
      limit: input.limit,
      offset: input.offset ?? 0,
    });
  }

  private async listDir(
    dir: string,
    opts: { includeHidden: boolean; limit?: number; offset: number; prefix?: string },
  ): Promise<FilesystemBrowseResult> {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch (e: any) {
      const code = e?.code === "EACCES" ? "permission_denied" : "unknown";
      throw Object.assign(new Error(`Failed to read directory ${dir}: ${e.message}`), { code, parentPath: dir });
    }

    let filtered = names;
    if (!opts.includeHidden) filtered = filtered.filter((n) => !n.startsWith("."));
    if (opts.prefix) filtered = filtered.filter((n) => n.toLowerCase().startsWith(opts.prefix!));

    // sort dirs first then alpha (need stats — do bounded concurrency)
    const entries: FilesystemEntry[] = [];
    for (const name of filtered) {
      const fullPath = path.join(dir, name);
      try {
        const s = await fsp.lstat(fullPath);
        const isSymlink = s.isSymbolicLink();
        let realStat = s;
        let isDir = s.isDirectory();
        let isFile = s.isFile();
        // follow symlink for type
        if (isSymlink) {
          try {
            realStat = await fsp.stat(fullPath);
            isDir = realStat.isDirectory();
            isFile = realStat.isFile();
          } catch {}
        }
        const ext = isDir ? "" : extOf(name);
        entries.push({
          name,
          fullPath,
          isDirectory: isDir,
          isFile,
          isSymlink,
          size: isFile ? realStat.size : 0,
          mtimeMs: realStat.mtimeMs,
          extension: ext,
          mimeHint: ext ? mimeHintFromExt(ext) : undefined,
        });
      } catch {
        // skip unreadable entries
      }
    }

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const totalCount = entries.length;
    const limit = opts.limit ?? totalCount;
    const sliced = entries.slice(opts.offset, opts.offset + limit);
    const hasMore = opts.offset + limit < totalCount;

    return {
      parentPath: dir,
      entries: sliced,
      totalCount,
      hasMore,
    };
  }

  // --- extensible stubs (NAS full feature surface, not yet wired) ---
  async createFolder(_dir: string, _name: string): Promise<void> {
    throw Object.assign(new Error("createFolder not implemented in v1 — extend FilesystemService"), {
      code: "not_implemented",
    });
  }
  async rename(_oldPath: string, _newPath: string): Promise<void> {
    throw Object.assign(new Error("rename not implemented in v1"), { code: "not_implemented" });
  }
  async remove(_target: string): Promise<void> {
    throw Object.assign(new Error("remove not implemented in v1"), { code: "not_implemented" });
  }
  async search(_root: string, _query: string): Promise<FilesystemEntry[]> {
    throw Object.assign(new Error("search not implemented in v1"), { code: "not_implemented" });
  }
}
