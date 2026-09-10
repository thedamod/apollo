import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { getTerminalLabel, truncateLabel } from "@home-server/shared/terminalLabels";
import { defaultShell } from "@home-server/shared/shell";
import type {
  TerminalOpenInput,
  TerminalAttachInput,
  TerminalWriteInput,
  TerminalResizeInput,
  TerminalClearInput,
  TerminalRestartInput,
  TerminalCloseInput,
  TerminalSessionSnapshot,
  TerminalSummary,
  TerminalEvent,
  TerminalAttachStreamEvent,
} from "@home-server/contracts";
import type { PtyAdapterSync as PtyAdapter, PtyProcess } from "./ptyAdapter.ts";
import { createPtyAdapter } from "./nodePtyAdapter.ts";

// ---------------------------------------------------------------------------
// Typed errors — Effect-native, no `Object.assign(new Error, {code})` in new paths
// ---------------------------------------------------------------------------

export class TerminalNotFoundError extends Schema.TaggedError<TerminalNotFoundError>()(
  "TerminalNotFoundError",
  { sessionId: Schema.String, terminalId: Schema.optional(Schema.String) },
) {
  get message() {
    return `Unknown terminal ${this.sessionId}/${this.terminalId ?? "*"}`;
  }
}

export class TerminalNotRunningError extends Schema.TaggedError<TerminalNotRunningError>()(
  "TerminalNotRunningError",
  { sessionId: Schema.String, terminalId: Schema.String },
) {
  get message() {
    return `Terminal not running: ${this.sessionId}/${this.terminalId}`;
  }
}

export class TerminalCwdNotFoundError extends Schema.TaggedError<TerminalCwdNotFoundError>()(
  "TerminalCwdNotFoundError",
  { cwd: Schema.String },
) {
  get message() {
    return `CWD not found: ${this.cwd}`;
  }
}

export class TerminalCwdNotDirectoryError extends Schema.TaggedError<TerminalCwdNotDirectoryError>()(
  "TerminalCwdNotDirectoryError",
  { cwd: Schema.String },
) {
  get message() {
    return `Not a directory: ${this.cwd}`;
  }
}

