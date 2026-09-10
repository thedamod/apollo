import * as NodeModule from "node:module";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { HostProcessArchitecture, HostProcessPlatform } from "@home-server/shared/hostProcess";

import * as PtyAdapter from "./ptyAdapter.ts";

export class NodePtyModuleLoadError extends Schema.TaggedError<NodePtyModuleLoadError>()(
  "NodePtyModuleLoadError",
  {
    platform: Schema.String,
    architecture: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  get message(): string {
    return `Failed to load node-pty for ${this.platform}-${this.architecture}.`;
  }
}

type NodePtyModuleLoader = () => Promise<typeof import("node-pty")>;

let didEnsureSpawnHelperExecutable = false;

const resolveNodePtySpawnHelperPath = Effect.gen(function* () {
  const requireForNodePty = NodeModule.createRequire(import.meta.url);
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const candidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${platform}-${architecture}`, "spawn-helper"),
  ];

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}).pipe(Effect.orElseSucceed(() => null));

const ensureNodePtySpawnHelperExecutable = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  if (platform === "win32") return;
  if (didEnsureSpawnHelperExecutable) return;

  const helperPath = yield* resolveNodePtySpawnHelperPath;
  if (!helperPath) return;
  didEnsureSpawnHelperExecutable = true;

  if (!(yield* fs.exists(helperPath))) {
    return;
  }

  // Best-effort: avoid FileSystem.stat in packaged mode where some fs metadata can be missing.
  yield* fs.chmod(helperPath, 0o755).pipe(Effect.orElseSucceed(() => undefined));
});

class NodePtyProcess implements PtyAdapter.PtyProcess {
  private readonly process: import("node-pty").IPty;

  constructor(process: import("node-pty").IPty) {
    this.process = process;
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.process.kill(signal);
  }

  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData(callback);
    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    const disposable = this.process.onExit((event) => {
      callback({
        exitCode: event.exitCode,
        signal: event.signal ?? null,
      });
    });
    return () => {
      disposable.dispose();
    };
  }
}

export const make = Effect.fn("NodePtyAdapter.make")(function* (
  loadNodePtyModule: NodePtyModuleLoader = () => import("node-pty"),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;

  const nodePty = yield* Effect.tryPromise({
    try: loadNodePtyModule,
    catch: (cause) =>
      new NodePtyModuleLoadError({
        platform,
        architecture,
        cause,
      }),
  }).pipe(Effect.orDie);

  const ensureNodePtySpawnHelperExecutableCached = yield* Effect.cached(
    ensureNodePtySpawnHelperExecutable().pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcessPlatform, platform),
      Effect.provideService(HostProcessArchitecture, architecture),
      Effect.orElseSucceed(() => undefined),
    ),
  );

  return PtyAdapter.PtyAdapter.of({
    spawn: Effect.fn("NodePtyAdapter.spawn")(function* (input) {
      yield* ensureNodePtySpawnHelperExecutableCached;
      // node-pty only writes `name` into the child's TERM on the Unix path;
      // the ConPTY path leaves the environment untouched, so Windows children
      // inherit a missing or 16-color TERM unless it is set here.
      const env =
        platform === "win32" && input.env["TERM"] === undefined
          ? { ...input.env, TERM: "xterm-256color" }
          : input.env;
      const ptyProcess = yield* Effect.try({
        try: () =>
          nodePty.spawn(input.shell, input.args ?? [], {
            cwd: input.cwd,
            cols: input.cols,
            rows: input.rows,
            env,
            name: "xterm-256color",
          }),
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "node-pty",
            shell: input.shell,
            cause,
          }),
      });
      return new NodePtyProcess(ptyProcess);
    }),
  });
});

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make());

// ---------------------------------------------------------------------------
// Fake adapter — in-memory implementation for tests / dev without native binding.
// Mirrors the Effect service contract; no `any`, no global `let pty: any = null`.
// ---------------------------------------------------------------------------

class FakePtyProcess implements PtyAdapter.PtyProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private readonly pidValue: number;
  private readonly shell: string;

  constructor(shell: string) {
    this.shell = shell;
    this.pidValue = 10000 + Math.floor(Math.random() * 50000);
    queueMicrotask(() => {
      for (const cb of this.dataListeners) {
        cb(`\r\n$ ${this.shell} (fake pty ${this.pidValue})\r\n`);
      }
    });
  }

  get pid(): number {
    return this.pidValue;
  }

  write(data: string): void {
    for (const cb of this.dataListeners) {
      cb(data);
    }
    if (data.includes("exit")) {
      queueMicrotask(() => {
        for (const cb of this.exitListeners) {
          cb({ exitCode: 0, signal: null });
        }
      });
      return;
    }
    if (data.trim().length > 0) {
      const cmd = data.replace(/\r/g, "").trim();
      if (cmd.length > 0) {
        queueMicrotask(() => {
          for (const cb of this.dataListeners) {
            cb(`\r\n[fake output for: ${cmd}]\r\n$ `);
          }
        });
      }
    }
  }

  resize(): void {}

  kill(): void {
    queueMicrotask(() => {
      for (const cb of this.exitListeners) {
        cb({ exitCode: 0, signal: 9 });
      }
    });
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }
}

export const makeFake = Effect.fn("FakePtyAdapter.make")(function* () {
  return PtyAdapter.PtyAdapter.of({
    spawn: (input) =>
      Effect.succeed(new FakePtyProcess(input.shell) as PtyAdapter.PtyProcess),
  });
});

export const layerFake = Layer.effect(PtyAdapter.PtyAdapter, makeFake());

// Legacy compatibility classes — prefer `layer` / `layerFake` + Effect.
// Kept only for incremental migration of TerminalManager (which still uses
// synchronous injection). These classes implement a sync `spawn` returning
// `PtyProcess` directly and are typed without `any`.

export class NodePtyAdapterSync implements PtyAdapter.PtyAdapterSync {
  private readonly nodePty: typeof import("node-pty");

  constructor(nodePty: typeof import("node-pty")) {
    this.nodePty = nodePty;
  }

  spawn(input: PtyAdapter.PtySpawnInput): PtyAdapter.PtyProcess {
    const env =
      process.platform === "win32" && input.env["TERM"] === undefined
        ? { ...input.env, TERM: "xterm-256color" }
        : input.env;
    const proc = this.nodePty.spawn(input.shell, input.args ?? [], {
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      env,
      name: "xterm-256color",
    });
    return new NodePtyProcess(proc);
  }
}

export class FakePtyAdapterSync implements PtyAdapter.PtyAdapterSync {
  spawn(input: PtyAdapter.PtySpawnInput): PtyAdapter.PtyProcess {
    return new FakePtyProcess(input.shell);
  }
}

/** @deprecated Prefer `layer` / `layerFake` with Effect. Kept for TerminalManager migration. */
export function createPtyAdapter(): PtyAdapter.PtyAdapterSync {
  try {
    const require = NodeModule.createRequire(import.meta.url);
    const nodePty = require("node-pty") as typeof import("node-pty");
    return new NodePtyAdapterSync(nodePty);
  } catch {
    console.warn("[pty] node-pty not available, using FakePtyAdapter (tests/dev)");
    return new FakePtyAdapterSync();
  }
}

// Back-compat aliases for existing tests importing the old class names
export const FakePtyAdapter = FakePtyAdapterSync;
export const NodePtyAdapter = NodePtyAdapterSync;
