/**
 * Attached terminal session hook — t3code `use-terminal-session.ts` ported to
 * this app's RpcClient (sessionId scoping instead of environment+thread).
 *
 * - `useAttachedTerminalSession`: opens/attaches a single terminal and folds
 *   the `terminal.attach` event stream into buffer state via
 *   `applyTerminalAttachStreamEvent`.
 * - `useKnownTerminalSessions`: keeps the `terminal.list` snapshot fresh via
 *   the global `terminal` channel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  TerminalAttachStreamEvent,
  TerminalSummary,
} from "../../lib/terminalProtocol";
import type { RpcClient } from "../../lib/client";
import {
  EMPTY_TERMINAL_BUFFER_STATE,
  applyTerminalAttachStreamEvent,
  combineTerminalSessionState,
  type TerminalBufferState,
  type TerminalSessionState,
} from "./terminalSession";

export interface AttachedTerminalInput {
  readonly sessionId: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env?: Record<string, string>;
  readonly restartIfNotRunning?: boolean;
}

function isAttachEvent(payload: unknown): payload is TerminalAttachStreamEvent {
  if (typeof payload !== "object" || payload === null) return false;
  const t = (payload as { type?: unknown }).type;
  return (
    t === "snapshot" ||
    t === "output" ||
    t === "exited" ||
    t === "closed" ||
    t === "error" ||
    t === "cleared" ||
    t === "restarted" ||
    t === "activity" ||
    t === "started"
  );
}

export function useAttachedTerminalSession(input: {
  client: RpcClient | null;
  sessionId: string;
  terminal: AttachedTerminalInput | null;
}): TerminalSessionState {
  const { client, sessionId, terminal } = input;
  const [bufferState, setBufferState] = useState<TerminalBufferState>(EMPTY_TERMINAL_BUFFER_STATE);
  const [summary, setSummary] = useState<TerminalSummary | null>(null);

  const terminalId = terminal?.terminalId ?? null;
  const channel = terminalId ? `terminal:${sessionId}:${terminalId}` : null;
  // Identity key is session + terminal ONLY. Grid size, cwd, and env change
  // over a session's life (keyboard open/close resizes the surface,
  // metadata fills in the cwd) and must never resubscribe — resubscribing
  // wipes the buffer back to version 0 and flashes "Starting shell…".
  // Size updates travel via `terminal.resize`; the subscribe call below reads
  // the latest size from a ref.
  const attachKey = terminalId ? `${sessionId}:${terminalId}` : null;

  const sizeRef = useRef({ cols: 80, rows: 24 });
  sizeRef.current = {
    cols: terminal?.cols ?? 80,
    rows: terminal?.rows ?? 24,
  };
  const cwdRef = useRef(terminal?.cwd ?? "");
  cwdRef.current = terminal?.cwd ?? "";
  const envRef = useRef(terminal?.env);
  envRef.current = terminal?.env;

  useEffect(() => {
    if (!client || !terminalId || !channel || !attachKey) return;
    let cancelled = false;

    setBufferState(EMPTY_TERMINAL_BUFFER_STATE);
    setSummary(null);

    const off = client.onEvent((ch, payload) => {
      if (cancelled || ch !== channel || !isAttachEvent(payload)) return;
      const ev = payload as TerminalAttachStreamEvent & { snapshot?: { cwd?: string } };
      setBufferState((prev) => applyTerminalAttachStreamEvent(prev, ev));
      if ((ev.type === "snapshot" || ev.type === "restarted") && ev.snapshot) {
        const snapshot = ev.snapshot;
        const tid = terminalId;
        setSummary((prev) => ({
          sessionId,
          terminalId: tid,
          cwd: snapshot.cwd ?? prev?.cwd ?? cwdRef.current,
          status: snapshot.status,
          pid: snapshot.pid,
          exitCode: snapshot.exitCode,
          exitSignal: snapshot.exitSignal,
          hasRunningSubprocess: prev?.hasRunningSubprocess ?? false,
          label: snapshot.label,
          updatedAt: snapshot.updatedAt,
        }));
      } else if (ev.type === "activity" && "hasRunningSubprocess" in ev) {
        const a = ev as { hasRunningSubprocess: boolean; label: string };
        setSummary((prev) =>
          prev ? { ...prev, hasRunningSubprocess: a.hasRunningSubprocess, label: a.label } : prev,
        );
      } else if (ev.type === "exited") {
        setSummary((prev) =>
          prev
            ? { ...prev, status: "exited", exitCode: ev.exitCode, exitSignal: ev.exitSignal }
            : prev,
        );
      }
    });

    const { cols, rows } = sizeRef.current;
    client.subscribe("terminal.attach", {
      sessionId,
      terminalId,
      ...(cols ? { cols } : {}),
      ...(rows ? { rows } : {}),
      restartIfNotRunning: true,
    });

    // If attach lands on a dead session without restart, explicitly open it —
    // mirrors t3code's stale-reopen path (dead status + processed events).
    // Only when a cwd is known; otherwise the attach `restartIfNotRunning`
    // flag already lets the server open with the home directory.
    const staleTimer = setTimeout(async () => {
      if (cancelled) return;
      try {
        const list = (await client.call("terminal.list", { sessionId })) as TerminalSummary[];
        const found = list.find((s) => s.terminalId === terminalId);
        const cwd = cwdRef.current || found?.cwd || "";
        if ((!found || found.status === "exited" || found.status === "error") && cwd) {
          const size = sizeRef.current;
          await client.call("terminal.open", {
            sessionId,
            terminalId,
            cwd,
            cols: size.cols,
            rows: size.rows,
            ...(envRef.current ? { env: envRef.current } : {}),
          });
        }
      } catch {}
    }, 1200);

    return () => {
      cancelled = true;
      clearTimeout(staleTimer);
      off();
    };
  }, [attachKey, channel, client, sessionId, terminalId]);

  return useMemo(() => combineTerminalSessionState(summary, bufferState), [summary, bufferState]);
}

export interface KnownTerminalSession {
  readonly terminalId: string;
  readonly summary: TerminalSummary | null;
  readonly status: "starting" | "running" | "exited" | "error" | "closed";
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
}

export function useKnownTerminalSessions(input: {
  client: RpcClient | null;
  sessionId: string;
}): KnownTerminalSession[] {
  const { client, sessionId } = input;
  const [summaries, setSummaries] = useState<TerminalSummary[]>([]);

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      const list = (await client.call("terminal.list", { sessionId })) as TerminalSummary[];
      setSummaries(Array.isArray(list) ? list : []);
    } catch {}
  }, [client, sessionId]);

  useEffect(() => {
    void refresh();
    if (!client) return;
    client.subscribe("terminal.subscribe", {});
    const off = client.onEvent((channel, payload) => {
      if (channel !== "terminal") return;
      const ev = payload as { type?: string; sessionId?: string } & Record<string, unknown>;
      if (ev.sessionId && ev.sessionId !== sessionId) return;
      void refresh();
    });
    const timer = setInterval(refresh, 5000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [client, refresh, sessionId]);

  return useMemo<KnownTerminalSession[]>(
    () =>
      summaries
        .map((s) => ({
          terminalId: s.terminalId,
          summary: s,
          status: s.status,
          hasRunningSubprocess: s.hasRunningSubprocess,
          updatedAt: s.updatedAt,
        }))
        .sort((a, b) => a.terminalId.localeCompare(b.terminalId, undefined, { numeric: true })),
    [summaries],
  );
}
