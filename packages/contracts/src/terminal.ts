import { z } from "zod";

/**
 * Terminal contracts — intentionally copied 1:1 from t3code terminal.ts
 * so the PTY layer can be swapped in without client changes.
 *
 * Ids are client-chosen (`term-1`, `term-2`...). The server never allocates.
 */

export const DEFAULT_TERMINAL_ID = "term-1";

export const TerminalStatus = z.enum(["starting", "running", "exited", "error"]);
export type TerminalStatus = z.infer<typeof TerminalStatus>;

export const TerminalSessionSnapshot = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  cwd: z.string().min(1),
  status: TerminalStatus,
  pid: z.number().int().positive().nullable(),
  history: z.string(),
  exitCode: z.number().int().nullable(),
  exitSignal: z.number().int().nullable(),
  label: z.string().max(128),
  updatedAt: z.string(),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(500),
  sequence: z.number().int().min(0).optional(),
});
export type TerminalSessionSnapshot = z.infer<typeof TerminalSessionSnapshot>;

export const TerminalSummary = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  cwd: z.string().min(1),
  status: TerminalStatus,
  pid: z.number().int().positive().nullable(),
  exitCode: z.number().int().nullable(),
  exitSignal: z.number().int().nullable(),
  hasRunningSubprocess: z.boolean(),
  label: z.string().max(128),
  updatedAt: z.string(),
});
export type TerminalSummary = z.infer<typeof TerminalSummary>;

export const TerminalOpenInput = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1).default(DEFAULT_TERMINAL_ID),
  cwd: z.string().min(1),
  cols: z.number().int().min(1).max(1000).optional().default(120),
  rows: z.number().int().min(1).max(500).optional().default(30),
  env: z.record(z.string(), z.string()).optional(),
});
export type TerminalOpenInput = z.infer<typeof TerminalOpenInput>;

export const TerminalAttachInput = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1).default(DEFAULT_TERMINAL_ID),
  cols: z.number().int().min(1).max(1000).optional(),
  rows: z.number().int().min(1).max(500).optional(),
  restartIfNotRunning: z.boolean().optional(),
});
export type TerminalAttachInput = z.infer<typeof TerminalAttachInput>;

export const TerminalWriteInput = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  data: z.string().min(1).max(65_536),
});
export type TerminalWriteInput = z.infer<typeof TerminalWriteInput>;

export const TerminalResizeInput = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(500),
});
export type TerminalResizeInput = z.infer<typeof TerminalResizeInput>;

export const TerminalClearInput = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
});
export type TerminalClearInput = z.infer<typeof TerminalClearInput>;

export const TerminalRestartInput = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  cwd: z.string().min(1),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(500),
  env: z.record(z.string(), z.string()).optional(),
});
export type TerminalRestartInput = z.infer<typeof TerminalRestartInput>;

export const TerminalCloseInput = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().optional(),
  deleteHistory: z.boolean().optional(),
});
export type TerminalCloseInput = z.infer<typeof TerminalCloseInput>;

// --- events (server -> client) ---

export const TerminalEventBase = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  sequence: z.number().int().min(0).optional(),
});

export const TerminalStartedEvent = TerminalEventBase.extend({
  type: z.literal("started"),
  snapshot: TerminalSessionSnapshot,
});
export const TerminalOutputEvent = TerminalEventBase.extend({
  type: z.literal("output"),
  data: z.string(),
});
export const TerminalExitedEvent = TerminalEventBase.extend({
  type: z.literal("exited"),
  exitCode: z.number().int().nullable(),
  exitSignal: z.number().int().nullable(),
});
export const TerminalClosedEvent = TerminalEventBase.extend({ type: z.literal("closed") });
export const TerminalErrorEvent = TerminalEventBase.extend({
  type: z.literal("error"),
  message: z.string().min(1),
});
export const TerminalClearedEvent = TerminalEventBase.extend({ type: z.literal("cleared") });
export const TerminalRestartedEvent = TerminalEventBase.extend({
  type: z.literal("restarted"),
  snapshot: TerminalSessionSnapshot,
});
export const TerminalActivityEvent = TerminalEventBase.extend({
  type: z.literal("activity"),
  hasRunningSubprocess: z.boolean(),
  label: z.string().max(128),
});

export const TerminalEvent = z.discriminatedUnion("type", [
  TerminalStartedEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalClosedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalEvent = z.infer<typeof TerminalEvent>;

export const TerminalAttachStreamEvent = z.union([
  z.object({ type: z.literal("snapshot"), snapshot: TerminalSessionSnapshot }),
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalClosedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalAttachStreamEvent = z.infer<typeof TerminalAttachStreamEvent>;
