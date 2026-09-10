import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { mimeHintFromExt, extOf } from "@home-server/shared/path";
import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemEntry,
  FilesystemPathInput,
  FilesystemStatResult,
  FilesystemReadInput,
  FilesystemReadResult,
  FilesystemMkdirInput,
  FilesystemMkdirResult,
  FilesystemRenameInput,
  FilesystemRenameResult,
  FilesystemDeleteInput,
  FilesystemDeleteResult,
} from "@home-server/contracts";

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

export class FilesystemAlreadyExistsError extends Schema.TaggedError<FilesystemAlreadyExistsError>()(
  "FilesystemAlreadyExistsError",
  { path: Schema.String },
) {
  get message() {
    return `Already exists: ${this.path}`;
  }
}

export class FilesystemNotEmptyError extends Schema.TaggedError<FilesystemNotEmptyError>()(
  "FilesystemNotEmptyError",
  { path: Schema.String },
) {
  get message() {
    return `Directory not empty: ${this.path} (pass recursive:true)`;
  }
}

export class FilesystemInvalidPathError extends Schema.TaggedError<FilesystemInvalidPathError>()(
  "FilesystemInvalidPathError",
  {
    path: Schema.String,
    reason: Schema.optional(Schema.String),
  },
) {
  get message() {
    return `Invalid path: ${this.path}${this.reason ? ` (${this.reason})` : ""}`;
  }
}

export type FilesystemError =
  | FilesystemNotFoundError
  | FilesystemNotDirectoryError
  | FilesystemPermissionDeniedError
  | FilesystemWindowsPathUnsupportedError
  | FilesystemUnknownError
  | FilesystemAlreadyExistsError
  | FilesystemNotEmptyError
  | FilesystemInvalidPathError;

// ---------------------------------------------------------------------------
// Effect service tag — for DI where desired
// ---------------------------------------------------------------------------

export class FilesystemServiceTag extends Context.Tag("home-server/FilesystemService")<
  FilesystemServiceTag,
  {
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, FilesystemError>;
    readonly stat: (input: FilesystemPathInput) => Effect.Effect<FilesystemStatResult, FilesystemError>;
    readonly readFile: (input: FilesystemReadInput) => Effect.Effect<FilesystemReadResult, FilesystemError>;
    readonly mkdir: (input: FilesystemMkdirInput) => Effect.Effect<FilesystemMkdirResult, FilesystemError>;
    readonly rename: (input: FilesystemRenameInput) => Effect.Effect<FilesystemRenameResult, FilesystemError>;
    readonly remove: (input: FilesystemDeleteInput) => Effect.Effect<FilesystemDeleteResult, FilesystemError>;
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

/**
 * Error surfaced to RPC/HTTP callers. A real subclass (not
 * `Object.assign(new Error, …)`) so `code` survives `Effect.runPromise`,
 * which rejects with a `FiberFailure` wrapper that drops ad-hoc props.
 */
export class FilesystemRpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FilesystemRpcError";
    this.code = code;
  }
}

/** Max bytes returned by a single readFile call (t3code parity: 1 MiB). */
export const FILE_READ_MAX_BYTES = 1_000_000;

function failCode(e: FilesystemError): string {
  switch (e._tag) {
    case "FilesystemNotFoundError":
      return "not_found";
    case "FilesystemNotDirectoryError":
      return "not_directory";
    case "FilesystemPermissionDeniedError":
      return "permission_denied";
    case "FilesystemWindowsPathUnsupportedError":
      return "windows_path_unsupported";
    case "FilesystemAlreadyExistsError":
      return "already_exists";
    case "FilesystemNotEmptyError":
      return "not_empty";
    case "FilesystemInvalidPathError":
      return "invalid_path";
    default:
      return "unknown";
  }
}

function toErrno(e: unknown, target: string): FilesystemError {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return new FilesystemNotFoundError({ path: target, cause: e });
  if (code === "EACCES" || code === "EPERM") return new FilesystemPermissionDeniedError({ path: target, cause: e });
  if (code === "EEXIST") return new FilesystemAlreadyExistsError({ path: target });
  if (code === "ENOTEMPTY" || code === "EEXIST") return new FilesystemNotEmptyError({ path: target });
  if (code === "ENOTDIR") return new FilesystemNotDirectoryError({ path: target });
  return new FilesystemUnknownError({ path: target, cause: e });
}

