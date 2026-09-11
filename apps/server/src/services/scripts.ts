import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import type { ScriptDefinition, ScriptRun, ScriptEvent, ScriptParam } from "@home-server/contracts";

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

export class ScriptInvalidParamsError extends Schema.TaggedError<ScriptInvalidParamsError>()(
  "ScriptInvalidParamsError",
  { id: Schema.String, issues: Schema.Array(Schema.String) },
) {
  get message() {
    return `Invalid parameters for ${this.id}: ${this.issues.join("; ")}`;
  }
}

export type ScriptError =
  | ScriptNotFoundError
  | ScriptInvalidIdError
  | ScriptRunNotFoundError
  | ScriptKillFailedError
  | ScriptInvalidParamsError;

// ---------------------------------------------------------------------------
// Driver abstraction
// ---------------------------------------------------------------------------

export interface ScriptDriver {
  run(
    def: ScriptDefinition,
    runId: string,
    logsPath: string,
    exec?: { command: string; env?: Record<string, string> },
  ): Promise<ChildProcess>;
}

/** Single-quote a value for shell substitution (`{{key}}`). */
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ResolvedScriptParams {
  /** serialized values actually used (stored on the run) */
  applied: Record<string, string | number | boolean>;
  /** command with `{{key}}` substituted (shell-escaped) */
  command: string;
  /** `PARAM_KEY` env entries for the resolved values */
  extraEnv: Record<string, string>;
}

/**
 * Validate input against the script's param schema, apply defaults, and
 * substitute `{{key}}` in the command. Lenient mode (timer runs) fills ""
 * for missing required values instead of failing.
 */
