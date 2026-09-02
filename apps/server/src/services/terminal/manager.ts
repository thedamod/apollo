import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
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
import type { PtyAdapter, PtyProcess } from "./ptyAdapter.ts";
import { createPtyAdapter } from "./nodePtyAdapter.ts";

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
  private metadataListeners = new Set<(ev: any) => void>();

  constructor(
    private readonly logsDir: string,
    private readonly ptyAdapter: PtyAdapter = createPtyAdapter(),
  ) {}

  async init(): Promise<void> {
    await fsp.mkdir(this.logsDir, { recursive: true });
  }

  private publish(ev: TerminalEvent): void {
    for (const l of this.eventListeners) {
      try {
        l(ev);
      } catch {}
    }
    // metadata stream (lightweight)
    if (["started", "restarted", "exited", "closed", "activity"].includes(ev.type)) {
      const summaryEv =
        ev.type === "closed"
          ? { type: "remove", sessionId: ev.sessionId, terminalId: ev.terminalId }
          : { type: "upsert", terminal: this.toSummary(ev) };
      for (const l of this.metadataListeners) {
        try {
          l(summaryEv);
        } catch {}
      }
    }
  }

  private toSummary(ev: TerminalEvent): TerminalSummary | null {
    if (ev.type === "output" || ev.type === "cleared" || ev.type === "error") return null;
    const k = key(ev.sessionId, ev.terminalId);
    const s = this.sessions.get(k);
    return s ? summaryOf(s) : null as any;
  }

  subscribe(listener: (ev: TerminalEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  subscribeMetadata(listener: (ev: any) => void): () => void {
    // initial snapshot
    queueMicrotask(() => listener({ type: "snapshot", terminals: [...this.sessions.values()].map(summaryOf) }));
    this.metadataListeners.add(listener);
    return () => this.metadataListeners.delete(listener);
  }

  // ---- lifecycle ----

  async open(input: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const k = key(input.sessionId, input.terminalId);
    const existing = this.sessions.get(k);
    if (existing && existing.status === "running") return snapshotOf(existing);

    // validate cwd
    try {
      const st = await fsp.stat(input.cwd);
      if (!st.isDirectory()) throw Object.assign(new Error(`Not a directory: ${input.cwd}`), { code: "not_directory" });
    } catch (e: any) {
      if (e.code === "ENOENT") throw Object.assign(new Error(`CWD not found: ${input.cwd}`), { code: "not_found" });
      throw e;
    }

    // cleanup old if exists
    if (existing) await this.closeInternal(existing, false);

    // load history
    let history = "";
    try {
      const hp = historyPath(this.logsDir, input.sessionId, input.terminalId);
      if (fs.existsSync(hp)) {
        history = capHistory(await fsp.readFile(hp, "utf8"), HISTORY_LINE_LIMIT);
      }
    } catch {}

    const cols: number = input.cols ?? 120;
    const rows: number = input.rows ?? 30;
    const shell = defaultShell(process.platform, process.env);
    const env: Record<string, string> = {};
    for (const [kk, v] of Object.entries(process.env)) if (v !== undefined) env[kk] = v;
    if (input.env) Object.assign(env, input.env);
    // blocklist like t3code
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

    const ptyProcess = this.ptyAdapter.spawn({ shell, cwd: input.cwd, env, cols, rows });
    state.process = ptyProcess;
    state.pid = ptyProcess.pid;
    state.status = "running";
    state.sequence += 1;
    state.updatedAt = new Date().toISOString();

    const onData = (data: string) => {
      state.history = capHistory(state.history + data, HISTORY_LINE_LIMIT);
      state.sequence += 1;
      state.updatedAt = new Date().toISOString();
      // persist debounced
      this.persistHistory(state).catch(() => {});
      this.publish({ type: "output", sessionId: state.sessionId, terminalId: state.terminalId, sequence: state.sequence, data });
    };
    const onExit = (e: { exitCode: number; signal?: number }) => {
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
  }

  private async persistHistory(state: SessionState): Promise<void> {
    try {
      const hp = historyPath(this.logsDir, state.sessionId, state.terminalId);
      await fsp.writeFile(hp, state.history, "utf8");
    } catch {}
  }

  async attachStream(input: TerminalAttachInput, send: (ev: TerminalAttachStreamEvent) => void): Promise<() => void> {
    let state = this.sessions.get(key(input.sessionId, input.terminalId)) ?? null;
    if (!state && input.restartIfNotRunning) {
      const snap = await this.open({
        sessionId: input.sessionId,
        terminalId: input.terminalId,
        cwd: os.homedir(),
        cols: input.cols ?? 120,
        rows: input.rows ?? 30,
      });
      state = this.sessions.get(key(input.sessionId, input.terminalId))!;
      // send snapshot immediately
      send({ type: "snapshot", snapshot: snap });
    } else if (!state) {
      throw Object.assign(new Error(`Unknown terminal ${input.sessionId}/${input.terminalId}`), { code: "not_found" });
    } else {
      if (input.cols && input.rows && state.process) {
        try {
          state.process.resize(input.cols, input.rows);
          state.cols = input.cols;
          state.rows = input.rows;
        } catch {}
      }
      send({ type: "snapshot", snapshot: snapshotOf(state) });
    }

    const listener = (ev: TerminalEvent) => {
      if (ev.sessionId !== input.sessionId || ev.terminalId !== input.terminalId) return;
      // map to attach stream
      if (ev.type === "started") send({ type: "snapshot", snapshot: ev.snapshot } as any);
      else if (ev.type === "restarted") send({ type: "restarted", snapshot: (ev as any).snapshot, sessionId: ev.sessionId, terminalId: ev.terminalId } as any);
      else if (["output", "exited", "closed", "error", "cleared", "activity"].includes(ev.type)) send(ev as any);
    };
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async write(input: TerminalWriteInput): Promise<void> {
    const s = this.sessions.get(key(input.sessionId, input.terminalId));
    if (!s) throw Object.assign(new Error("Unknown terminal"), { code: "not_found" });
    if (!s.process || s.status !== "running") throw Object.assign(new Error("Terminal not running"), { code: "not_running" });
    try {
      s.process.write(input.data);
    } catch (e: any) {
      throw Object.assign(new Error(`Write failed: ${e.message}`), { code: "write_failed" });
    }
  }

  async resize(input: TerminalResizeInput): Promise<void> {
    const s = this.sessions.get(key(input.sessionId, input.terminalId));
    if (!s) throw Object.assign(new Error("Unknown terminal"), { code: "not_found" });
    if (!s.process) throw Object.assign(new Error("Terminal not running"), { code: "not_running" });
    try {
      s.process.resize(input.cols, input.rows);
      s.cols = input.cols;
      s.rows = input.rows;
    } catch (e: any) {
      throw Object.assign(new Error(`Resize failed: ${e.message}`), { code: "resize_failed" });
    }
  }

  async clear(input: TerminalClearInput): Promise<void> {
    const s = this.sessions.get(key(input.sessionId, input.terminalId));
    if (!s) throw Object.assign(new Error("Unknown terminal"), { code: "not_found" });
    s.history = "";
    s.sequence += 1;
    await this.persistHistory(s);
    this.publish({ type: "cleared", sessionId: s.sessionId, terminalId: s.terminalId, sequence: s.sequence });
  }

  async restart(input: TerminalRestartInput): Promise<TerminalSessionSnapshot> {
    const k = key(input.sessionId, input.terminalId);
    const existing = this.sessions.get(k);
    if (existing) await this.closeInternal(existing, false);
    // clear history on restart (like t3)
    const hp = historyPath(this.logsDir, input.sessionId, input.terminalId);
    try {
      await fsp.writeFile(hp, "", "utf8");
    } catch {}
    const snap = await this.open({
      sessionId: input.sessionId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      env: input.env,
    });
    this.publish({ type: "restarted", sessionId: snap.sessionId, terminalId: snap.terminalId, sequence: snap.sequence, snapshot: snap });
    return snap;
  }

  async close(input: TerminalCloseInput): Promise<void> {
    if (!input.terminalId) {
      // close all for session
      const toClose = [...this.sessions.values()].filter((s) => s.sessionId === input.sessionId);
      for (const s of toClose) await this.closeInternal(s, input.deleteHistory ?? false);
      return;
    }
    const s = this.sessions.get(key(input.sessionId, input.terminalId));
    if (!s) return;
    await this.closeInternal(s, input.deleteHistory ?? false);
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
    // grace then SIGKILL
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
    // evict oldest
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

  async shutdown(): Promise<void> {
    for (const s of [...this.sessions.values()]) {
      try {
        s.process?.kill("SIGTERM");
      } catch {}
    }
  }
}
