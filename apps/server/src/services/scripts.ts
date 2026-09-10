import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { ScriptDefinition, ScriptRun, ScriptEvent } from "@home-server/contracts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ScriptNotFoundError extends Schema.TaggedError<ScriptNotFoundError>()(
  "ScriptNotFoundError",
  { id: Schema.String, cause: Schema.optional(Schema.Defect) },
) {
  get message() {
    return `Unknown script: ${this.id}`;
  }
}

export class ScriptInvalidIdError extends Schema.TaggedError<ScriptInvalidIdError>()(
  "ScriptInvalidIdError",
  { id: Schema.String },
) {
  get message() {
    return `Invalid script id: ${this.id}`;
  }
}

export class ScriptRunNotFoundError extends Schema.TaggedError<ScriptRunNotFoundError>()(
  "ScriptRunNotFoundError",
  { runId: Schema.String },
) {
  get message() {
    return `Unknown run: ${this.runId}`;
  }
}

export class ScriptKillFailedError extends Schema.TaggedError<ScriptKillFailedError>()(
  "ScriptKillFailedError",
  { runId: Schema.String, cause: Schema.optional(Schema.Defect) },
) {
  get message() {
    return `Failed to kill ${this.runId}`;
  }
}

export type ScriptError =
  | ScriptNotFoundError
  | ScriptInvalidIdError
  | ScriptRunNotFoundError
  | ScriptKillFailedError;

// ---------------------------------------------------------------------------
// Driver abstraction
// ---------------------------------------------------------------------------

export interface ScriptDriver {
  run(def: ScriptDefinition, runId: string, logsPath: string): Promise<ChildProcess>;
}