export class TerminalWriteError extends Schema.TaggedError<TerminalWriteError>()(
  "TerminalWriteError",
  {
    sessionId: Schema.String,
    terminalId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class TerminalResizeError extends Schema.TaggedError<TerminalResizeError>()(
  "TerminalResizeError",
  {
    sessionId: Schema.String,
    terminalId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export type TerminalError =
  | TerminalNotFoundError
  | TerminalNotRunningError
  | TerminalCwdNotFoundError
  | TerminalCwdNotDirectoryError
  | TerminalWriteError
  | TerminalResizeError;

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

export class TerminalManagerTag extends Context.Tag("home-server/TerminalManager")<
  TerminalManagerTag,
  TerminalManager
>() {}

type SessionStatus = TerminalSessionSnapshot["status"];

interface SessionState {
  sessionId: string;
  terminalId: string;
  cwd: string;
  status: SessionStatus;
  pid: number | null;
  history: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  cols: number;
  rows: number;
  sequence: number;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  label: string;
}

const HISTORY_LINE_LIMIT = 5000;
const MAX_RETAINED_INACTIVE = 128;

function key(sessionId: string, terminalId: string): string {
  return `${sessionId}\0${terminalId}`;
}
function historyPath(logsDir: string, sessionId: string, terminalId: string): string {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeTerm = terminalId.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (terminalId === "term-1") return path.join(logsDir, `${safeSession}.log`);
  return path.join(logsDir, `${safeSession}_${safeTerm}.log`);
}
function capHistory(history: string, limit: number): string {
  if (!history) return history;
  const hasNL = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasNL) lines.pop();
  if (lines.length <= limit) return history;
  const capped = lines.slice(lines.length - limit).join("\n");
  return hasNL ? `${capped}\n` : capped;
}
function snapshotOf(s: SessionState): TerminalSessionSnapshot {
  return {
    sessionId: s.sessionId,
    terminalId: s.terminalId,
    cwd: s.cwd,
    status: s.status,
    pid: s.pid,
    history: s.history,
    exitCode: s.exitCode,
    exitSignal: s.exitSignal,
    label: s.label,
    updatedAt: s.updatedAt,
    cols: s.cols,
    rows: s.rows,
    sequence: s.sequence,
  };
}
function summaryOf(s: SessionState): TerminalSummary {
  return {
    sessionId: s.sessionId,
    terminalId: s.terminalId,
    cwd: s.cwd,
    status: s.status,
    pid: s.pid,
    exitCode: s.exitCode,
    exitSignal: s.exitSignal,
    hasRunningSubprocess: s.hasRunningSubprocess,
    label: s.label,
    updatedAt: s.updatedAt,
  };
}
function makeLabel(terminalId: string): string {
  return truncateLabel(getTerminalLabel(terminalId));
}

export class TerminalManager {
  private sessions = new Map<string, SessionState>();
  private eventListeners = new Set<(ev: TerminalEvent) => void>();
  private metadataListeners = new Set<(ev: { type: string; terminal?: TerminalSummary; terminals?: TerminalSummary[]; sessionId?: string; terminalId?: string }) => void>();

  constructor(
    private readonly logsDir: string,
    private readonly ptyAdapter: PtyAdapter = createPtyAdapter(),
  ) {}

  async init(): Promise<void> {
    await Effect.runPromise(
      Effect.tryPromise({
        try: () => fsp.mkdir(this.logsDir, { recursive: true }),
        catch: (cause) => new TerminalCwdNotFoundError({ cwd: this.logsDir }),
      }).pipe(Effect.orElseSucceed(() => undefined)),
    );
  }

  initEffect(): Effect.Effect<void, TerminalError> {
    return Effect.tryPromise({
      try: () => fsp.mkdir(this.logsDir, { recursive: true }),
      catch: (cause) => new TerminalCwdNotFoundError({ cwd: this.logsDir }) as TerminalError,
    }).pipe(Effect.asVoid, Effect.orElseSucceed(() => undefined));
  }

  private publish(ev: TerminalEvent): void {
    for (const l of this.eventListeners) {
      try {
        l(ev);
      } catch {}
    }
    if (["started", "restarted", "exited", "closed", "activity"].includes(ev.type)) {
      const summaryEv =
        ev.type === "closed"
          ? { type: "remove" as const, sessionId: ev.sessionId, terminalId: ev.terminalId }
          : { type: "upsert" as const, terminal: this.toSummary(ev) };
      for (const l of this.metadataListeners) {
        try {
          l(summaryEv as unknown as { type: string; terminal?: TerminalSummary });
        } catch {}
      }
    }
  }

  private toSummary(ev: TerminalEvent): TerminalSummary | null {
    if (ev.type === "output" || ev.type === "cleared" || ev.type === "error") return null;
    const k = key(ev.sessionId, ev.terminalId);
    const s = this.sessions.get(k);
    return s ? summaryOf(s) : null;
  }

  subscribe(listener: (ev: TerminalEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  subscribeEffect(listener: (ev: TerminalEvent) => Effect.Effect<void>): Effect.Effect<() => void> {
    return Effect.sync(() => this.subscribe((ev) => Effect.runSync(listener(ev).pipe(Effect.orElseSucceed(() => undefined)))));
  }

  subscribeMetadata(
    listener: (ev: { type: string; terminal?: TerminalSummary; terminals?: TerminalSummary[] }) => void,
  ): () => void {
    queueMicrotask(() => listener({ type: "snapshot", terminals: [...this.sessions.values()].map(summaryOf) }));
    this.metadataListeners.add(listener as unknown as (ev: { type: string }) => void);
    return () => this.metadataListeners.delete(listener as unknown as (ev: { type: string }) => void);
  }

  // ---- lifecycle ----

  openEffect(input: TerminalOpenInput): Effect.Effect<TerminalSessionSnapshot, TerminalError> {
    return Effect.gen(this, function* () {
      const k = key(input.sessionId, input.terminalId);
      const existing = this.sessions.get(k);
      if (existing && existing.status === "running") return snapshotOf(existing);

      yield* Effect.tryPromise({
        try: async () => {
          const st = await fsp.stat(input.cwd);
          if (!st.isDirectory()) throw new TerminalCwdNotDirectoryError({ cwd: input.cwd });
        },
        catch: (cause) => {
          if (cause instanceof TerminalCwdNotDirectoryError) return cause as TerminalError;
          const code = (cause as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") return new TerminalCwdNotFoundError({ cwd: input.cwd }) as TerminalError;
          return new TerminalCwdNotFoundError({ cwd: input.cwd }) as TerminalError;
        },
      });

      if (existing) yield* Effect.promise(() => this.closeInternal(existing, false));

      let history = "";
      const hp = historyPath(this.logsDir, input.sessionId, input.terminalId);
      const hist = yield* Effect.tryPromise({
        try: () => (fs.existsSync(hp) ? fsp.readFile(hp, "utf8") : Promise.resolve("")),
        catch: () => "" as string,
      }).pipe(Effect.orElseSucceed(() => "" as string));
      history = capHistory(hist, HISTORY_LINE_LIMIT);

      const cols = input.cols ?? 120;
      const rows = input.rows ?? 30;
      const shell = defaultShell(process.platform, process.env);
      const env: Record<string, string> = {};
      for (const [kk, v] of Object.entries(process.env)) if (v !== undefined) env[kk] = v;
      if (input.env) Object.assign(env, input.env);
      for (const b of ["PORT", "ELECTRON_RENDERER_PORT"]) delete env[b];

      const state: SessionState = {
        sessionId: input.sessionId,
        terminalId: input.terminalId,
        cwd: input.cwd,
        status: "starting",
        pid: null,
        history,
        exitCode: null,
        exitSignal: null,
        updatedAt: new Date().toISOString(),
        cols,
        rows,
        sequence: 0,
        process: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        hasRunningSubprocess: false,
        label: makeLabel(input.terminalId),
      };

      const ptyProcess = yield* Effect.try({
        try: () => this.ptyAdapter.spawn({ shell, cwd: input.cwd, env, cols, rows }),
        catch: (cause) => new TerminalWriteError({ sessionId: input.sessionId, terminalId: input.terminalId, cause }) as TerminalError,
      });
      state.process = ptyProcess;
      state.pid = ptyProcess.pid;
      state.status = "running";
      state.sequence += 1;
      state.updatedAt = new Date().toISOString();

      const onData = (data: string) => {
        state.history = capHistory(state.history + data, HISTORY_LINE_LIMIT);
        state.sequence += 1;
        state.updatedAt = new Date().toISOString();
        this.persistHistory(state).catch(() => {});
        this.publish({ type: "output", sessionId: state.sessionId, terminalId: state.terminalId, sequence: state.sequence, data });
      };
      const onExit = (e: { exitCode: number; signal: number | null }) => {
        state.status = "exited";
        state.exitCode = e.exitCode;
        state.exitSignal = e.signal ?? null;
        state.pid = null;
        state.sequence += 1;
        state.updatedAt = new Date().toISOString();
        this.publish({
          type: "exited",
          sessionId: state.sessionId,
          terminalId: state.terminalId,
          sequence: state.sequence,
          exitCode: e.exitCode,
          exitSignal: e.signal ?? null,
        });
        this.evictIfNeeded();
      };
      state.unsubscribeData = ptyProcess.onData(onData);
      state.unsubscribeExit = ptyProcess.onExit(onExit);

      this.sessions.set(k, state);
      const snap = snapshotOf(state);
      this.publish({ type: "started", sessionId: state.sessionId, terminalId: state.terminalId, sequence: state.sequence, snapshot: snap });
      return snap;
    });
  }

  async open(input: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    return Effect.runPromise(
      this.openEffect(input).pipe(
        Effect.catchAll((e) => {
          const code =
            e._tag === "TerminalCwdNotFoundError"
              ? "not_found"
              : e._tag === "TerminalCwdNotDirectoryError"
                ? "not_directory"
                : "unknown";
          return Effect.fail(Object.assign(new Error(e.message), { code }));
        }),
      ),
    ) as Promise<TerminalSessionSnapshot>;
  }

  private async persistHistory(state: SessionState): Promise<void> {
    try {
      const hp = historyPath(this.logsDir, state.sessionId, state.terminalId);
      await fsp.writeFile(hp, state.history, "utf8");
    } catch {}
  }

  attachStreamEffect(
    input: TerminalAttachInput,
    send: (ev: TerminalAttachStreamEvent) => void,
  ): Effect.Effect<() => void, TerminalError> {
    return Effect.gen(this, function* () {
      let state = this.sessions.get(key(input.sessionId, input.terminalId)) ?? null;
      if (!state && input.restartIfNotRunning) {
        const snap = yield* this.openEffect({
          sessionId: input.sessionId,
          terminalId: input.terminalId,
          cwd: os.homedir(),
          cols: input.cols ?? 120,
          rows: input.rows ?? 30,
        });
        state = this.sessions.get(key(input.sessionId, input.terminalId))!;
        send({ type: "snapshot", snapshot: snap });
      } else if (!state) {
        return yield* Effect.fail(new TerminalNotFoundError({ sessionId: input.sessionId, terminalId: input.terminalId }));
      } else {
        if (input.cols && input.rows && state.process) {
          yield* Effect.try({
            try: () => {
              state!.process!.resize(input.cols!, input.rows!);
              state!.cols = input.cols!;
              state!.rows = input.rows!;
            },
            catch: () => undefined as void,
          }).pipe(Effect.orElseSucceed(() => undefined));
        }
        send({ type: "snapshot", snapshot: snapshotOf(state) });
      }

      const listener = (ev: TerminalEvent) => {
        if (ev.sessionId !== input.sessionId || ev.terminalId !== input.terminalId) return;
        if (ev.type === "started") send({ type: "snapshot", snapshot: ev.snapshot } as unknown as TerminalAttachStreamEvent);
        else if (ev.type === "restarted") send({ type: "restarted", snapshot: (ev as unknown as { snapshot: TerminalSessionSnapshot }).snapshot, sessionId: ev.sessionId, terminalId: ev.terminalId } as unknown as TerminalAttachStreamEvent);
        else if ((["output", "exited", "closed", "error", "cleared", "activity"] as string[]).includes(ev.type)) send(ev as unknown as TerminalAttachStreamEvent);
      };
      this.eventListeners.add(listener);
      return () => this.eventListeners.delete(listener);
    });
  }

  async attachStream(input: TerminalAttachInput, send: (ev: TerminalAttachStreamEvent) => void): Promise<() => void> {
    return Effect.runPromise(
      this.attachStreamEffect(input, send).pipe(
        Effect.catchAll((e) => Effect.fail(Object.assign(new Error(e.message), { code: "not_found" }))),
      ),
    ) as Promise<() => void>;
  }

  writeEffect(input: TerminalWriteInput): Effect.Effect<void, TerminalError> {
    return Effect.gen(this, function* () {
      const s = this.sessions.get(key(input.sessionId, input.terminalId));
      if (!s) return yield* Effect.fail(new TerminalNotFoundError({ sessionId: input.sessionId, terminalId: input.terminalId }));
      if (!s.process || s.status !== "running") return yield* Effect.fail(new TerminalNotRunningError({ sessionId: input.sessionId, terminalId: input.terminalId }));
      yield* Effect.try({
        try: () => s.process!.write(input.data),
        catch: (cause) => new TerminalWriteError({ sessionId: input.sessionId, terminalId: input.terminalId, cause }),
      });
    });
  }

  async write(input: TerminalWriteInput): Promise<void> {
    return Effect.runPromise(
      this.writeEffect(input).pipe(
        Effect.catchAll((e) =>
          Effect.fail(
            Object.assign(new Error(e.message), {
              code: e._tag === "TerminalNotFoundError" ? "not_found" : e._tag === "TerminalNotRunningError" ? "not_running" : "write_failed",
            }),
          ),
        ),
      ),
    ) as Promise<void>;
  }

  resizeEffect(input: TerminalResizeInput): Effect.Effect<void, TerminalError> {
    return Effect.gen(this, function* () {
      const s = this.sessions.get(key(input.sessionId, input.terminalId));
      if (!s) return yield* Effect.fail(new TerminalNotFoundError({ sessionId: input.sessionId, terminalId: input.terminalId }));
      if (!s.process) return yield* Effect.fail(new TerminalNotRunningError({ sessionId: input.sessionId, terminalId: input.terminalId }));
      yield* Effect.try({
        try: () => {
          s.process!.resize(input.cols, input.rows);
          s.cols = input.cols;
          s.rows = input.rows;
        },
        catch: (cause) => new TerminalResizeError({ sessionId: input.sessionId, terminalId: input.terminalId, cause }),
      });
    });
  }

  async resize(input: TerminalResizeInput): Promise<void> {
    return Effect.runPromise(
      this.resizeEffect(input).pipe(
        Effect.catchAll((e) => Effect.fail(Object.assign(new Error((e as Error).message), { code: e._tag === "TerminalNotFoundError" ? "not_found" : "resize_failed" }))),
      ),
    ) as Promise<void>;
  }

  clearEffect(input: TerminalClearInput): Effect.Effect<void, TerminalError> {
    return Effect.gen(this, function* () {
      const s = this.sessions.get(key(input.sessionId, input.terminalId));
      if (!s) return yield* Effect.fail(new TerminalNotFoundError({ sessionId: input.sessionId, terminalId: input.terminalId }));
      s.history = "";
      s.sequence += 1;
      yield* Effect.promise(() => this.persistHistory(s));
      this.publish({ type: "cleared", sessionId: s.sessionId, terminalId: s.terminalId, sequence: s.sequence });
    });
  }

  async clear(input: TerminalClearInput): Promise<void> {
    return Effect.runPromise(
      this.clearEffect(input).pipe(Effect.catchAll((e) => Effect.fail(Object.assign(new Error(e.message), { code: "not_found" })))),
    ) as Promise<void>;
  }

  restartEffect(input: TerminalRestartInput): Effect.Effect<TerminalSessionSnapshot, TerminalError> {
    return Effect.gen(this, function* () {
      const k = key(input.sessionId, input.terminalId);
      const existing = this.sessions.get(k);
      if (existing) yield* Effect.promise(() => this.closeInternal(existing, false));
      const hp = historyPath(this.logsDir, input.sessionId, input.terminalId);
      yield* Effect.tryPromise({ try: () => fsp.writeFile(hp, "", "utf8"), catch: () => undefined as void }).pipe(Effect.orElseSucceed(() => undefined));
      const snap = yield* this.openEffect({
        sessionId: input.sessionId,
        terminalId: input.terminalId,
        cwd: input.cwd,
        cols: input.cols,
        rows: input.rows,
        env: input.env,
      });
      this.publish({ type: "restarted", sessionId: snap.sessionId, terminalId: snap.terminalId, sequence: snap.sequence, snapshot: snap });
      return snap;
    });
  }

  async restart(input: TerminalRestartInput): Promise<TerminalSessionSnapshot> {
    return Effect.runPromise(this.restartEffect(input)) as Promise<TerminalSessionSnapshot>;
  }

  closeEffect(input: TerminalCloseInput): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (!input.terminalId) {
        const toClose = [...this.sessions.values()].filter((s) => s.sessionId === input.sessionId);
        for (const s of toClose) yield* Effect.promise(() => this.closeInternal(s, input.deleteHistory ?? false));
        return;
      }
      const s = this.sessions.get(key(input.sessionId, input.terminalId));
      if (!s) return;
      yield* Effect.promise(() => this.closeInternal(s, input.deleteHistory ?? false));
    });
  }

  async close(input: TerminalCloseInput): Promise<void> {
    return Effect.runPromise(this.closeEffect(input));
  }

  private async closeInternal(s: SessionState, deleteHistory: boolean): Promise<void> {
    try {
      s.unsubscribeData?.();
    } catch {}
    try {
      s.unsubscribeExit?.();
    } catch {}
    try {
      s.process?.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        s.process?.kill("SIGKILL");
      } catch {}
    }, 1000).unref?.();

    this.sessions.delete(key(s.sessionId, s.terminalId));
    s.sequence += 1;
    this.publish({ type: "closed", sessionId: s.sessionId, terminalId: s.terminalId, sequence: s.sequence });

    if (deleteHistory) {
      try {
        await fsp.unlink(historyPath(this.logsDir, s.sessionId, s.terminalId));
      } catch {}
    }
  }

  private evictIfNeeded(): void {
    const inactive = [...this.sessions.values()].filter((s) => s.status !== "running");
    if (inactive.length <= MAX_RETAINED_INACTIVE) return;
    inactive.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const toEvict = inactive.slice(0, inactive.length - MAX_RETAINED_INACTIVE);
    for (const s of toEvict) {
      this.sessions.delete(key(s.sessionId, s.terminalId));
    }
  }

  list(sessionId?: string): TerminalSummary[] {
    const all = [...this.sessions.values()];
    const filtered = sessionId ? all.filter((s) => s.sessionId === sessionId) : all;
    return filtered.map(summaryOf);
  }

  listEffect(sessionId?: string): Effect.Effect<ReadonlyArray<TerminalSummary>> {
    return Effect.succeed(this.list(sessionId));
  }

  async shutdown(): Promise<void> {
    await Effect.runPromise(
      Effect.forEach([...this.sessions.values()], (s) =>
        Effect.try(() => s.process?.kill("SIGTERM")).pipe(Effect.orElseSucceed(() => undefined)),
      ).pipe(Effect.orElseSucceed(() => undefined)),
    );
  }

  shutdownEffect(): Effect.Effect<void> {
    return Effect.forEach([...this.sessions.values()], (s) =>
      Effect.try(() => s.process?.kill("SIGTERM")).pipe(Effect.orElseSucceed(() => undefined)),
    ).pipe(Effect.asVoid);
  }
}

export const TerminalManagerLive = (logsDir: string, ptyAdapter?: PtyAdapter) =>
  Layer.succeed(TerminalManagerTag, new TerminalManager(logsDir, ptyAdapter));