export function resolveScriptParams(
  scriptId: string,
  commandTemplate: string,
  schema: ScriptParam[] | undefined,
  input: Record<string, string | number | boolean> | undefined,
  opts?: { lenient?: boolean },
): ResolvedScriptParams {
  const params = schema ?? [];
  const issues: string[] = [];
  const applied: Record<string, string | number | boolean> = {};
  const serialized: Record<string, string> = {};
  for (const p of params) {
    const raw = input?.[p.key] ?? p.defaultValue;
    const empty = raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
    if (empty) {
      if (p.required && !opts?.lenient) issues.push(`${p.key}: required`);
      applied[p.key] = "";
      serialized[p.key] = "";
      continue;
    }
    if (p.type === "slider" || p.type === "number") {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) {
        issues.push(`${p.key}: must be a number`);
        applied[p.key] = "";
        serialized[p.key] = "";
      } else if (p.min !== undefined && n < p.min) {
        issues.push(`${p.key}: min ${p.min}`);
        applied[p.key] = n;
        serialized[p.key] = String(n);
      } else if (p.max !== undefined && n > p.max) {
        issues.push(`${p.key}: max ${p.max}`);
        applied[p.key] = n;
        serialized[p.key] = String(n);
      } else {
        applied[p.key] = n;
        serialized[p.key] = String(n);
      }
    } else if (p.type === "toggle") {
      if (typeof raw === "boolean") {
        applied[p.key] = raw;
        serialized[p.key] = raw ? "true" : "false";
      } else {
        const s = String(raw).trim().toLowerCase();
        if (["true", "1", "yes", "on"].includes(s)) {
          applied[p.key] = true;
          serialized[p.key] = "true";
        } else if (["false", "0", "no", "off"].includes(s)) {
          applied[p.key] = false;
          serialized[p.key] = "false";
        } else {
          issues.push(`${p.key}: must be true/false`);
          applied[p.key] = "";
          serialized[p.key] = "";
        }
      }
    } else if (p.type === "select") {
      const s = String(raw);
      const allowed = (p.options ?? []).map((o) => o.value);
      if (allowed.length > 0 && !allowed.includes(s)) {
        issues.push(`${p.key}: pick one of: ${allowed.join(", ")}`);
        applied[p.key] = s;
        serialized[p.key] = s;
      } else {
        applied[p.key] = s;
        serialized[p.key] = s;
      }
    } else if (p.type === "color") {
      const s = String(raw).trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(s)) {
        issues.push(`${p.key}: use #rrggbb`);
        applied[p.key] = s;
        serialized[p.key] = s;
      } else {
        applied[p.key] = s;
        serialized[p.key] = s;
      }
    } else {
      const s = String(raw);
      applied[p.key] = s;
      serialized[p.key] = s;
    }
  }
  if (issues.length > 0) throw new ScriptInvalidParamsError({ id: scriptId, issues });
  const extraEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(serialized)) extraEnv[`PARAM_${k.toUpperCase()}`] = v;
  // `schema` is contract-validated, so keys are safe placeholder names
  const command = commandTemplate.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, k: string) =>
    k in serialized ? shellEscape(serialized[k]) : m,
  );
  return { applied, command, extraEnv };
}
class ShellDriver implements ScriptDriver {
  async run(
    def: ScriptDefinition,
    _runId: string,
    _logsPath: string,
    exec?: { command: string; env?: Record<string, string> },
  ): Promise<ChildProcess> {
    const cwd = def.cwd ?? process.cwd();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    if (def.env) Object.assign(env, def.env);
    if (exec?.env) Object.assign(env, exec.env);
    const command = exec?.command ?? def.command;
    const runUser = def.runUser?.trim();
    if (runUser && runUser !== os.userInfo().username) {
      // run as another system user without a password prompt; fails visibly
      // when sudoers isn't configured for it.
      return spawn("sudo", ["-n", "-u", runUser, "--", "sh", "-c", command], {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    return spawn(command, {
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
    ) => Effect.Effect<ScriptDefinition, ScriptInvalidIdError | ScriptInvalidParamsError>;
    readonly delete: (id: string) => Effect.Effect<void, ScriptNotFoundError>;
    readonly runScript: (
      id: string,
      params?: Record<string, string | number | boolean>,
      opts?: { lenient?: boolean },
    ) => Effect.Effect<ScriptRun, ScriptNotFoundError | ScriptInvalidParamsError>;
    readonly stop: (runId: string) => Effect.Effect<void, ScriptRunNotFoundError | ScriptKillFailedError>;
    readonly getRun: (runId: string) => Effect.Effect<ScriptRun, ScriptRunNotFoundError>;
    readonly readLogs: (runId: string, tailLines?: number) => Effect.Effect<string, ScriptRunNotFoundError>;
    readonly listRuns: (filter?: {
      scriptId?: string;
      limit?: number;
    }) => Effect.Effect<ReadonlyArray<ScriptRun>>;
    readonly onEvent: (listener: (ev: ScriptEvent) => void) => Effect.Effect<() => void>;
  }
>() {}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

function isValidScriptId(id: string): boolean {
  return /^[a-z0-9_-]+$/.test(id);
}

/**
 * `Effect.runPromise` rejects with a FiberFailure wrapper, which drops the
 * TaggedError `_tag` — so legacy wrappers exit via `runPromiseExit` and map
 * the typed failure to a coded Error the RPC layer understands.
 */
function toCodedError<E extends { message: string }>(
  cause: Cause.Cause<E>,
  codeFor: (e: E) => string,
): Error {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    return Object.assign(new Error(failure.value.message), { code: codeFor(failure.value) });
  }
  return new Error(Cause.pretty(cause));
}

// ---------------------------------------------------------------------------
// Implementation — Effect-backed class (keeps `new ScriptService()` working)
// ---------------------------------------------------------------------------

export class ScriptService {
  private defs = new Map<string, ScriptDefinition>();
  private runs = new Map<string, ScriptRun>();
  private children = new Map<string, ChildProcess>();
  private listeners = new Set<(ev: ScriptEvent) => void>();
  private readonly runsPath: string;
  /**
   * Loopback info so systemd timers can trigger runs through the daemon
   * (`POST /api/scripts/run`). Timers read the token from disk at fire time.
   */
  private readonly timerCallback: { port: number; tokenPath: string } | null;

  /** Max persisted runs (ring buffer — keeps history bounded on disk). */
  static readonly MAX_PERSISTED_RUNS = 500;

  constructor(
    private readonly scriptsPath: string,
    private readonly logsBase: string,
    private readonly driver: ScriptDriver = new ShellDriver(),
    opts?: { runsPath?: string; timerCallback?: { port: number; tokenPath: string } },
  ) {
    this.logsBase = path.join(logsBase, "scripts");
    this.runsPath = opts?.runsPath ?? path.join(path.dirname(scriptsPath), "script-runs.json");
    this.timerCallback = opts?.timerCallback ?? null;
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
        // run history (best-effort — survives restarts so cards show last run)
        const runsRaw = yield* Effect.tryPromise({
          try: () => fsp.readFile(this.runsPath, "utf8"),
          catch: (cause) => cause as unknown,
        }).pipe(
          Effect.catchAll(() => Effect.succeed(null as string | null)),
        );
        if (runsRaw) {
          try {
            const arr = JSON.parse(runsRaw) as ScriptRun[];
            for (const r of arr) {
              // in-flight runs from a previous life are marked error (process gone)
              if (r.status === "running") {
                this.runs.set(r.runId, { ...r, status: "error", finishedAt: r.finishedAt ?? new Date().toISOString() });
              } else {
                this.runs.set(r.runId, r);
              }
            }
          } catch {}
        }
        // re-apply schedules (timers may have been removed while we were down)
        for (const def of this.defs.values()) {
          yield* this.syncScheduleEffect(def);
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

  private persistRunsEffect(): Effect.Effect<void, never> {
    return Effect.tryPromise({
      try: () => {
        const all = [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        const capped = all.slice(0, ScriptService.MAX_PERSISTED_RUNS);
        return fsp.writeFile(this.runsPath, JSON.stringify(capped, null, 2) + "\n", "utf8");
      },
      catch: () => undefined as void,
    }).pipe(Effect.orElseSucceed(() => undefined));
  }

  private persistRunsSoon(): void {
    // fire-and-forget (startup/restart paths call init which awaits separately)
    Effect.runPromise(this.persistRunsEffect()).catch(() => {});
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
      icon?: string;
      cwd?: string;
      env?: Record<string, string>;
      runUser?: string;
      runMode?: ScriptDefinition["runMode"];
      params?: ScriptParam[];
      timeoutMs?: number;
      isService?: boolean;
      cron?: string;
      schedule?: { enabled?: boolean; onCalendar?: string; persistent?: boolean };
    },
  ): Effect.Effect<ScriptDefinition, ScriptInvalidIdError | ScriptInvalidParamsError> {
    return Effect.gen(this, function* () {
      const id = input.id ?? `scr_${crypto.randomBytes(4).toString("hex")}`;
      if (!isValidScriptId(id)) return yield* Effect.fail(new ScriptInvalidIdError({ id }));
      if (input.params) {
        const seen = new Set<string>();
        const dupes = new Set<string>();
        for (const p of input.params) {
          if (seen.has(p.key)) dupes.add(p.key);
          seen.add(p.key);
        }
        if (dupes.size > 0) {
          return yield* Effect.fail(
            new ScriptInvalidParamsError({ id, issues: [...dupes].map((k) => `${k}: duplicate key`) }),
          );
        }
      }
      const now = new Date().toISOString();
      const existing = this.defs.get(id);
      // `cron` is deprecated — fold into schedule so timers stay the one path
      const rawSchedule = input.schedule ?? (input.cron ? { enabled: false, persistent: false, onCalendar: input.cron } : existing?.schedule);
      const schedule = rawSchedule
        ? { enabled: rawSchedule.enabled ?? false, persistent: rawSchedule.persistent ?? false, onCalendar: rawSchedule.onCalendar }
        : undefined;
      const def: ScriptDefinition = {
        id,
        name: input.name,
        description: input.description ?? "",
        icon: input.icon ?? existing?.icon,
        command: input.command,
        cwd: input.cwd,
        env: input.env,
        runUser: input.runUser ?? existing?.runUser,
        runMode: input.runMode ?? existing?.runMode ?? "manual",
        params: input.params ?? existing?.params,
        timeoutMs: input.timeoutMs,
        isService: input.isService ?? false,
        cron: input.cron ?? existing?.cron,
        schedule,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      this.defs.set(id, def);
      yield* this.persistEffect();
      yield* this.syncScheduleEffect(def);
      return def;
    });
  }

  deleteEffect(id: string): Effect.Effect<void, ScriptNotFoundError> {
    return Effect.gen(this, function* () {
      if (!this.defs.has(id)) return yield* Effect.fail(new ScriptNotFoundError({ id }));
      this.defs.delete(id);
      yield* this.persistEffect();
      yield* this.clearScheduleEffect(id);
    });
  }

  runScriptEffect(
    id: string,
    params?: Record<string, string | number | boolean>,
    opts?: { lenient?: boolean },
  ): Effect.Effect<ScriptRun, ScriptNotFoundError | ScriptInvalidParamsError> {
    return Effect.gen(this, function* () {
      const def = this.defs.get(id);
      if (!def) return yield* Effect.fail(new ScriptNotFoundError({ id }));
      // validate against the schema + substitute `{{key}}` (typed failure, not a throw)
      let resolved: ResolvedScriptParams;
      try {
        resolved = resolveScriptParams(id, def.command, def.params, params, opts);
      } catch (cause) {
        return yield* Effect.fail(cause as ScriptInvalidParamsError);
      }
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
        params: resolved.applied,
      };
      this.runs.set(runId, run);
      yield* this.persistRunsEffect();
      yield* Effect.tryPromise({
        try: () =>
          fsp.writeFile(
            logsPath,
            `# ${def.name} — ${def.command}\n# resolved: ${resolved.command}\n# params: ${JSON.stringify(resolved.applied)}\n# run ${runId} at ${run.startedAt}\n`,
            "utf8",
          ),
        catch: () => undefined as void,
      }).pipe(Effect.orElseSucceed(() => undefined));

      const child = yield* Effect.tryPromise({
        try: () => this.driver.run(def, runId, logsPath, { command: resolved.command, env: resolved.extraEnv }),
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
        this.persistRunsSoon();
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
        this.persistRunsSoon();
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

  listRunsEffect(filter?: { scriptId?: string; limit?: number }): Effect.Effect<ReadonlyArray<ScriptRun>> {
    return Effect.succeed(
      [...this.runs.values()]
        .filter((r) => (!filter?.scriptId ? true : r.scriptId === filter.scriptId))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, filter?.limit ?? 50),
    );
  }

  /** Last + active run for a script — powers cards (last run/status) and detail (history). */
  lastAndActiveRun(scriptId: string): { lastRun: ScriptRun | null; activeRun: ScriptRun | null } {
    const runs = [...this.runs.values()]
      .filter((r) => r.scriptId === scriptId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return {
      lastRun: runs[0] ?? null,
      activeRun: runs.find((r) => r.status === "running") ?? null,
    };
  }

  // ---- Scheduling via systemd timers (underlying impl; UI exposes on/off + schedule) ----

  private timerUnitName(id: string): string {
    return `home-server-script-${id}.timer`;
  }

  private syncScheduleEffect(def: ScriptDefinition): Effect.Effect<void, never> {
    const schedule = def.schedule;
    const enabled = schedule?.enabled && !!schedule.onCalendar;
    return Effect.tryPromise({
      try: () => this.applyTimer(def.id, enabled ? schedule!.onCalendar! : null, schedule?.persistent ?? false),
      catch: () => undefined as void,
    }).pipe(Effect.orElseSucceed(() => undefined));
  }

  private clearScheduleEffect(id: string): Effect.Effect<void, never> {
    return Effect.tryPromise({
      try: () => this.applyTimer(id, null, false),
      catch: () => undefined as void,
    }).pipe(Effect.orElseSucceed(() => undefined));
  }

  /**
   * Create/remove a user-level systemd timer that triggers a script run
   * through the daemon (`POST /api/scripts/run`), so timer-triggered runs
   * flow through the normal run path (history, logs, live output).
   * Best-effort: no-ops when no user systemd instance is available
   * (dev machines, tests) — the schedule stays stored as intent.
   */
  private async applyTimer(scriptId: string, onCalendar: string | null, persistent: boolean): Promise<void> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("systemctl", ["--user", "show", "-p", "Id", this.timerUnitName(scriptId)]);
    } catch {
      // no user systemd — skip silently (schedule stays stored as intent)
      return;
    }
    if (!this.timerCallback) return;
    const os = await import("node:os");
    const dir = path.join(os.homedir(), ".config", "systemd", "user");
    const base = `home-server-script-${scriptId}`;
    if (!onCalendar) {
      await execFileAsync("systemctl", ["--user", "disable", "--now", `${base}.timer`]).catch(() => {});
      return;
    }
    const { port, tokenPath } = this.timerCallback;
    const url = `http://127.0.0.1:${port}/api/scripts/run`;
    // Token is read from disk at fire time (never baked into the unit file).
    const trigger = `/bin/sh -c 'TOKEN=$(cat "${tokenPath.replace(/"/g, "")}"); curl -s -X POST "${url}" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\\"id\\":\\"${scriptId}\\"}"'`;
    const serviceUnit = `[Unit]\nDescription=home-server script ${scriptId}\n\n[Service]\nType=oneshot\nExecStart=${trigger}\n`;
    const timerUnit = `[Unit]\nDescription=Run home-server script ${scriptId}\n\n[Timer]\nOnCalendar=${onCalendar}\n${persistent ? "Persistent=true\n" : ""}[Install]\nWantedBy=timers.target\n`;
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${base}.service`), serviceUnit, "utf8");
    await fsp.writeFile(path.join(dir, `${base}.timer`), timerUnit, "utf8");
    await execFileAsync("systemctl", ["--user", "daemon-reload"]).catch(() => {});
    await execFileAsync("systemctl", ["--user", "enable", "--now", `${base}.timer`]);
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
    const exit = await Effect.runPromiseExit(this.upsertEffect(input));
    if (Exit.isSuccess(exit)) return exit.value;
    throw toCodedError(exit.cause, (e) => (e._tag === "ScriptInvalidIdError" ? "invalid_id" : "invalid_params"));
  }
  async delete(id: string): Promise<void> {
    return Effect.runPromise(this.deleteEffect(id).pipe(Effect.catchAll((e) => Effect.fail(Object.assign(new Error(e.message), { code: "not_found" })))));
  }
  async runScript(
    id: string,
    params?: Record<string, string | number | boolean>,
    opts?: { lenient?: boolean },
  ): Promise<ScriptRun> {
    const exit = await Effect.runPromiseExit(this.runScriptEffect(id, params, opts));
    if (Exit.isSuccess(exit)) return exit.value;
    throw toCodedError(exit.cause, (e) => (e._tag === "ScriptNotFoundError" ? "not_found" : "invalid_params"));
  }
  async stop(runId: string): Promise<void> {
    const exit = await Effect.runPromiseExit(this.stopEffect(runId));
    if (Exit.isSuccess(exit)) return exit.value;
    throw toCodedError(exit.cause, (e) => (e._tag === "ScriptRunNotFoundError" ? "not_found" : "kill_failed"));
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

  listRunsFiltered(filter?: { scriptId?: string; limit?: number }): ScriptRun[] {
    return [...this.runs.values()]
      .filter((r) => (!filter?.scriptId ? true : r.scriptId === filter.scriptId))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, filter?.limit ?? 50);
  }
}

export const ScriptServiceLive = (
  scriptsPath: string,
  logsBase: string,
  opts?: { runsPath?: string; timerCallback?: { port: number; tokenPath: string } },
) =>
  Layer.sync(ScriptServiceTag, () => {
    const svc = new ScriptService(scriptsPath, logsBase, undefined, opts);
    return ScriptServiceTag.of({
      list: () => svc.listEffect(),
      get: (id) => svc.getEffect(id),
      upsert: (input) => svc.upsertEffect(input),
      delete: (id) => svc.deleteEffect(id),
      runScript: (id, params, opts) => svc.runScriptEffect(id, params, opts),
      stop: (runId) => svc.stopEffect(runId),
      getRun: (runId) => svc.getRunEffect(runId),
      readLogs: (runId, tailLines) => svc.readLogsEffect(runId, tailLines),
      listRuns: (filter) => svc.listRunsEffect(filter),
      onEvent: (listener) => svc.onEventEffect(listener),
    });
  });