/** Resolve a user-supplied path against cwd/home. Exported for HTTP handlers. */
export function resolveUserPath(rawPath: string, cwd: string | undefined): string {
  const home = os.homedir();
  return resolveTarget(rawPath ?? "", cwd, home);
}

function guardWindowsPath(rawPath: string): Effect.Effect<void, FilesystemError> {
  if (process.platform !== "win32" && /^[a-zA-Z]:[\\/]/.test(rawPath.trim())) {
    return Effect.fail(new FilesystemWindowsPathUnsupportedError({ path: rawPath }));
  }
  return Effect.void;
}

function statEffectInternal(input: FilesystemPathInput): Effect.Effect<FilesystemStatResult, FilesystemError> {
  return Effect.gen(function* () {
    const rawPath = (input.path ?? "").trim();
    if (!rawPath) return yield* Effect.fail(new FilesystemInvalidPathError({ path: input.path ?? "", reason: "empty" }));
    yield* guardWindowsPath(rawPath);
    const target = resolveTarget(rawPath, (input.cwd ?? "").trim() || undefined, os.homedir());
    const lstat = yield* Effect.tryPromise({
      try: () => fsp.lstat(target),
      catch: (cause) => toErrno(cause, target),
    });
    const isSymlink = lstat.isSymbolicLink();
    let stat: fs.Stats = lstat;
    if (isSymlink) {
      const followed = yield* Effect.tryPromise({
        try: () => fsp.stat(target),
        catch: (cause) => toErrno(cause, target),
      });
      stat = followed;
    }
    const isDirectory = stat.isDirectory();
    const isFile = stat.isFile();
    const name = path.basename(target);
    const ext = isDirectory ? "" : extOf(name);
    return {
      name,
      fullPath: target,
      parentPath: path.dirname(target),
      isDirectory,
      isFile,
      isSymlink,
      size: isFile ? stat.size : 0,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs,
      ctimeMs: stat.ctimeMs,
      mode: stat.mode,
      extension: ext,
      mimeHint: ext ? mimeHintFromExt(ext) : isDirectory ? "inode/directory" : "application/octet-stream",
      isHidden: name.startsWith("."),
    };
  });
}

function readFileEffectInternal(input: FilesystemReadInput): Effect.Effect<FilesystemReadResult, FilesystemError> {
  return Effect.gen(function* () {
    const rawPath = (input.path ?? "").trim();
    if (!rawPath) return yield* Effect.fail(new FilesystemInvalidPathError({ path: input.path ?? "", reason: "empty" }));
    yield* guardWindowsPath(rawPath);
    const target = resolveTarget(rawPath, (input.cwd ?? "").trim() || undefined, os.homedir());
    const stat = yield* Effect.tryPromise({
      try: () => fsp.stat(target),
      catch: (cause) => toErrno(cause, target),
    });
    if (stat.isDirectory()) return yield* Effect.fail(new FilesystemNotDirectoryError({ path: target }));
    if (!stat.isFile()) return yield* Effect.fail(new FilesystemNotDirectoryError({ path: target }));
    const maxBytes = input.maxBytes ?? FILE_READ_MAX_BYTES;
    const offset = input.offset ?? 0;
    if (offset >= stat.size) {
      const name = path.basename(target);
      const ext = extOf(name);
      return {
        path: target,
        fullPath: target,
        size: stat.size,
        byteLength: 0,
        truncated: false,
        isBinary: false,
        content: "",
        mtimeMs: stat.mtimeMs,
        extension: ext,
        mimeHint: ext ? mimeHintFromExt(ext) : "application/octet-stream",
      };
    }
    const toRead = Math.min(maxBytes, stat.size - offset, 4 * 1024 * 1024);
    const fh = yield* Effect.tryPromise({
      try: () => fsp.open(target, "r"),
      catch: (cause) => toErrno(cause, target),
    });
    try {
      const buf = Buffer.alloc(toRead);
      const { bytesRead } = yield* Effect.tryPromise({
        try: () => fh.read(buf, 0, toRead, offset),
        catch: (cause) => toErrno(cause, target),
      });
      const slice = buf.subarray(0, bytesRead);
      const name = path.basename(target);
      const ext = extOf(name);
      // t3code parity: NUL byte => binary, return metadata only
      if (slice.includes(0)) {
        return {
          path: target,
          fullPath: target,
          size: stat.size,
          byteLength: bytesRead,
          truncated: offset + bytesRead < stat.size,
          isBinary: true,
          content: "",
          mtimeMs: stat.mtimeMs,
          extension: ext,
          mimeHint: ext ? mimeHintFromExt(ext) : "application/octet-stream",
        };
      }
      return {
        path: target,
        fullPath: target,
        size: stat.size,
        byteLength: bytesRead,
        truncated: offset + bytesRead < stat.size,
        isBinary: false,
        content: slice.toString("utf8"),
        mtimeMs: stat.mtimeMs,
        extension: ext,
        mimeHint: ext ? mimeHintFromExt(ext) : "application/octet-stream",
      };
    } finally {
      yield* Effect.tryPromise({ try: () => fh.close(), catch: () => undefined }).pipe(
        Effect.orElseSucceed(() => undefined),
      );
    }
  });
}

