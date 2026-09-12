/**
 * Pending terminal launch context — ported from t3code
 * `apps/mobile/src/features/terminal/terminalLaunchContext.ts`.
 *
 * Keyed by `(sessionId, terminalId)` instead of t3code's
 * `(environmentId, threadId, terminalId)`; worktree concepts are omitted
 * (this app has no worktrees — `worktreePath` is always null).
 */

export interface PendingTerminalLaunch {
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly initialInput?: string;
}

export interface PendingTerminalLaunchTarget {
  readonly sessionId: string;
  readonly terminalId: string;
}

const pendingTerminalLaunches = new Map<string, PendingTerminalLaunch>();

function pendingTerminalLaunchKey(input: PendingTerminalLaunchTarget): string {
  return `${input.sessionId}:${input.terminalId}`;
}

export function stagePendingTerminalLaunch(input: {
  readonly target: PendingTerminalLaunchTarget;
  readonly launch: PendingTerminalLaunch;
}): void {
  pendingTerminalLaunches.set(pendingTerminalLaunchKey(input.target), {
    cwd: input.launch.cwd,
    env: input.launch.env ? { ...input.launch.env } : undefined,
    initialInput: input.launch.initialInput,
  });
}

export function takePendingTerminalLaunch(
  target: PendingTerminalLaunchTarget,
): PendingTerminalLaunch | null {
  const key = pendingTerminalLaunchKey(target);
  const launch = pendingTerminalLaunches.get(key) ?? null;
  if (launch) {
    pendingTerminalLaunches.delete(key);
  }
  return launch;
}

/** New shells open where the user already is: explicit cwd, else the active session's cwd. */
export function resolveTerminalOpenLocation(input: {
  readonly terminalCwd: string | null;
  readonly activeSessionCwd: string | null;
  readonly fallbackCwd: string;
}): { readonly cwd: string } {
  return {
    cwd: input.terminalCwd ?? input.activeSessionCwd ?? input.fallbackCwd,
  };
}
