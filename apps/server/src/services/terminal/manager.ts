import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  getTerminalLabel,
  truncateLabel,
} from "@home-server/shared/terminalLabels";
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
  TerminalMetadataStreamEvent,
} from "@home-server/contracts";
import type {
  PtyAdapterSync as PtyAdapter,
  PtyProcess,
  PtySpawnError,
} from "./ptyAdapter.ts";
import { createPtyAdapter } from "./nodePtyAdapter.ts";

// ---------------------------------------------------------------------------
// Typed errors — Effect-native. Mirrors t3code's `TerminalError` union with the
// sessionId scoping rename (threadId -> sessionId).
// ---------------------------------------------------------------------------

export class TerminalNotFoundError extends Schema.TaggedError<TerminalNotFoundError>()(
  "TerminalNotFoundError",
  { sessionId: Schema.String, terminalId: Schema.optional(Schema.String) },
) {
  get message() {
    return `Unknown terminal ${this.sessionId}/${this.terminalId ?? "*"}`;
  }
}

/** t3code parity: distinct lookup error (attach/resize/clear on unknown session). */
export class TerminalSessionLookupError extends Schema.TaggedError<TerminalSessionLookupError>()(
  "TerminalSessionLookupError",
  { sessionId: Schema.String, terminalId: Schema.String },
) {
  get message() {
    return `Unknown terminal session: ${this.sessionId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalNotRunningError extends Schema.TaggedError<TerminalNotRunningError>()(
  "TerminalNotRunningError",
  { sessionId: Schema.String, terminalId: Schema.String },
) {
  get message() {
    return `Terminal is not running for session: ${this.sessionId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalCwdNotFoundError extends Schema.TaggedError<TerminalCwdNotFoundError>()(
  "TerminalCwdNotFoundError",
  { cwd: Schema.String },
) {
  get message() {
    return `Terminal cwd does not exist: ${this.cwd}`;
  }
}

export class TerminalCwdNotDirectoryError extends Schema.TaggedError<TerminalCwdNotDirectoryError>()(
  "TerminalCwdNotDirectoryError",
  { cwd: Schema.String },
) {
  get message() {
    return `Terminal cwd is not a directory: ${this.cwd}`;
  }
}

/** t3code parity: stat failed for a reason other than missing/not-a-directory (EACCES, …). */
export class TerminalCwdStatError extends Schema.TaggedError<TerminalCwdStatError>()(
  "TerminalCwdStatError",
  { cwd: Schema.String, cause: Schema.optional(Schema.Defect) },
) {
  get message() {
    return `Failed to access terminal cwd: ${this.cwd}`;
  }
}

/** t3code parity: history read/truncate/migrate failures. */
export class TerminalHistoryError extends Schema.TaggedError<TerminalHistoryError>()(
  "TerminalHistoryError",
  {
    operation: Schema.Literal("read", "truncate", "migrate"),
    sessionId: Schema.String,
    terminalId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  get message() {
    return `Failed to ${this.operation} terminal history for session: ${this.sessionId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalWriteError extends Schema.TaggedError<TerminalWriteError>()(
  "TerminalWriteError",
  {
    sessionId: Schema.String,
    terminalId: Schema.String,
    terminalPid: Schema.Number,
    cause: Schema.Defect,
  },
) {
  get message() {
    return `Failed to write to terminal for session: ${this.sessionId}, terminal: ${this.terminalId}, PID: ${this.terminalPid}`;
  }
}

export class TerminalResizeError extends Schema.TaggedError<TerminalResizeError>()(
  "TerminalResizeError",
  {
    sessionId: Schema.String,
    terminalId: Schema.String,
    terminalPid: Schema.Number,
    cols: Schema.Number,
    rows: Schema.Number,
    cause: Schema.Defect,
  },
) {
  get message() {
    return `Failed to resize terminal for session: ${this.sessionId}, terminal: ${this.terminalId}, PID: ${this.terminalPid} to ${this.cols}x${this.rows}`;
  }
}

/** t3code parity: SIGTERM/SIGKILL delivery failure during kill escalation. */
export class TerminalProcessSignalError extends Schema.TaggedError<TerminalProcessSignalError>()(
  "TerminalProcessSignalError",
  {
    signal: Schema.Literal("SIGTERM", "SIGKILL"),
    terminalPid: Schema.Number,
    cause: Schema.optional(Schema.Defect),
  },
) {
  get message() {
    return `Failed to send ${this.signal} to terminal process ${this.terminalPid}`;
  }
}

export type TerminalError =
  | TerminalNotFoundError
  | TerminalSessionLookupError
  | TerminalNotRunningError
  | TerminalCwdNotFoundError
  | TerminalCwdNotDirectoryError
  | TerminalCwdStatError
  | TerminalHistoryError
  | TerminalWriteError
  | TerminalResizeError
  | TerminalProcessSignalError;

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

export class TerminalManagerTag extends Context.Tag(
  "home-server/TerminalManager",
)<TerminalManagerTag, TerminalManager>() {}

type SessionStatus = TerminalSessionSnapshot["status"];

interface SessionState {
  sessionId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: SessionStatus;
  pid: number | null;
  history: string;
  /** Split escape-sequence remainder held across data chunks (t3code parity). */
  pendingHistoryControlSequence: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  cols: number;
  rows: number;
  sequence: number;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  /** Tracked SIGKILL timer for kill escalation (cleared on natural exit). */
  killTimer: NodeJS.Timeout | null;
  hasRunningSubprocess: boolean;
  childCommandLabel: string | null;
  runtimeEnv: Record<string, string> | null;
}

const HISTORY_LINE_LIMIT = 5000;
const MAX_RETAINED_INACTIVE = 128;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
const PERSIST_DEBOUNCE_MS = 40;
const SUBPROCESS_POLL_INTERVAL_MS = 1000;
const PROCESS_KILL_GRACE_MS = 1000;
const MAX_TERMINAL_LABEL_LENGTH = 128;

const TERMINAL_ENV_BLOCKLIST = new Set([
  "PORT",
  "ELECTRON_RENDERER_PORT",
  "ELECTRON_RUN_AS_NODE",
]);

function key(sessionId: string, terminalId: string): string {
  return `${sessionId}\0${terminalId}`;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function historyFileName(sessionId: string, terminalId: string): string {
  if (terminalId === "term-1") return `terminal_${base64url(sessionId)}.log`;
  return `terminal_${base64url(sessionId)}_${base64url(terminalId)}.log`;
}

/** Legacy pre-base64 path (regex-sanitized) — read for one-way migration only. */
function legacyHistoryPath(
  logsDir: string,
  sessionId: string,
  terminalId: string,
): string {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeTerm = terminalId.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (terminalId === "term-1") return path.join(logsDir, `${safeSession}.log`);
  return path.join(logsDir, `${safeSession}_${safeTerm}.log`);
}

function historyPath(
  logsDir: string,
  sessionId: string,
  terminalId: string,
): string {
  return path.join(logsDir, historyFileName(sessionId, terminalId));
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

// --- history sanitization (ported from t3code Manager.ts) ---
// Strips device-query/reply traffic (DSR `…n`/`…R`, DA `…c`, DECRQM/RPM
// `…$p`/`…$y`, XTVERSION `…>q`, kitty `…?u`, DCS `$q`/`+q`, OSC 10/11/12 color
// queries) from persisted history so replay never makes the shell answer
// stale queries. Wire `data` stays raw; only stored `history` is sanitized.

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === "n") return true;
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) return true;
  if (finalByte === "c" && /^[>0-9;?]*$/.test(body)) return true;
  if ((finalByte === "p" || finalByte === "y") && /^[0-9;?]*\$$/.test(body))
    return true;
  if (finalByte === "q" && /^>[0-9;]*$/.test(body)) return true;
  if (finalByte === "u" && body.startsWith("?")) return true;
  return false;
}

function shouldStripDcsSequence(content: string): boolean {
  return /^[01]?[$+][qr]/.test(content);
}

function shouldStripOscSequence(content: string): boolean {
  return /^(10|11|12);(?:\?|rgb:)/.test(content);
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) return value.slice(0, -2);
  const last = value.at(-1);
  if (last === "\u0007" || last === "\u009c") return value.slice(0, -1);
  return value;
}

function findStringTerminatorIndex(
  input: string,
  start: number,
): number | null {
  for (let i = start; i < input.length; i += 1) {
    const cp = input.charCodeAt(i);
    if (cp === 0x07 || cp === 0x9c) return i + 1;
    if (cp === 0x1b && input.charCodeAt(i + 1) === 0x5c) return i + 2;
  }
  return null;
}

function isEscapeIntermediateByte(cp: number): boolean {
  return cp >= 0x20 && cp <= 0x2f;
}
function isEscapeFinalByte(cp: number): boolean {
  return cp >= 0x30 && cp <= 0x7e;
}
function findEscapeSequenceEndIndex(
  input: string,
  start: number,
): number | null {
  let cursor = start;
  while (
    cursor < input.length &&
    isEscapeIntermediateByte(input.charCodeAt(cursor))
  )
    cursor += 1;
  if (cursor >= input.length) return null;
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;
  const append = (v: string) => {
    visibleText += v;
  };
  while (index < input.length) {
    const cp = input.charCodeAt(index);
    if (cp === 0x1b) {
      const next = input.charCodeAt(index + 1);
      if (Number.isNaN(next))
        return { visibleText, pendingControlSequence: input.slice(index) };
      if (next === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          if (isCsiFinalByte(input.charCodeAt(cursor))) {
            const seq = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            if (!shouldStripCsiSequence(body, input[cursor] ?? "")) append(seq);
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length)
          return { visibleText, pendingControlSequence: input.slice(index) };
        continue;
      }
      if (next === 0x5d || next === 0x50 || next === 0x5e || next === 0x5f) {
        const termIdx = findStringTerminatorIndex(input, index + 2);
        if (termIdx === null)
          return { visibleText, pendingControlSequence: input.slice(index) };
        const seq = input.slice(index, termIdx);
        const content = stripStringTerminator(input.slice(index + 2, termIdx));
        const strip =
          (next === 0x5d && shouldStripOscSequence(content)) ||
          (next === 0x50 && shouldStripDcsSequence(content));
        if (!strip) append(seq);
        index = termIdx;
        continue;
      }
      const endIdx = findEscapeSequenceEndIndex(input, index + 1);
      if (endIdx === null)
        return { visibleText, pendingControlSequence: input.slice(index) };
      append(input.slice(index, endIdx));
      index = endIdx;
      continue;
    }
    if (cp === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        if (isCsiFinalByte(input.charCodeAt(cursor))) {
          const seq = input.slice(index, cursor + 1);
          const body = input.slice(index + 1, cursor);
          if (!shouldStripCsiSequence(body, input[cursor] ?? "")) append(seq);
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length)
        return { visibleText, pendingControlSequence: input.slice(index) };
      continue;
    }
    if (cp === 0x9d || cp === 0x90 || cp === 0x9e || cp === 0x9f) {
      const termIdx = findStringTerminatorIndex(input, index + 1);
      if (termIdx === null)
        return { visibleText, pendingControlSequence: input.slice(index) };
      const seq = input.slice(index, termIdx);
      const content = stripStringTerminator(input.slice(index + 1, termIdx));
      const strip =
        (cp === 0x9d && shouldStripOscSequence(content)) ||
        (cp === 0x90 && shouldStripDcsSequence(content));
      if (!strip) append(seq);
      index = termIdx;
      continue;
    }
    append(input[index] ?? "");
    index += 1;
  }
  return { visibleText, pendingControlSequence: "" };
}

// --- shell resolution (ported from t3code Manager.ts) ---

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

function shellCandidateFromCommand(
  command: string | null,
  platform: NodeJS.Platform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const normalized =
    platform === "win32"
      ? command.replaceAll("/", "\\")
      : command.replaceAll("\\", "/");
  const parts = normalized
    .split(platform === "win32" ? /\\+/ : /\/+/)
    .filter(Boolean);
  const shellName = (parts.at(-1) ?? normalized).toLowerCase();
  if (
    platform === "win32" &&
    (shellName === "pwsh.exe" || shellName === "powershell.exe")
  ) {
    return { shell: command, args: ["-NoLogo"] };
  }
  if (platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function normalizeShellValue(
  value: string | undefined,
  platform: NodeJS.Platform,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (platform === "win32") return trimmed;
  const first = trimmed.split(/\s+/g)[0]?.trim();
  if (!first) return null;
  return first.replace(/^['"]|['"]$/g, "");
}

function joinWindowsPath(...parts: ReadonlyArray<string>): string {
  return parts
    .map((part, i) =>
      i === 0
        ? part.replace(/[\\/]+$/g, "")
        : part.replace(/^[\\/]+|[\\/]+$/g, ""),
    )
    .filter((p) => p.length > 0)
    .join("\\");
}
function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
}

function uniqueShellCandidates(
  candidates: Array<ShellCandidate | null>,
): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const c of candidates) {
    if (!c) continue;
    const k = c.args?.length ? `${c.shell} ${c.args.join(" ")}` : c.shell;
    if (seen.has(k)) continue;
    seen.add(k);
    ordered.push(c);
  }
  return ordered;
}

function resolveShellCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ShellCandidate[] {
  if (platform === "win32") {
    const root = windowsSystemRoot(env);
    return uniqueShellCandidates([
      shellCandidateFromCommand(
        normalizeShellValue(process.env.SHELL, platform),
        platform,
      ),
      shellCandidateFromCommand("pwsh.exe", platform),
      shellCandidateFromCommand(
        joinWindowsPath(
          root,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        platform,
      ),
      shellCandidateFromCommand("powershell.exe", platform),
      shellCandidateFromCommand(env.ComSpec ?? null, platform),
      shellCandidateFromCommand(
        joinWindowsPath(root, "System32", "cmd.exe"),
        platform,
      ),
      shellCandidateFromCommand("cmd.exe", platform),
    ]);
  }
  return uniqueShellCandidates([
    shellCandidateFromCommand(
      normalizeShellValue(process.env.SHELL, platform),
      platform,
    ),
    shellCandidateFromCommand(
      normalizeShellValue(env.SHELL, platform),
      platform,
    ),
    shellCandidateFromCommand("/bin/zsh", platform),
    shellCandidateFromCommand("/bin/bash", platform),
    shellCandidateFromCommand("/bin/sh", platform),
    shellCandidateFromCommand("zsh", platform),
    shellCandidateFromCommand("bash", platform),
    shellCandidateFromCommand("sh", platform),
  ]);
}

function isRetryableShellSpawnError(error: PtySpawnError): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    if (typeof cur === "string") {
      messages.push(cur);
      continue;
    }
    if (cur instanceof Error) {
      messages.push(cur.message);
      if (cur.cause) queue.push(cur.cause);
      continue;
    }
    if (typeof cur === "object") {
      const v = cur as { message?: unknown; cause?: unknown };
      if (typeof v.message === "string") messages.push(v.message);
      if (v.cause) queue.push(v.cause);
    }
  }
  const msg = messages.join(" ").toLowerCase();
  return (
    msg.includes("posix_spawnp failed") ||
    msg.includes("enoent") ||
    msg.includes("not found") ||
    msg.includes("file not found") ||
    msg.includes("no such file")
  );
}

// --- env handling (ported from t3code Manager.ts) ---

function shouldExcludeTerminalEnvKey(k: string): boolean {
  const n = k.toUpperCase();
  if (n.startsWith("T3CODE_")) return true;
  if (n.startsWith("VITE_")) return true;
  return TERMINAL_ENV_BLOCKLIST.has(n);
}

const APPIMAGE_RUNTIME_ENV_KEYS = [
  "APPIMAGE",
  "APPDIR",
  "ARGV0",
  "OWD",
] as const;
const APPIMAGE_PATH_LIKE_ENV_KEYS = [
  "PATH",
  "LD_LIBRARY_PATH",
  "XDG_DATA_DIRS",
  "GSETTINGS_SCHEMA_DIR",
] as const;

function stripAppImageRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.APPIMAGE === undefined && env.APPDIR === undefined) return env;
  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const k of APPIMAGE_RUNTIME_ENV_KEYS) delete scrubbed[k];
  const appDir = env.APPDIR?.replace(/\/+$/, "");
  if (appDir) {
    for (const k of APPIMAGE_PATH_LIKE_ENV_KEYS) {
      const v = scrubbed[k];
      if (v === undefined) continue;
      const kept = v
        .split(":")
        .filter(
          (s) => s.length > 0 && !(s === appDir || s.startsWith(`${appDir}/`)),
        );
      if (kept.length > 0) scrubbed[k] = kept.join(":");
      else delete scrubbed[k];
    }
  }
  return scrubbed;
}

function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined) continue;
    if (shouldExcludeTerminalEnvKey(k)) continue;
    spawnEnv[k] = v;
  }
  if (runtimeEnv)
    for (const [k, v] of Object.entries(runtimeEnv)) spawnEnv[k] = v;
  return stripAppImageRuntimeEnv(spawnEnv);
}

function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(
    [...entries].sort(([l]: [string, string], [r]: [string, string]) =>
      l.localeCompare(r),
    ),
  );
}

// --- subprocess inspection (ported from t3code Manager.ts, stdlib version) ---

interface ProcessTableSnapshot {
  readonly childrenByParent: ReadonlyMap<number, ReadonlyArray<number>>;
  readonly commandById: ReadonlyMap<number, string>;
}

function parsePosixProcessTable(stdout: string): ProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/g)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    commandById.set(pid, (m[3] ?? "").trim());
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  return { childrenByParent, commandById };
}

function parseWindowsProcessTable(stdout: string): ProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/g)) {
    const [pidRaw, ppidRaw, nameRaw] = line.trim().split("|", 3);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    commandById.set(pid, nameRaw?.trim() ?? "");
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  return { childrenByParent, commandById };
}

function normalizeChildCommandName(
  command: string,
  platform: NodeJS.Platform,
): string | null {
  const normalized =
    platform === "win32"
      ? command.replaceAll("/", "\\")
      : command.replaceAll("\\", "/");
  const parts = normalized
    .split(platform === "win32" ? /\\+/ : /\/+/)
    .filter((p) => p.length > 0);
  let base = parts.at(-1) ?? normalized;
  if (platform === "win32" && base.toLowerCase().endsWith(".exe"))
    base = base.slice(0, -4);
  const t = base.trim();
  return t.length > 0 ? t : null;
}

function execFileTimeout(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 524_288 },
      (err, stdout) => {
        if (err) {
          const code =
            typeof (err as { code?: unknown }).code === "number"
              ? ((err as { code: number }).code as number)
              : 1;
          resolve({ code, stdout: typeof stdout === "string" ? stdout : "" });
          return;
        }
        resolve({ code: 0, stdout: typeof stdout === "string" ? stdout : "" });
      },
    );
    child.on("error", () => resolve({ code: 1, stdout: "" }));
  });
}

async function snapshotProcessTable(
  platform: NodeJS.Platform,
): Promise<ProcessTableSnapshot | null> {
  try {
    if (platform === "win32") {
      const q =
        'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }';
      const r = await execFileTimeout(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", q],
        1500,
      );
      if (r.code !== 0) return null;
      return parseWindowsProcessTable(r.stdout);
    }
    const psCmd = fs.existsSync("/bin/ps")
      ? "/bin/ps"
      : fs.existsSync("/usr/bin/ps")
        ? "/usr/bin/ps"
        : "ps";
    const r = await execFileTimeout(psCmd, ["-eo", "pid=,ppid=,comm="], 1000);
    if (r.code !== 0) return null;
    return parsePosixProcessTable(r.stdout);
  } catch {
    return null;
  }
}

export interface TerminalWireLabelInput {
  readonly terminalId: string;
  readonly hasRunningSubprocess: boolean;
  readonly childCommandLabel: string | null;
}

function terminalWireLabel(s: TerminalWireLabelInput): string {
  if (s.hasRunningSubprocess && s.childCommandLabel) {
    const t = s.childCommandLabel.trim();
    if (t.length > 0) return truncateLabel(t, MAX_TERMINAL_LABEL_LENGTH);
  }
  return truncateLabel(
    getTerminalLabel(s.terminalId),
    MAX_TERMINAL_LABEL_LENGTH,
  );
}

function snapshotOf(s: SessionState): TerminalSessionSnapshot {
  return {
    sessionId: s.sessionId,
    terminalId: s.terminalId,
    cwd: s.cwd,
    worktreePath: s.worktreePath,
    status: s.status,
    pid: s.pid,
    history: s.history,
    exitCode: s.exitCode,
    exitSignal: s.exitSignal,
    label: terminalWireLabel(s),
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
    worktreePath: s.worktreePath,
    status: s.status,
    pid: s.pid,
    exitCode: s.exitCode,
    exitSignal: s.exitSignal,
    hasRunningSubprocess: s.hasRunningSubprocess,
    label: terminalWireLabel(s),
    updatedAt: s.updatedAt,
  };
}

function compareSummaries(a: TerminalSummary, b: TerminalSummary): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  if (a.sessionId !== b.sessionId)
    return a.sessionId.localeCompare(b.sessionId);
  return a.terminalId.localeCompare(b.terminalId, undefined, { numeric: true });
}

export class TerminalManager {
  private sessions = new Map<string, SessionState>();
  private eventListeners = new Set<(ev: TerminalEvent) => void>();
  private metadataListeners = new Set<
    (ev: TerminalMetadataStreamEvent) => void
  >();
  private persistTimers = new Map<string, NodeJS.Timeout>();
  private subprocessTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly logsDir: string,
    private readonly ptyAdapter: PtyAdapter = createPtyAdapter(),
  ) {}

  async init(): Promise<void> {
    await fsp.mkdir(this.logsDir, { recursive: true }).catch(() => undefined);
  }

  initEffect(): Effect.Effect<void, TerminalError> {
    return Effect.tryPromise({
      try: () => fsp.mkdir(this.logsDir, { recursive: true }),
      catch: (cause) =>
        new TerminalCwdNotFoundError({ cwd: this.logsDir }) as TerminalError,
    }).pipe(
      Effect.asVoid,
      Effect.orElseSucceed(() => undefined),
    );
  }

  private publish(ev: TerminalEvent): void {
    for (const l of this.eventListeners) {
      try {
        l(ev);
      } catch {}
    }
    const meta = toMetadataEvent(
      ev,
      this.sessions.get(key(ev.sessionId, ev.terminalId)),
    );
    if (meta) {
      for (const l of this.metadataListeners) {
        try {
          l(meta);
        } catch {}
      }
    }
  }

  subscribe(listener: (ev: TerminalEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  subscribeEffect(
    listener: (ev: TerminalEvent) => Effect.Effect<void>,
  ): Effect.Effect<() => void> {
    return Effect.sync(() =>
      this.subscribe((ev) =>
        Effect.runSync(
          listener(ev).pipe(Effect.orElseSucceed(() => undefined)),
        ),
      ),
    );
  }

  subscribeMetadata(
    listener: (ev: TerminalMetadataStreamEvent) => void,
  ): () => void {
    const terminals = [...this.sessions.values()]
      .map(summaryOf)
      .sort(compareSummaries);
    queueMicrotask(() => listener({ type: "snapshot", terminals }));
    this.metadataListeners.add(listener);
    return () => this.metadataListeners.delete(listener);
  }

  // ---- lifecycle ----

  openEffect(
    input: TerminalOpenInput,
  ): Effect.Effect<TerminalSessionSnapshot, TerminalError> {
    return Effect.gen(this, function* () {
      const k = key(input.sessionId, input.terminalId);
      const existing = this.sessions.get(k);
      if (existing && existing.status === "running")
        return snapshotOf(existing);

      yield* Effect.tryPromise({
        try: async () => {
          const st = await fsp.stat(input.cwd);
          if (!st.isDirectory())
            throw new TerminalCwdNotDirectoryError({ cwd: input.cwd });
        },
        catch: (cause) => {
          if (cause instanceof TerminalCwdNotDirectoryError)
            return cause as TerminalError;
          const code = (cause as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT" || code === "ENOTDIR")
            return (
              code === "ENOTDIR"
                ? new TerminalCwdNotDirectoryError({ cwd: input.cwd })
                : new TerminalCwdNotFoundError({ cwd: input.cwd })
            ) as TerminalError;
          return new TerminalCwdStatError({
            cwd: input.cwd,
            cause,
          }) as TerminalError;
        },
      });

      if (existing)
        yield* Effect.promise(() => this.closeInternal(existing, false));

      const history = yield* Effect.tryPromise({
        try: () =>
          this.readHistoryWithMigration(input.sessionId, input.terminalId),
        catch: (cause) =>
          new TerminalHistoryError({
            operation: "read",
            sessionId: input.sessionId,
            terminalId: input.terminalId,
            cause,
          }) as TerminalError,
      });

      const cols = input.cols ?? DEFAULT_OPEN_COLS;
      const rows = input.rows ?? DEFAULT_OPEN_ROWS;
      const runtimeEnv = normalizedRuntimeEnv(input.env);
      const env = createTerminalSpawnEnv(process.env, runtimeEnv);
      const worktreePath = input.worktreePath ?? null;

      const state: SessionState = {
        sessionId: input.sessionId,
        terminalId: input.terminalId,
        cwd: input.cwd,
        worktreePath,
        status: "starting",
        pid: null,
        history,
        pendingHistoryControlSequence: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: new Date().toISOString(),
        cols,
        rows,
        sequence: 0,
        process: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        killTimer: null,
        hasRunningSubprocess: false,
        childCommandLabel: null,
        runtimeEnv,
      };

      // Spawn with shell-candidate fallback (t3code parity).
      const candidates = resolveShellCandidates(process.platform, process.env);
      let ptyProcess: PtyProcess | null = null;
      const attempted: string[] = [];
      let lastError: unknown = null;
      for (const c of candidates) {
        try {
          ptyProcess = this.ptyAdapter.spawn({
            shell: c.shell,
            args: c.args,
            cwd: input.cwd,
            env,
            cols,
            rows,
          });
          break;
        } catch (e) {
          attempted.push(
            c.args?.length ? `${c.shell} ${c.args.join(" ")}` : c.shell,
          );
          lastError = e;
          const retryable =
            e instanceof Error ||
            (typeof e === "object" &&
              e !== null &&
              "adapter" in (e as Record<string, unknown>))
              ? isRetryableShellSpawnError(e as PtySpawnError)
              : true;
          if (!retryable) break;
        }
      }
      if (!ptyProcess) {
        // t3code parity: failed spawn leaves an `error` session + error event.
        state.status = "error";
        state.sequence += 1;
        state.updatedAt = new Date().toISOString();
        this.sessions.set(k, state);
        this.evictIfNeeded();
        const snap = snapshotOf(state);
        this.publish({
          type: "started",
          sessionId: state.sessionId,
          terminalId: state.terminalId,
          sequence: state.sequence,
          snapshot: snap,
        });
        this.publish({
          type: "error",
          sessionId: state.sessionId,
          terminalId: state.terminalId,
          sequence: state.sequence,
          message: `Failed to spawn shell (tried: ${attempted.join(", ") || "none"}): ${lastError instanceof Error ? lastError.message : String(lastError ?? "unknown")}`,
        });
        return snap;
      }
      state.process = ptyProcess;
      state.pid = ptyProcess.pid;
      state.status = "running";
      state.sequence += 1;
      state.updatedAt = new Date().toISOString();

      const onData = (data: string) => {
        if (!this.sessions.has(k)) return;
        if (state.status !== "running") return;
        const sanitized = sanitizeTerminalHistoryChunk(
          state.pendingHistoryControlSequence,
          data,
        );
        state.pendingHistoryControlSequence = sanitized.pendingControlSequence;
        state.history = capHistory(
          state.history + sanitized.visibleText,
          HISTORY_LINE_LIMIT,
        );
        state.sequence += 1;
        state.updatedAt = new Date().toISOString();
        this.schedulePersist(state);
        this.publish({
          type: "output",
          sessionId: state.sessionId,
          terminalId: state.terminalId,
          sequence: state.sequence,
          data,
        });
      };
      const onExit = (e: { exitCode: number; signal: number | null }) => {
        if (!this.sessions.has(k)) return;
        this.clearKillTimer(state);
        try {
          state.unsubscribeData?.();
        } catch {}
        state.unsubscribeData = null;
        state.unsubscribeExit = null;
        // Flush any held split-sequence remainder (it can never complete now).
        state.pendingHistoryControlSequence = "";
        state.status = "exited";
        state.exitCode = Number.isInteger(e.exitCode) ? e.exitCode : 0;
        state.exitSignal =
          typeof e.signal === "number" && Number.isInteger(e.signal)
            ? e.signal
            : null;
        state.pid = null;
        state.process = null;
        state.hasRunningSubprocess = false;
        state.childCommandLabel = null;
        state.sequence += 1;
        state.updatedAt = new Date().toISOString();
        this.flushPersist(state).catch(() => {});
        this.publish({
          type: "exited",
          sessionId: state.sessionId,
          terminalId: state.terminalId,
          sequence: state.sequence,
          exitCode: state.exitCode,
          exitSignal: state.exitSignal,
        });
        this.evictIfNeeded();
        this.ensureSubprocessPoller();
      };
      state.unsubscribeData = ptyProcess.onData(onData);
      state.unsubscribeExit = ptyProcess.onExit(onExit);

      this.sessions.set(k, state);
      this.evictIfNeeded();
      this.ensureSubprocessPoller();
      const snap = snapshotOf(state);
      this.publish({
        type: "started",
        sessionId: state.sessionId,
        terminalId: state.terminalId,
        sequence: state.sequence,
        snapshot: snap,
      });
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
                : e._tag === "TerminalCwdStatError"
                  ? "stat_error"
                  : e._tag === "TerminalHistoryError"
                    ? "history_error"
                    : "unknown";
          return Effect.fail(Object.assign(new Error(e.message), { code }));
        }),
      ),
    ) as Promise<TerminalSessionSnapshot>;
  }

  private async readHistoryWithMigration(
    sessionId: string,
    terminalId: string,
  ): Promise<string> {
    const hp = historyPath(this.logsDir, sessionId, terminalId);
    if (fs.existsSync(hp)) {
      const raw = await fsp.readFile(hp, "utf8");
      const capped = capHistory(raw, HISTORY_LINE_LIMIT);
      if (capped !== raw)
        await fsp.writeFile(hp, capped, "utf8").catch(() => undefined);
      return capped;
    }
    // One-way legacy migration (regex-named file -> base64url file).
    const legacy = legacyHistoryPath(this.logsDir, sessionId, terminalId);
    if (legacy !== hp && fs.existsSync(legacy)) {
      try {
        const raw = await fsp.readFile(legacy, "utf8");
        const capped = capHistory(raw, HISTORY_LINE_LIMIT);
        await fsp.writeFile(hp, capped, "utf8");
        await fsp.unlink(legacy).catch(() => undefined);
        return capped;
      } catch (e) {
        throw new TerminalHistoryError({
          operation: "migrate",
          sessionId,
          terminalId,
          cause: e,
        });
      }
    }
    return "";
  }

  private schedulePersist(state: SessionState): void {
    const k = key(state.sessionId, state.terminalId);
    if (this.persistTimers.has(k)) return;
    this.persistTimers.set(
      k,
      setTimeout(() => {
        this.persistTimers.delete(k);
        this.flushPersist(state).catch(() => {});
      }, PERSIST_DEBOUNCE_MS),
    );
  }

  private async flushPersist(state: SessionState): Promise<void> {
    try {
      await fsp.writeFile(
        historyPath(this.logsDir, state.sessionId, state.terminalId),
        state.history,
        "utf8",
      );
    } catch {}
  }

  private clearKillTimer(state: SessionState): void {
    if (state.killTimer) {
      clearTimeout(state.killTimer);
      state.killTimer = null;
    }
  }

  attachStreamEffect(
    input: TerminalAttachInput,
    send: (ev: TerminalAttachStreamEvent) => void,
  ): Effect.Effect<() => void, TerminalError> {
    return Effect.gen(this, function* () {
      let state =
        this.sessions.get(key(input.sessionId, input.terminalId)) ?? null;
      if (!state && input.restartIfNotRunning) {
        const snap = yield* this.openEffect({
          sessionId: input.sessionId,
          terminalId: input.terminalId,
          cwd: input.cwd ?? os.homedir(),
          worktreePath: input.worktreePath,
          cols: input.cols,
          rows: input.rows,
          env: input.env,
        });
        state = this.sessions.get(key(input.sessionId, input.terminalId))!;
        send({ type: "snapshot", snapshot: snap });
      } else if (!state) {
        return yield* Effect.fail(
          new TerminalSessionLookupError({
            sessionId: input.sessionId,
            terminalId: input.terminalId,
          }),
        );
      } else {
        if (
          input.cols !== undefined &&
          input.rows !== undefined &&
          state.process &&
          state.status === "running"
        ) {
          if (input.cols !== state.cols || input.rows !== state.rows) {
            yield* Effect.try({
              try: () => {
                state!.process!.resize(input.cols!, input.rows!);
                state!.cols = input.cols!;
                state!.rows = input.rows!;
                state!.updatedAt = new Date().toISOString();
              },
              catch: (cause) =>
                new TerminalResizeError({
                  sessionId: state!.sessionId,
                  terminalId: state!.terminalId,
                  terminalPid: state!.pid ?? 0,
                  cols: input.cols!,
                  rows: input.rows!,
                  cause,
                }),
            });
          }
        }
        const snap = snapshotOf(state);
        send({ type: "snapshot", snapshot: snap });
      }

      const initialSequence = state.sequence;
      const listener = (ev: TerminalEvent) => {
        if (
          ev.sessionId !== input.sessionId ||
          ev.terminalId !== input.terminalId
        )
          return;
        // Dedup: skip events the snapshot already includes (t3code parity).
        if (
          typeof ev.sequence === "number" &&
          ev.sequence <= initialSequence &&
          ev.type !== "closed"
        )
          return;
        const attached = toAttachEvent(ev);
        if (attached) send(attached);
      };
      this.eventListeners.add(listener);
      return () => this.eventListeners.delete(listener);
    });
  }

  async attachStream(
    input: TerminalAttachInput,
    send: (ev: TerminalAttachStreamEvent) => void,
  ): Promise<() => void> {
    return Effect.runPromise(
      this.attachStreamEffect(input, send).pipe(
        Effect.catchAll((e) =>
          Effect.fail(
            Object.assign(new Error(e.message), { code: "not_found" }),
          ),
        ),
      ),
    ) as Promise<() => void>;
  }

  writeEffect(input: TerminalWriteInput): Effect.Effect<void, TerminalError> {
    return Effect.gen(this, function* () {
      const s = this.sessions.get(key(input.sessionId, input.terminalId));
      if (!s)
        return yield* Effect.fail(
          new TerminalSessionLookupError({
            sessionId: input.sessionId,
            terminalId: input.terminalId,
          }),
        );
      // t3code parity: writes to an exited terminal are a silent no-op.
      if (s.status === "exited") return;
      if (!s.process || s.status !== "running")
        return yield* Effect.fail(
          new TerminalNotRunningError({
            sessionId: input.sessionId,
            terminalId: input.terminalId,
          }),
        );
      yield* Effect.try({
        try: () => s.process!.write(input.data),
        catch: (cause) =>
          new TerminalWriteError({
            sessionId: input.sessionId,
            terminalId: input.terminalId,
            terminalPid: s.pid ?? 0,
            cause,
          }),
      });
    });
  }

  async write(input: TerminalWriteInput): Promise<void> {
    return Effect.runPromise(
      this.writeEffect(input).pipe(
        Effect.catchAll((e) =>
          Effect.fail(
            Object.assign(new Error(e.message), {
              code:
                e._tag === "TerminalSessionLookupError" ||
                e._tag === "TerminalNotFoundError"
                  ? "not_found"
                  : e._tag === "TerminalNotRunningError"
                    ? "not_running"
                    : "write_failed",
            }),
          ),
        ),
      ),
    ) as Promise<void>;
  }

  resizeEffect(input: TerminalResizeInput): Effect.Effect<void, TerminalError> {
    return Effect.gen(this, function* () {
      const s = this.sessions.get(key(input.sessionId, input.terminalId));
      if (!s)
        return yield* Effect.fail(
          new TerminalSessionLookupError({
            sessionId: input.sessionId,
            terminalId: input.terminalId,
          }),
        );
      if (!s.process || s.status !== "running")
        return yield* Effect.fail(
          new TerminalNotRunningError({
            sessionId: input.sessionId,
            terminalId: input.terminalId,
          }),
        );
      if (s.cols === input.cols && s.rows === input.rows) return;
      yield* Effect.try({
        try: () => {
          s.process!.resize(input.cols, input.rows);
          s.cols = input.cols;
          s.rows = input.rows;
          s.updatedAt = new Date().toISOString();
        },
        catch: (cause) =>
          new TerminalResizeError({
            sessionId: input.sessionId,
            terminalId: input.terminalId,
            terminalPid: s.pid ?? 0,
            cols: input.cols,
            rows: input.rows,
            cause,
          }),
      });
    });
  }

  async resize(input: TerminalResizeInput): Promise<void> {
    return Effect.runPromise(
      this.resizeEffect(input).pipe(
        Effect.catchAll((e) =>
          Effect.fail(
            Object.assign(new Error((e as Error).message), {
              code:
                (e as { _tag?: string })._tag ===
                  "TerminalSessionLookupError" ||
                (e as { _tag?: string })._tag === "TerminalNotFoundError"
                  ? "not_found"
                  : "resize_failed",
            }),
          ),
        ),
      ),
    ) as Promise<void>;
  }

  clearEffect(input: TerminalClearInput): Effect.Effect<void, TerminalError> {
    return Effect.gen(this, function* () {
      const s = this.sessions.get(key(input.sessionId, input.terminalId));
      if (!s)
        return yield* Effect.fail(
          new TerminalSessionLookupError({
            sessionId: input.sessionId,
            terminalId: input.terminalId,
          }),
        );
      s.history = "";
      s.pendingHistoryControlSequence = "";
      s.sequence += 1;
      s.updatedAt = new Date().toISOString();
      const timer = this.persistTimers.get(key(s.sessionId, s.terminalId));
      if (timer) {
        clearTimeout(timer);
        this.persistTimers.delete(key(s.sessionId, s.terminalId));
      }
      yield* Effect.tryPromise({
        try: () =>
          fsp.writeFile(
            historyPath(this.logsDir, s.sessionId, s.terminalId),
            "",
            "utf8",
          ),
        catch: (cause) =>
          new TerminalHistoryError({
            operation: "truncate",
            sessionId: s.sessionId,
            terminalId: s.terminalId,
            cause,
          }) as TerminalError,
      });
      this.publish({
        type: "cleared",
        sessionId: s.sessionId,
        terminalId: s.terminalId,
        sequence: s.sequence,
      });
    });
  }

  async clear(input: TerminalClearInput): Promise<void> {
    return Effect.runPromise(
      this.clearEffect(input).pipe(
        Effect.catchAll((e) =>
          Effect.fail(
            Object.assign(new Error(e.message), { code: "not_found" }),
          ),
        ),
      ),
    ) as Promise<void>;
  }

  restartEffect(
    input: TerminalRestartInput,
  ): Effect.Effect<TerminalSessionSnapshot, TerminalError> {
    return Effect.gen(this, function* () {
      const k = key(input.sessionId, input.terminalId);
      const existing = this.sessions.get(k);
      // cwd is optional: reuse the stored session cwd so a dead shell is
      // always restartable even when the caller has no summary (t3code
      // requires cwd; this accepts a superset for the mobile UX).
      const cwd = input.cwd ?? existing?.cwd;
      if (!cwd) {
        return yield* Effect.fail(
          new TerminalSessionLookupError({
            sessionId: input.sessionId,
            terminalId: input.terminalId,
          }),
        );
      }
      if (existing)
        yield* Effect.promise(() => this.closeInternal(existing, false));
      const hp = historyPath(this.logsDir, input.sessionId, input.terminalId);
      yield* Effect.tryPromise({
        try: () => fsp.writeFile(hp, "", "utf8"),
        catch: (cause) =>
          new TerminalHistoryError({
            operation: "truncate",
            sessionId: input.sessionId,
            terminalId: input.terminalId,
            cause,
          }) as TerminalError,
      });
      const snap = yield* this.openEffect({
        sessionId: input.sessionId,
        terminalId: input.terminalId,
        cwd,
        worktreePath: input.worktreePath,
        cols: input.cols,
        rows: input.rows,
        env: input.env,
      });
      this.publish({
        type: "restarted",
        sessionId: snap.sessionId,
        terminalId: snap.terminalId,
        sequence: snap.sequence,
        snapshot: snap,
      });
      return snap;
    });
  }

  async restart(input: TerminalRestartInput): Promise<TerminalSessionSnapshot> {
    return Effect.runPromise(
      this.restartEffect(input),
    ) as Promise<TerminalSessionSnapshot>;
  }

  closeEffect(input: TerminalCloseInput): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (!input.terminalId) {
        const toClose = [...this.sessions.values()].filter(
          (s) => s.sessionId === input.sessionId,
        );
        for (const s of toClose)
          yield* Effect.promise(() =>
            this.closeInternal(s, input.deleteHistory ?? false),
          );
        return;
      }
      const s = this.sessions.get(key(input.sessionId, input.terminalId));
      if (!s) return;
      yield* Effect.promise(() =>
        this.closeInternal(s, input.deleteHistory ?? false),
      );
    });
  }

  async close(input: TerminalCloseInput): Promise<void> {
    return Effect.runPromise(this.closeEffect(input));
  }

  private async closeInternal(
    s: SessionState,
    deleteHistory: boolean,
  ): Promise<void> {
    this.clearKillTimer(s);
    const timer = this.persistTimers.get(key(s.sessionId, s.terminalId));
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(key(s.sessionId, s.terminalId));
    }
    try {
      s.unsubscribeData?.();
    } catch {}
    try {
      s.unsubscribeExit?.();
    } catch {}
    s.unsubscribeData = null;
    s.unsubscribeExit = null;
    const pid = s.pid;
    try {
      s.process?.kill("SIGTERM");
    } catch {
      if (pid !== null) {
        try {
          s.process?.kill("SIGKILL");
        } catch {}
      }
    }
    if (s.process && pid !== null) {
      // Tracked escalation: SIGKILL after grace, cleared on natural exit.
      s.killTimer = setTimeout(() => {
        s.killTimer = null;
        try {
          s.process?.kill("SIGKILL");
        } catch {}
      }, PROCESS_KILL_GRACE_MS);
      if (
        typeof (s.killTimer as unknown as { unref?: () => void }).unref ===
        "function"
      ) {
        (s.killTimer as unknown as { unref: () => void }).unref();
      }
    }
    s.process = null;
    s.pid = null;

    this.sessions.delete(key(s.sessionId, s.terminalId));
    s.sequence += 1;
    this.publish({
      type: "closed",
      sessionId: s.sessionId,
      terminalId: s.terminalId,
      sequence: s.sequence,
    });

    if (deleteHistory) {
      try {
        await fsp.unlink(historyPath(this.logsDir, s.sessionId, s.terminalId));
      } catch {}
    }
    this.ensureSubprocessPoller();
  }

  /** Remove one session's persisted history (used by tests/cleanup). */
  async deleteHistory(sessionId: string, terminalId: string): Promise<void> {
    try {
      await fsp.unlink(historyPath(this.logsDir, sessionId, terminalId));
    } catch {}
  }

  private evictIfNeeded(): void {
    const inactive = [...this.sessions.values()].filter(
      (s) => s.status !== "running",
    );
    if (inactive.length <= MAX_RETAINED_INACTIVE) return;
    inactive.sort(
      (a, b) =>
        a.updatedAt.localeCompare(b.updatedAt) ||
        a.sessionId.localeCompare(b.sessionId) ||
        a.terminalId.localeCompare(b.terminalId, undefined, { numeric: true }),
    );
    const toEvict = inactive.slice(0, inactive.length - MAX_RETAINED_INACTIVE);
    for (const s of toEvict) {
      this.sessions.delete(key(s.sessionId, s.terminalId));
    }
  }

  list(sessionId?: string): TerminalSummary[] {
    const all = [...this.sessions.values()];
    const filtered = sessionId
      ? all.filter((s) => s.sessionId === sessionId)
      : all;
    return filtered.map(summaryOf).sort(compareSummaries);
  }

  listEffect(
    sessionId?: string,
  ): Effect.Effect<ReadonlyArray<TerminalSummary>> {
    return Effect.succeed(this.list(sessionId));
  }

  // --- subprocess poller (shared 1s snapshot, t3code parity) ---

  private ensureSubprocessPoller(): void {
    const anyRunning = [...this.sessions.values()].some(
      (s) => s.status === "running" && s.pid !== null,
    );
    if (!anyRunning) {
      if (this.subprocessTimer) {
        clearInterval(this.subprocessTimer);
        this.subprocessTimer = null;
      }
      return;
    }
    if (this.subprocessTimer) return;
    this.subprocessTimer = setInterval(() => {
      void this.pollSubprocesses().catch(() => undefined);
    }, SUBPROCESS_POLL_INTERVAL_MS);
    if (
      typeof (this.subprocessTimer as unknown as { unref?: () => void })
        .unref === "function"
    ) {
      (this.subprocessTimer as unknown as { unref: () => void }).unref();
    }
  }

  private async pollSubprocesses(): Promise<void> {
    const running = [...this.sessions.values()].filter(
      (s) => s.status === "running" && s.pid !== null,
    );
    if (running.length === 0) return;
    const table = await snapshotProcessTable(process.platform);
    if (!table) return; // not authoritative — skip the tick (t3code parity)
    for (const s of running) {
      if (!this.sessions.has(key(s.sessionId, s.terminalId))) continue;
      const pid = s.pid;
      if (pid === null) continue;
      const childPid = (table.childrenByParent.get(pid) ?? [])[0];
      const has = childPid !== undefined;
      let cmd: string | null = null;
      if (has) {
        const raw = table.commandById.get(childPid!) ?? "";
        const norm = normalizeChildCommandName(raw, process.platform);
        cmd = norm ? truncateLabel(norm, MAX_TERMINAL_LABEL_LENGTH) : null;
      }
      if (s.hasRunningSubprocess === has && s.childCommandLabel === cmd)
        continue;
      s.hasRunningSubprocess = has;
      s.childCommandLabel = has ? cmd : null;
      s.sequence += 1;
      s.updatedAt = new Date().toISOString();
      this.publish({
        type: "activity",
        sessionId: s.sessionId,
        terminalId: s.terminalId,
        sequence: s.sequence,
        hasRunningSubprocess: has,
        label: terminalWireLabel(s),
      });
    }
  }

  async shutdown(): Promise<void> {
    if (this.subprocessTimer) {
      clearInterval(this.subprocessTimer);
      this.subprocessTimer = null;
    }
    for (const [, t] of this.persistTimers) clearTimeout(t);
    this.persistTimers.clear();
    await Effect.runPromise(
      Effect.forEach([...this.sessions.values()], (s) =>
        Effect.try(() => {
          this.clearKillTimer(s);
          s.process?.kill("SIGTERM");
          const pid = s.pid;
          if (pid !== null) {
            const timer = setTimeout(() => {
              try {
                s.process?.kill("SIGKILL");
              } catch {}
            }, PROCESS_KILL_GRACE_MS);
            if (
              typeof (timer as unknown as { unref?: () => void }).unref ===
              "function"
            ) {
              (timer as unknown as { unref: () => void }).unref();
            }
          }
        }).pipe(Effect.orElseSucceed(() => undefined)),
      ).pipe(Effect.orElseSucceed(() => undefined)),
    );
  }

  shutdownEffect(): Effect.Effect<void> {
    return Effect.promise(() => this.shutdown());
  }
}

function toMetadataEvent(
  ev: TerminalEvent,
  s: SessionState | undefined,
): TerminalMetadataStreamEvent | null {
  switch (ev.type) {
    case "started":
    case "restarted":
    case "exited":
    case "activity":
      return s ? { type: "upsert", terminal: summaryOf(s) } : null;
    case "closed":
      return {
        type: "remove",
        sessionId: ev.sessionId,
        terminalId: ev.terminalId,
      };
    case "error":
      return s ? { type: "upsert", terminal: summaryOf(s) } : null;
    case "output":
    case "cleared":
      return null;
  }
}

function toAttachEvent(ev: TerminalEvent): TerminalAttachStreamEvent | null {
  switch (ev.type) {
    case "started":
      return { type: "snapshot", snapshot: ev.snapshot };
    case "output":
    case "exited":
    case "closed":
    case "error":
    case "cleared":
    case "restarted":
    case "activity":
      return ev as TerminalAttachStreamEvent;
  }
}

export const TerminalManagerLive = (logsDir: string, ptyAdapter?: PtyAdapter) =>
  Layer.succeed(TerminalManagerTag, new TerminalManager(logsDir, ptyAdapter));

// Pure helpers exported for focused unit tests (t3code tests these via the
// Manager layers; here they are importable directly).
export {
  sanitizeTerminalHistoryChunk,
  createTerminalSpawnEnv,
  capHistory,
  historyFileName,
  resolveShellCandidates,
  isRetryableShellSpawnError,
  terminalWireLabel,
};
