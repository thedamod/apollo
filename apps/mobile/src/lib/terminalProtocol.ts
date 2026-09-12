/**
 * Terminal wire-protocol shapes for the mobile app.
 *
 * RN-safe port of the structural types in
 * `packages/contracts/src/terminal.ts` (`TerminalStatus`,
 * `TerminalSessionSnapshot`, `TerminalSummary`, `TerminalAttachStreamEvent`,
 * `DEFAULT_TERMINAL_ID`). The contracts package can't be imported here:
 * its barrel uses `.ts`-suffixed imports (NodeNext style) which the mobile
 * tsconfig rejects, and Metro must not bundle zod. Keep the two in sync.
 *
 * Label helpers (`getTerminalLabel`, `resolveTerminalSessionLabel`,
 * `nextTerminalId`) live in `@home-server/shared/terminalLabels` and ARE
 * imported directly — that file has zero dependencies.
 */
export const DEFAULT_TERMINAL_ID = "term-1";

export type TerminalStatus = "starting" | "running" | "exited" | "error";
export type TerminalRuntimeStatus = TerminalStatus | "closed";

export interface TerminalSessionSnapshot {
  readonly sessionId: string;
  readonly terminalId: string;
  readonly cwd: string;
  /** t3code-compat: always null here (no worktrees), accepted for wire-compat. */
  readonly worktreePath?: string | null;
  readonly status: TerminalStatus;
  readonly pid: number | null;
  readonly history: string;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly label: string;
  readonly updatedAt: string;
  readonly cols: number;
  readonly rows: number;
  readonly sequence?: number;
}

export interface TerminalSummary {
  readonly sessionId: string;
  readonly terminalId: string;
  readonly cwd: string;
  /** t3code-compat: always null here (no worktrees), accepted for wire-compat. */
  readonly worktreePath?: string | null;
  readonly status: TerminalStatus;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly hasRunningSubprocess: boolean;
  readonly label: string;
  readonly updatedAt: string;
}

interface TerminalEventBase {
  readonly sessionId: string;
  readonly terminalId: string;
  readonly sequence?: number;
}

export type TerminalAttachStreamEvent =
  | { readonly type: "snapshot"; readonly snapshot: TerminalSessionSnapshot }
  | ({ readonly type: "output" } & TerminalEventBase & {
        readonly data: string;
      })
  | ({ readonly type: "exited" } & TerminalEventBase & {
        readonly exitCode: number | null;
        readonly exitSignal: number | null;
      })
  | ({ readonly type: "closed" } & TerminalEventBase)
  | ({ readonly type: "error" } & TerminalEventBase & {
        readonly message: string;
      })
  | ({ readonly type: "cleared" } & TerminalEventBase)
  | ({ readonly type: "restarted" } & TerminalEventBase & {
        readonly snapshot: TerminalSessionSnapshot;
      })
  | ({ readonly type: "activity" } & TerminalEventBase & {
        readonly hasRunningSubprocess: boolean;
        readonly label: string;
      });

export type TerminalMetadataStreamEvent =
  | { readonly type: "snapshot"; readonly terminals: TerminalSummary[] }
  | { readonly type: "upsert"; readonly terminal: TerminalSummary }
  | {
      readonly type: "remove";
      readonly sessionId: string;
      readonly terminalId: string;
    };
