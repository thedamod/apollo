import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { mimeHintFromExt, extOf } from "@home-server/shared/path";
import type { FilesystemBrowseInput, FilesystemBrowseResult, FilesystemEntry } from "@home-server/contracts";

// ---------------------------------------------------------------------------
// Typed errors — no `Object.assign(new Error, {code})` in new code
// ---------------------------------------------------------------------------

export class FilesystemNotFoundError extends Schema.TaggedError<FilesystemNotFoundError>()(
  "FilesystemNotFoundError",
  {
    path: Schema.String,
    parentPath: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect),
  },
) {
  get message() {
    return `Path not found: ${this.path}`;
  }
}

export class FilesystemNotDirectoryError extends Schema.TaggedError<FilesystemNotDirectoryError>()(
  "FilesystemNotDirectoryError",
  { path: Schema.String },
) {
  get message() {
    return `Not a directory: ${this.path}`;
  }
}

export class FilesystemPermissionDeniedError extends Schema.TaggedError<FilesystemPermissionDeniedError>()(
  "FilesystemPermissionDeniedError",
  {
    path: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  get message() {
    return `Permission denied: ${this.path}`;
  }
}

export class FilesystemWindowsPathUnsupportedError extends Schema.TaggedError<FilesystemWindowsPathUnsupportedError>()(
  "FilesystemWindowsPathUnsupportedError",
  { path: Schema.String },
) {
  get message() {
    return "Windows paths unsupported on this platform";
  }
}

export class FilesystemUnknownError extends Schema.TaggedError<FilesystemUnknownError>()(
  "FilesystemUnknownError",
  {
    path: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  get message() {
    return `Failed to read ${this.path}`;
  }
}

export type FilesystemError =
  | FilesystemNotFoundError
  | FilesystemNotDirectoryError
  | FilesystemPermissionDeniedError
  | FilesystemWindowsPathUnsupportedError
  | FilesystemUnknownError;

// ---------------------------------------------------------------------------
// Effect service tag — for DI where desired
// ---------------------------------------------------------------------------

export class FilesystemServiceTag extends Context.Tag("home-server/FilesystemService")<
  FilesystemServiceTag,
  {
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, FilesystemError>;
  }
>() {}

// ---------------------------------------------------------------------------
// Core Effect implementation
// ---------------------------------------------------------------------------

function resolveTarget(rawPath: string, cwd: string | undefined, home: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) return cwd ? path.resolve(cwd) : home;
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  const base = cwd ? path.resolve(cwd) : home;
  return path.resolve(base, trimmed);
}

function listDirEffect(
  dir: string,
  opts: { includeHidden: boolean; limit?: number; offset: number; prefix?: string },
): Effect.Effect<FilesystemBrowseResult, FilesystemError> {
  return Effect.gen(function* () {
    const names = yield* Effect.tryPromise({
      try: () => fsp.readdir(dir),
      catch: (cause) => {
        const msg = String(cause);
        const code = (cause as NodeJS.ErrnoException)?.code;
        if (code === "EACCES") return new FilesystemPermissionDeniedError({ path: dir, cause });
        return new FilesystemUnknownError({ path: dir, cause });
      },
    });

    let filtered = names;
    if (!opts.includeHidden) filtered = filtered.filter((n) => !n.startsWith("."));
    if (opts.prefix) filtered = filtered.filter((n) => n.toLowerCase().startsWith(opts.prefix!));

    const entries: FilesystemEntry[] = [];
    for (const name of filtered) {
      const fullPath = path.join(dir, name);
      const lstat = yield* Effect.tryPromise({
        try: () => fsp.lstat(fullPath),
        catch: () => null as unknown as fs.Stats,
      }).pipe(Effect.orElseSucceed(() => null as unknown as fs.Stats));
      if (!lstat) continue;

      const isSymlink = lstat.isSymbolicLink();
      let stat: fs.Stats = lstat;
      let isDirectory = lstat.isDirectory();
      let isFile = lstat.isFile();
      if (isSymlink) {
        const targetStat = yield* Effect.tryPromise({
          try: () => fsp.stat(fullPath),
          catch: () => null as unknown as fs.Stats,
        }).pipe(Effect.orElseSucceed(() => null as unknown as fs.Stats));
        if (targetStat) {
          stat = targetStat;
          isDirectory = targetStat.isDirectory();
          isFile = targetStat.isFile();
        }
      }

      const ext = isDirectory ? "" : extOf(name);
      entries.push({
        name,
        fullPath,
        isDirectory,
        isFile,
        isSymlink,
        size: isFile ? stat.size : 0,
        mtimeMs: stat.mtimeMs,
        extension: ext,
        mimeHint: ext ? mimeHintFromExt(ext) : undefined,
      });
    }

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const totalCount = entries.length;
    const limit = opts.limit ?? totalCount;
    const sliced = entries.slice(opts.offset, opts.offset + limit);
    return {
      parentPath: dir,
      entries: sliced,
      totalCount,
      hasMore: opts.offset + limit < totalCount,
    };
  });
}

function browseEffectInternal(
  input: FilesystemBrowseInput,
): Effect.Effect<FilesystemBrowseResult, FilesystemError> {
  return Effect.gen(function* () {
    const rawPath = (input.path ?? "").trim();
    const cwd = (input.cwd ?? "").trim() || undefined;
    const home = os.homedir();

    if (process.platform !== "win32" && /^[a-zA-Z]:[\\/]/.test(rawPath)) {
      return yield* Effect.fail(new FilesystemWindowsPathUnsupportedError({ path: rawPath }));
    }

    const target = resolveTarget(rawPath, cwd, home);

    const stat = yield* Effect.tryPromise({
      try: () => fsp.stat(target),
      catch: (cause) => cause as unknown,
    }).pipe(
      Effect.catchAll((cause) => {
        const code = (cause as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") {
          const parent = path.dirname(target);
          return Effect.tryPromise({
            try: () => fsp.stat(parent),
            catch: (c) => c as unknown,
          }).pipe(
            Effect.flatMap((parentStat) => {
              if (!parentStat.isDirectory()) {
                return Effect.fail(new FilesystemNotFoundError({ path: target, parentPath: parent, cause }) as FilesystemError);
              }
              return listDirEffect(parent, {
                includeHidden: input.includeHidden ?? false,
                limit: input.limit,
                offset: input.offset ?? 0,
                prefix: path.basename(target).toLowerCase(),
              });
            }),
            Effect.catchAll(() => Effect.fail(new FilesystemNotFoundError({ path: target, parentPath: parent, cause }) as FilesystemError)),
            Effect.flatMap((r) => Effect.succeed(r as unknown as fs.Stats | null)),
          ) as unknown as Effect.Effect<fs.Stats | null, FilesystemError>;
        }
        return Effect.fail(new FilesystemUnknownError({ path: target, cause }) as FilesystemError);
      }),
    );

    if (stat && typeof (stat as unknown as FilesystemBrowseResult).parentPath === "string") {
      return stat as unknown as FilesystemBrowseResult;
    }
    if (!stat) return yield* Effect.fail(new FilesystemNotFoundError({ path: target }));

    if (stat.isFile() || stat.isSymbolicLink()) {
      const parent = path.dirname(target);
      return yield* listDirEffect(parent, {
        includeHidden: input.includeHidden ?? false,
        limit: input.limit,
        offset: input.offset ?? 0,
      });
    }
    if (!stat.isDirectory()) return yield* Effect.fail(new FilesystemNotDirectoryError({ path: target }));

    return yield* listDirEffect(target, {
      includeHidden: input.includeHidden ?? false,
      limit: input.limit,
      offset: input.offset ?? 0,
    });
  });
}

export const FilesystemServiceLive = Layer.succeed(
  FilesystemServiceTag,
  FilesystemServiceTag.of({ browse: browseEffectInternal }),
);

// ---------------------------------------------------------------------------
// Legacy class — keeps `new FilesystemService()` working, now Effect-backed
// ---------------------------------------------------------------------------

export class FilesystemService {
  constructor(private readonly allowedRoots?: string[]) {}

  /** Effect-native browse — new code should use this */
  browseEffect(input: FilesystemBrowseInput): Effect.Effect<FilesystemBrowseResult, FilesystemError> {
    return browseEffectInternal(input);
  }

  /** Promise wrapper for existing callers (http, rpc handlers) */
  async browse(input: FilesystemBrowseInput): Promise<FilesystemBrowseResult> {
    return Effect.runPromise(
      this.browseEffect(input).pipe(
        Effect.catchAll((e) => {
          const code =
            e._tag === "FilesystemNotFoundError"
              ? "not_found"
              : e._tag === "FilesystemNotDirectoryError"
                ? "not_directory"
                : e._tag === "FilesystemPermissionDeniedError"
                  ? "permission_denied"
                  : e._tag === "FilesystemWindowsPathUnsupportedError"
                    ? "windows_path_unsupported"
                    : "unknown";
          return Effect.fail(Object.assign(new Error(e.message), { code, cause: (e as { cause?: unknown }).cause }));
        }),
      ),
    ) as Promise<FilesystemBrowseResult>;
  }

  async createFolder(): Promise<void> {
    return Promise.reject(Object.assign(new Error("createFolder not implemented in v1"), { code: "not_implemented" }));
  }
  async rename(): Promise<void> {
    return Promise.reject(Object.assign(new Error("rename not implemented"), { code: "not_implemented" }));
  }
  async remove(): Promise<void> {
    return Promise.reject(Object.assign(new Error("remove not implemented"), { code: "not_implemented" }));
  }
  async search(): Promise<FilesystemEntry[]> {
    return Promise.reject(Object.assign(new Error("search not implemented"), { code: "not_implemented" }));
  }
}
