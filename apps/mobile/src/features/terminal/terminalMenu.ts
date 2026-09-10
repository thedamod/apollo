/**
 * Terminal menu helpers — ported 1:1 from t3code
 * `apps/mobile/src/features/terminal/terminalMenu.ts` (Effect-free).
 */
import { DEFAULT_TERMINAL_ID, type TerminalSummary } from "../../lib/terminalProtocol";
import {
  getTerminalLabel,
  nextTerminalId,
  resolveTerminalSessionLabel,
} from "@home-server/shared/terminalLabels";

export { getTerminalLabel, nextTerminalId, resolveTerminalSessionLabel };

export interface TerminalMenuSession {
  readonly terminalId: string;
  readonly cwd: string | null;
  readonly status: "starting" | "running" | "exited" | "error" | "closed";
  readonly hasRunningSubprocess: boolean;
  /** Server-authoritative title with the same fallback rules as t3code web. */
  readonly displayLabel: string;
  readonly updatedAt: string | null;
}

function compareTerminalIds(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

function sortMenuSessions(
  sessions: ReadonlyArray<TerminalMenuSession>,
): TerminalMenuSession[] {
  return [...sessions].sort((a, b) => compareTerminalIds(a.terminalId, b.terminalId));
}

export function basename(input: string | null): string | null {
  if (!input) {
    return null;
  }

  const normalized = input.replace(/\/+$/, "");
  if (normalized.length === 0) {
    return "/";
  }

  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? normalized;
}

export function getTerminalStatusLabel(input: {
  readonly status: TerminalMenuSession["status"];
  readonly hasRunningSubprocess?: boolean;
}): string {
  if (input.status === "running") {
    return input.hasRunningSubprocess ? "Task running" : "Ready";
  }
  if (input.status === "starting") {
    return "Starting";
  }
  if (input.status === "exited") {
    return "Exited";
  }
  if (input.status === "error") {
    return "Error";
  }

  return "Not started";
}

/**
 * Picks an id for "open another shell". Counts the already-mounted terminal
 * (`activeRouteTerminalId`) as occupied so an empty session list still
 * advances to `term-2` instead of re-selecting the same tab.
 */
export function nextOpenTerminalId(input: {
  readonly listedTerminalIds: ReadonlyArray<string>;
  readonly activeRouteTerminalId?: string | null;
}): string {
  const listed = input.listedTerminalIds.filter((id) => id.trim().length > 0);
  const routeId = input.activeRouteTerminalId?.trim() ? input.activeRouteTerminalId : null;

  if (!routeId || listed.includes(routeId)) {
    return nextTerminalId(listed);
  }

  return nextTerminalId([...listed, routeId]);
}

export interface KnownTerminalSessionLike {
  readonly terminalId: string;
  readonly summary: TerminalSummary | null;
  readonly status: TerminalMenuSession["status"];
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
}

export function buildTerminalMenuSessions(input: {
  readonly knownSessions: ReadonlyArray<KnownTerminalSessionLike>;
  readonly workspaceRoot: string | null;
  readonly currentSession?: TerminalMenuSession | null;
}): ReadonlyArray<TerminalMenuSession> {
  const sessionsById = new Map<string, TerminalMenuSession>();

  for (const session of input.knownSessions) {
    if (
      session.status !== "running" &&
      session.status !== "starting" &&
      session.terminalId !== input.currentSession?.terminalId
    ) {
      continue;
    }

    sessionsById.set(session.terminalId, {
      terminalId: session.terminalId,
      cwd: session.summary?.cwd ?? input.workspaceRoot,
      status: session.status,
      hasRunningSubprocess: session.hasRunningSubprocess,
      displayLabel: resolveTerminalSessionLabel(session.terminalId, session.summary),
      updatedAt: session.updatedAt,
    });
  }

  if (input.currentSession && !sessionsById.has(input.currentSession.terminalId)) {
    sessionsById.set(input.currentSession.terminalId, input.currentSession);
  }

  return sortMenuSessions([...sessionsById.values()]);
}

/**
 * Picks the session to show after a terminal exits: the nearest live session
 * below the exited id (terminal n-1), falling back to the nearest one above.
 * Returns null when no other live session remains.
 */
export function previousLiveTerminalId(input: {
  readonly sessions: ReadonlyArray<TerminalMenuSession>;
  readonly exitedTerminalId: string;
}): string | null {
  const live = sortMenuSessions(
    input.sessions.filter(
      (session) =>
        session.terminalId !== input.exitedTerminalId &&
        (session.status === "running" || session.status === "starting"),
    ),
  );
  if (live.length === 0) {
    return null;
  }

  const below = live.filter((session) => compareTerminalIds(session.terminalId, input.exitedTerminalId) < 0);
  return (below[below.length - 1] ?? live[0])?.terminalId ?? null;
}

export function resolveDefaultTerminalId(input: {
  readonly existingTerminalIds: ReadonlyArray<string>;
  readonly hasRunningTerminal: boolean;
}): string {
  if (!input.hasRunningTerminal) {
    return DEFAULT_TERMINAL_ID;
  }

  return nextTerminalId(input.existingTerminalIds);
}