function mkdirEffectInternal(input: FilesystemMkdirInput): Effect.Effect<FilesystemMkdirResult, FilesystemError> {
  return Effect.gen(function* () {
    const rawPath = (input.path ?? "").trim();
    if (!rawPath) return yield* Effect.fail(new FilesystemInvalidPathError({ path: input.path ?? "", reason: "empty" }));
    yield* guardWindowsPath(rawPath);
    const target = resolveTarget(rawPath, (input.cwd ?? "").trim() || undefined, os.homedir());
    yield* Effect.tryPromise({
      try: () => fsp.mkdir(target, { recursive: true }),
      catch: (cause) => toErrno(cause, target),
    });
    return { fullPath: target };
  });
}

function renameEffectInternal(input: FilesystemRenameInput): Effect.Effect<FilesystemRenameResult, FilesystemError> {
  return Effect.gen(function* () {
    const fromRaw = (input.from ?? "").trim();
    const toRaw = (input.to ?? "").trim();
    if (!fromRaw || !toRaw) {
      return yield* Effect.fail(new FilesystemInvalidPathError({ path: !fromRaw ? input.from : input.to, reason: "empty" }));
    }
    yield* guardWindowsPath(fromRaw);
    yield* guardWindowsPath(toRaw);
    const cwd = (input.cwd ?? "").trim() || undefined;
    const home = os.homedir();
    const from = resolveTarget(fromRaw, cwd, home);
    const to = resolveTarget(toRaw, cwd, home);
    if (from === to) return { from, to };
    yield* Effect.tryPromise({
      try: () => fsp.stat(from),
      catch: (cause) => toErrno(cause, from),
    });
    if (!input.overwrite) {
      const exists = yield* Effect.tryPromise({
        try: () =>
          fsp.stat(to).then(
            () => true as const,
            (e: unknown) => {
              if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return false as const;
              throw e;
            },
          ),
        catch: (cause) => toErrno(cause, to),
      }).pipe(
        Effect.catchAll((cause) =>
          (cause as unknown as NodeJS.ErrnoException)?.code === "ENOENT"
            ? Effect.succeed(false as const)
            : Effect.fail(toErrno(cause, to)),
        ),
      );
      if (exists) return yield* Effect.fail(new FilesystemAlreadyExistsError({ path: to }));
    }
    yield* Effect.tryPromise({
      try: async () => {
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.rename(from, to);
      },
      catch: (cause) => toErrno(cause, to),
    });
    return { from, to };
  });
}

function deleteEffectInternal(input: FilesystemDeleteInput): Effect.Effect<FilesystemDeleteResult, FilesystemError> {
  return Effect.gen(function* () {
    const rawPath = (input.path ?? "").trim();
    if (!rawPath) return yield* Effect.fail(new FilesystemInvalidPathError({ path: input.path ?? "", reason: "empty" }));
    yield* guardWindowsPath(rawPath);
    const target = resolveTarget(rawPath, (input.cwd ?? "").trim() || undefined, os.homedir());
    const home = os.homedir();
    if (target === "/" || target === home || target === path.dirname(home)) {
      return yield* Effect.fail(new FilesystemInvalidPathError({ path: target, reason: "refusing to delete root/home" }));
    }
    const stat = yield* Effect.tryPromise({
      try: () => fsp.lstat(target),
      catch: (cause) => toErrno(cause, target),
    });
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      if (!input.recursive) {
        const names = yield* Effect.tryPromise({
          try: () => fsp.readdir(target),
          catch: (cause) => toErrno(cause, target),
        });
        if (names.length > 0) return yield* Effect.fail(new FilesystemNotEmptyError({ path: target }));
        yield* Effect.tryPromise({
          try: () => fsp.rmdir(target),
          catch: (cause) => toErrno(cause, target),
        });
      } else {
        yield* Effect.tryPromise({
          try: () => fsp.rm(target, { recursive: true, force: false }),
          catch: (cause) => toErrno(cause, target),
        });
      }
    } else {
      yield* Effect.tryPromise({
        try: () => fsp.unlink(target),
        catch: (cause) => toErrno(cause, target),
      });
    }
    return { path: target };
  });
}

