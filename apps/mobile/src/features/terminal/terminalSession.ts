/**
 * Terminal session state — ported 1:1 from t3code
 * `packages/client-runtime/src/state/terminalSession.ts` (Effect-free).
 *
 * t3code scopes terminals by (environment, thread, terminal); this app scopes
 * by (sessionId, terminalId) — the event shapes are otherwise identical.
 */
import type {
  TerminalAttachStreamEvent,
  TerminalRuntimeStatus,
  TerminalSessionSnapshot,
  TerminalSummary,
} from "../../lib/terminalProtocol";

export type { TerminalRuntimeStatus } from "../../lib/terminalProtocol";

export interface TerminalSessionState {
  readonly summary: TerminalSummary | null;
  readonly buffer: string;
  readonly status: TerminalRuntimeStatus;
  readonly error: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
  readonly version: number;
}

export interface TerminalBufferState {
  readonly buffer: string;
  readonly status: TerminalRuntimeStatus;
  readonly error: string | null;
  readonly updatedAt: string | null;
  readonly version: number;
}

export const EMPTY_TERMINAL_BUFFER_STATE = Object.freeze<TerminalBufferState>({
  buffer: "",
  status: "closed",
  error: null,
  updatedAt: null,
  version: 0,
});

export const EMPTY_TERMINAL_SESSION_STATE = Object.freeze<TerminalSessionState>({
  summary: null,
  buffer: "",
  status: "closed",
  error: null,
  hasRunningSubprocess: false,
  updatedAt: null,
  version: 0,
});

export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function trimBufferToBytes(buffer: string, maxBufferBytes: number): string {
  if (maxBufferBytes <= 0) {
    return "";
  }

  const encoded = textEncoder.encode(buffer);
  if (encoded.byteLength <= maxBufferBytes) {
    return buffer;
  }

  let start = encoded.byteLength - maxBufferBytes;
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    start += 1;
  }

  return textDecoder.decode(encoded.subarray(start));
}

export function terminalBufferStateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
): TerminalBufferState {
  return {
    buffer: trimBufferToBytes(snapshot.history, maxBufferBytes),
    status: snapshot.status,
    error: null,
    updatedAt: snapshot.updatedAt,
    version: 1,
  };
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function combineTerminalSessionState(
  summary: TerminalSummary | null,
  buffer: TerminalBufferState,
): TerminalSessionState {
  return {
    summary,
    buffer: buffer.buffer,
    status: buffer.version > 0 ? buffer.status : (summary?.status ?? buffer.status),
    error: buffer.error,
    hasRunningSubprocess: summary?.hasRunningSubprocess ?? false,
    updatedAt: latestTimestamp(summary?.updatedAt ?? null, buffer.updatedAt),
    version: buffer.version,
  };
}

export function applyTerminalAttachStreamEvent(
  current: TerminalBufferState,
  event: TerminalAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalBufferState {
  switch (event.type) {
    case "snapshot":
    case "restarted":
      return terminalBufferStateFromSnapshot(event.snapshot, maxBufferBytes);
    case "output":
      return {
        ...current,
        buffer: trimBufferToBytes(`${current.buffer}${event.data}`, maxBufferBytes),
        status: current.status === "closed" ? "running" : current.status,
        error: null,
        version: current.version + 1,
      };
    case "cleared":
      return {
        ...current,
        buffer: "",
        error: null,
        version: current.version + 1,
      };
    case "exited":
      return {
        ...current,
        status: "exited",
        error: null,
        version: current.version + 1,
      };
    case "closed":
      return {
        ...current,
        status: "closed",
        error: null,
        version: current.version + 1,
      };
    case "error":
      return {
        ...current,
        status: "error",
        error: event.message,
        version: current.version + 1,
      };
    case "activity":
      return current;
  }
}

export function applyTerminalSummaryEvent(
  current: ReadonlyArray<TerminalSummary>,
  event: { type: string; terminal?: TerminalSummary; sessionId?: string; terminalId?: string },
): ReadonlyArray<TerminalSummary> {
  if (event.type === "snapshot" && Array.isArray((event as unknown as { terminals?: unknown }).terminals)) {
    return (event as unknown as { terminals: TerminalSummary[] }).terminals;
  }
  if (event.type === "remove" || event.type === "closed") {
    return current.filter(
      (t) => t.sessionId !== event.sessionId || t.terminalId !== event.terminalId,
    );
  }
  if (event.terminal) {
    const next = current.filter(
      (t) => t.sessionId !== event.terminal!.sessionId || t.terminalId !== event.terminal!.terminalId,
    );
    return [...next, event.terminal];
  }
  return current;
}