class ShellDriver implements ScriptDriver {
  async run(def: ScriptDefinition, _runId: string, _logsPath: string): Promise<ChildProcess> {
    const cwd = def.cwd ?? process.cwd();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    if (def.env) Object.assign(env, def.env);
    return spawn(def.command, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

export class ScriptServiceTag extends Context.Tag("home-server/ScriptService")<
  ScriptServiceTag,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<ScriptDefinition>>;
    readonly get: (id: string) => Effect.Effect<ScriptDefinition, ScriptNotFoundError>;
    readonly upsert: (
      input: Omit<ScriptDefinition, "createdAt" | "updatedAt"> & { id?: string },
    ) => Effect.Effect<ScriptDefinition, ScriptInvalidIdError>;
    readonly delete: (id: string) => Effect.Effect<void, ScriptNotFoundError>;
    readonly runScript: (id: string) => Effect.Effect<ScriptRun, ScriptNotFoundError>;
    readonly stop: (runId: string) => Effect.Effect<void, ScriptRunNotFoundError | ScriptKillFailedError>;
    readonly getRun: (runId: string) => Effect.Effect<ScriptRun, ScriptRunNotFoundError>;
    readonly readLogs: (runId: string, tailLines?: number) => Effect.Effect<string, ScriptRunNotFoundError>;
    readonly listRuns: () => Effect.Effect<ReadonlyArray<ScriptRun>>;
    readonly onEvent: (listener: (ev: ScriptEvent) => void) => Effect.Effect<() => void>;
  }
>() {}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

function isValidScriptId(id: string): boolean {
  return /^[a-z0-9_-]+$/.test(id);
}

// ---------------------------------------------------------------------------
// Implementation — Effect-backed class (keeps `new ScriptService()` working)
// ---------------------------------------------------------------------------

export class ScriptService {
  private defs = new Map<string, ScriptDefinition>();
  private runs = new Map<string, ScriptRun>();
  private children = new Map<string, ChildProcess>();
  private listeners = new Set<(ev: ScriptEvent) => void>();

  constructor(
    private readonly scriptsPath: string,
    private readonly logsBase: string,
    private readonly driver: ScriptDriver = new ShellDriver(),
  ) {
    this.logsBase = path.join(logsBase, "scripts");
  }

  async init(): Promise<void> {
    await Effect.runPromise(
      Effect.gen(this, function* () {
        yield* Effect.tryPromise({
          try: () => fsp.mkdir(path.dirname(this.scriptsPath), { recursive: true }),
          catch: (cause) => cause as unknown,
        }).pipe(Effect.orElseSucceed(() => undefined));
        yield* Effect.tryPromise({
          try: () => fsp.mkdir(this.logsBase, { recursive: true }),
          catch: (cause) => cause as unknown,
        }).pipe(Effect.orElseSucceed(() => undefined));
        const raw = yield* Effect.tryPromise({
          try: () => fsp.readFile(this.scriptsPath, "utf8"),
          catch: (cause) => cause as unknown,
        }).pipe(
          Effect.catchAll((cause) => {
            const code = (cause as NodeJS.ErrnoException)?.code;
            if (code === "ENOENT") return Effect.succeed(null as string | null);
            return Effect.succeed(null as string | null);
          }),
        );
        if (raw) {
          try {
            const arr = JSON.parse(raw) as ScriptDefinition[];
            for (const d of arr) this.defs.set(d.id, d);
          } catch {}
        }
      }),
    );
  }

  private persistEffect(): Effect.Effect<void, never> {
    return Effect.tryPromise({
      try: () => fsp.writeFile(this.scriptsPath, JSON.stringify([...this.defs.values()], null, 2) + "\n", "utf8"),
      catch: () => undefined as void,
    }).pipe(Effect.orElseSucceed(() => undefined));
  }

  private async persist(): Promise<void> {
    await Effect.runPromise(this.persistEffect());
  }

  onEvent(listener: (ev: ScriptEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEventEffect(listener: (ev: ScriptEvent) => void): Effect.Effect<() => void> {
    return Effect.sync(() => this.onEvent(listener));
  }

  private emit(ev: ScriptEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {}
    }
  }

  // ---- Effect-native methods ----

  listEffect(): Effect.Effect<ReadonlyArray<ScriptDefinition>> {
    return Effect.succeed([...this.defs.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }

  getEffect(id: string): Effect.Effect<ScriptDefinition, ScriptNotFoundError> {
    const def = this.defs.get(id);
    return def
      ? Effect.succeed(def)
      : Effect.fail(new ScriptNotFoundError({ id }));
  }

  upsertEffect(
    input: {
      id?: string;
      name: string;
      command: string;
      description?: string;
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      isService?: boolean;
      cron?: string;
    },
  ): Effect.Effect<ScriptDefinition, ScriptInvalidIdError> {
    return Effect.gen(this, function* () {
      const id = input.id ?? `scr_${crypto.randomBytes(4).toString("hex")}`;
      if (!isValidScriptId(id)) return yield* Effect.fail(new ScriptInvalidIdError({ id }));
      const now = new Date().toISOString();
      const existing = this.defs.get(id);
      const def: ScriptDefinition = {
        id,
        name: input.name,
        description: input.description ?? "",
        command: input.command,
        cwd: input.cwd,
        env: input.env,
        timeoutMs: input.timeoutMs,
        isService: input.isService ?? false,
        cron: input.cron,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      this.defs.set(id, def);
      yield* this.persistEffect();
      return def;
    });
  }

  deleteEffect(id: string): Effect.Effect<void, ScriptNotFoundError> {
    return Effect.gen(this, function* () {
      if (!this.defs.has(id)) return yield* Effect.fail(new ScriptNotFoundError({ id }));
      this.defs.delete(id);
      yield* this.persistEffect();
    });
  }

  runScriptEffect(id: string): Effect.Effect<ScriptRun, ScriptNotFoundError> {
    return Effect.gen(this, function* () {
      const def = this.defs.get(id);
      if (!def) return yield* Effect.fail(new ScriptNotFoundError({ id }));
      const runId = `run_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
      const logsPath = path.join(this.logsBase, `${runId}.log`);
      const run: ScriptRun = {
        runId,
        scriptId: id,
        status: "running",
        pid: null,
        exitCode: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        logsPath,
      };
      this.runs.set(runId, run);
      yield* Effect.tryPromise({
        try: () => fsp.writeFile(logsPath, `# ${def.name} — ${def.command}\n# run ${runId} at ${run.startedAt}\n`, "utf8"),
        catch: () => undefined as void,
      }).pipe(Effect.orElseSucceed(() => undefined));

      const child = yield* Effect.tryPromise({
        try: () => this.driver.run(def, runId, logsPath),
        catch: (cause) => cause as unknown,
      }).pipe(Effect.orDie);

      run.pid = child.pid ?? null;
      this.children.set(runId, child);
      this.emit({ type: "started", run: { ...run } });

      const logStream = fs.createWriteStream(logsPath, { flags: "a" });
      child.stdout?.on("data", (d: Buffer) => {
        const data = d.toString("utf8");
        logStream.write(data);
        this.emit({ type: "output", runId, scriptId: id, data });
      });
      child.stderr?.on("data", (d: Buffer) => {
        const data = d.toString("utf8");
        logStream.write(data);
        this.emit({ type: "output", runId, scriptId: id, data });
      });

      let timeout: NodeJS.Timeout | undefined;
      if (def.timeoutMs) {
        timeout = setTimeout(() => {
          if (child.pid) {
            try {
              child.kill("SIGTERM");
            } catch {}
          }
        }, def.timeoutMs);
      }

      child.on("close", (code, signal) => {
        if (timeout) clearTimeout(timeout);
        logStream.end();
        const finished: ScriptRun = {
          ...run,
          status: signal ? "killed" : code === 0 ? "success" : "error",
          exitCode: code,
          finishedAt: new Date().toISOString(),
        };
        this.runs.set(runId, finished);
        this.children.delete(runId);
        this.emit({ type: "finished", run: { ...finished } });
      });
      child.on("error", (err: Error) => {
        if (timeout) clearTimeout(timeout);
        logStream.end();
        const finished: ScriptRun = {
          ...run,
          status: "error",
          exitCode: null,
          finishedAt: new Date().toISOString(),
        };
        this.runs.set(runId, finished);
        this.children.delete(runId);
        this.emit({ type: "error", runId, scriptId: id, message: err.message });
      });

      return { ...run };
    });
  }

  stopEffect(runId: string): Effect.Effect<void, ScriptRunNotFoundError | ScriptKillFailedError> {
    return Effect.gen(this, function* () {
      const child = this.children.get(runId);
      if (!child) return yield* Effect.fail(new ScriptRunNotFoundError({ runId }));
      yield* Effect.try({
        try: () => {
          child.kill("SIGTERM");
          setTimeout(() => {
            try {
              if (child.pid) child.kill("SIGKILL");
            } catch {}
          }, 1500).unref();
        },
        catch: (cause) => new ScriptKillFailedError({ runId, cause }),
      });
    });
  }

  getRunEffect(runId: string): Effect.Effect<ScriptRun, ScriptRunNotFoundError> {
    const run = this.runs.get(runId);
    return run ? Effect.succeed(run) : Effect.fail(new ScriptRunNotFoundError({ runId }));
  }

  readLogsEffect(runId: string, tailLines = 200): Effect.Effect<string, ScriptRunNotFoundError> {
    return Effect.gen(this, function* () {
      const run = this.runs.get(runId);
      if (!run?.logsPath) return yield* Effect.fail(new ScriptRunNotFoundError({ runId }));
      const content = yield* Effect.tryPromise({
        try: () => fsp.readFile(run.logsPath!, "utf8"),
        catch: (cause) => cause as unknown,
      }).pipe(
        Effect.catchAll((cause) => {
          const code = (cause as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") return Effect.succeed("");
          return Effect.fail(cause as unknown as ScriptRunNotFoundError);
        }),
      );
      if (typeof content !== "string") return "";
      const lines = content.split("\n");
      if (lines.length <= tailLines) return content;
      return lines.slice(lines.length - tailLines).join("\n");
    });
  }

  listRunsEffect(): Effect.Effect<ReadonlyArray<ScriptRun>> {
    return Effect.succeed([...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
  }

  // ---- Legacy Promise wrappers (keep existing handlers working) ----

  list(): ScriptDefinition[] {
    return [...this.defs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  get(id: string): ScriptDefinition | undefined {
    return this.defs.get(id);
  }
  async upsert(
    input: Parameters<ScriptService["upsertEffect"]>[0],
  ): Promise<ScriptDefinition> {
    return Effect.runPromise(this.upsertEffect(input));
  }
  async delete(id: string): Promise<void> {
    return Effect.runPromise(this.deleteEffect(id).pipe(Effect.catchAll((e) => Effect.fail(Object.assign(new Error(e.message), { code: "not_found" })))));
  }
  async runScript(id: string): Promise<ScriptRun> {
    return Effect.runPromise(this.runScriptEffect(id).pipe(Effect.catchAll((e) => Effect.fail(Object.assign(new Error(e.message), { code: "not_found" })))));
  }
  async stop(runId: string): Promise<void> {
    return Effect.runPromise(this.stopEffect(runId).pipe(Effect.catchAll((e) => Effect.fail(Object.assign(new Error(e.message), { code: e._tag === "ScriptRunNotFoundError" ? "not_found" : "kill_failed" })))));
  }
  getRun(runId: string): ScriptRun | undefined {
    return this.runs.get(runId);
  }
  async readLogs(runId: string, tailLines = 200): Promise<string> {
    return Effect.runPromise(this.readLogsEffect(runId, tailLines).pipe(Effect.catchAll((e) => Effect.fail(Object.assign(new Error(e.message), { code: "not_found" })))));
  }
  listRuns(): ScriptRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}

export const ScriptServiceLive = Layer.succeed(
  ScriptServiceTag,
  ScriptServiceTag.of({
    list: () => Effect.succeed([]),
    get: () => Effect.fail(new ScriptNotFoundError({ id: "noop" })),
    upsert: () => Effect.fail(new ScriptInvalidIdError({ id: "noop" })),
    delete: () => Effect.succeed(undefined),
    runScript: () => Effect.fail(new ScriptNotFoundError({ id: "noop" })),
    stop: () => Effect.succeed(undefined),
    getRun: () => Effect.fail(new ScriptRunNotFoundError({ runId: "noop" })),
    readLogs: () => Effect.succeed(""),
    listRuns: () => Effect.succeed([]),
    onEvent: () => Effect.succeed(() => {}),
  }),
);