export const FilesystemServiceLive = Layer.succeed(
  FilesystemServiceTag,
  FilesystemServiceTag.of({
    browse: browseEffectInternal,
    stat: statEffectInternal,
    readFile: readFileEffectInternal,
    mkdir: mkdirEffectInternal,
    rename: renameEffectInternal,
    remove: deleteEffectInternal,
  }),
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

  statEffect(input: FilesystemPathInput): Effect.Effect<FilesystemStatResult, FilesystemError> {
    return statEffectInternal(input);
  }

  readFileEffect(input: FilesystemReadInput): Effect.Effect<FilesystemReadResult, FilesystemError> {
    return readFileEffectInternal(input);
  }

  mkdirEffect(input: FilesystemMkdirInput): Effect.Effect<FilesystemMkdirResult, FilesystemError> {
    return mkdirEffectInternal(input);
  }

  renameEffect(input: FilesystemRenameInput): Effect.Effect<FilesystemRenameResult, FilesystemError> {
    return renameEffectInternal(input);
  }

  removeEffect(input: FilesystemDeleteInput): Effect.Effect<FilesystemDeleteResult, FilesystemError> {
    return deleteEffectInternal(input);
  }

  private async run<E, A>(effect: Effect.Effect<A, E>): Promise<A> {
    // NOTE: go through `Either`, not `catchAll`+`runPromise` — runPromise
    // rejects with a FiberFailure that drops ad-hoc `code` props, so error
    // codes never reached callers (always "unknown").
    const either = await Effect.runPromise(Effect.either(effect));
    if (either._tag === "Right") return either.right;
    const e = either.left as unknown as { _tag?: string; message?: string; cause?: unknown };
    const code = e && typeof e === "object" && "_tag" in e ? failCode(e as unknown as FilesystemError) : "unknown";
    throw new FilesystemRpcError(code, e?.message ?? "filesystem error", { cause: e?.cause });
  }

  /** Promise wrapper for existing callers (http, rpc handlers) */
  async browse(input: FilesystemBrowseInput): Promise<FilesystemBrowseResult> {
    return this.run(this.browseEffect(input));
  }

  async stat(input: FilesystemPathInput): Promise<FilesystemStatResult> {
    return this.run(this.statEffect(input));
  }

  async readFile(input: FilesystemReadInput): Promise<FilesystemReadResult> {
    return this.run(this.readFileEffect(input));
  }

  async mkdir(input: FilesystemMkdirInput): Promise<FilesystemMkdirResult> {
    return this.run(this.mkdirEffect(input));
  }

  /** Backwards-compat alias for the v1 stub name. */
  async createFolder(input: FilesystemMkdirInput): Promise<FilesystemMkdirResult> {
    return this.mkdir(input);
  }

  async rename(input: FilesystemRenameInput): Promise<FilesystemRenameResult> {
    return this.run(this.renameEffect(input));
  }

  async remove(input: FilesystemDeleteInput): Promise<FilesystemDeleteResult> {
    return this.run(this.removeEffect(input));
  }

  async search(): Promise<FilesystemEntry[]> {
    return Promise.reject(Object.assign(new Error("search not implemented"), { code: "not_implemented" }));
  }

  /**
   * Write a file atomically (used by HTTP upload). Creates parent dirs,
   * refuses to overwrite directories.
   */
  async writeFile(targetPath: string, data: Buffer): Promise<FilesystemStatResult> {
    const target = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(os.homedir(), targetPath);
    try {
      const existing = await fsp.stat(target).catch(() => null);
      if (existing?.isDirectory()) {
        throw Object.assign(new Error(`Not a file: ${target}`), { code: "not_directory" });
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, data);
      return this.stat({ path: target });
    } catch (e) {
      const err = e as { code?: string };
      if (err.code && ["not_found", "not_directory", "permission_denied", "invalid_path"].includes(err.code)) throw e;
      throw Object.assign(new Error((e as Error).message ?? String(e)), {
        code: (e as { code?: string }).code ?? "unknown",
      });
    }
  }
}
