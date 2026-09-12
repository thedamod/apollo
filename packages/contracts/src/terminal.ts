import { z } from "zod";

/**
 * Terminal contracts — ported from t3code `packages/contracts/src/terminal.ts`
 * (Effect/Schema) to this repo's zod wire format.
 *
 * Reasonable divergences from t3code (documented, not drift):
 * - Scoping: `sessionId` instead of t3code's `threadId` (this app has a single
 *   connection per server, no environments/threads/projects). All routing keys
 *   are `sessionId\0terminalId`. Error `threadId` fields are likewise `sessionId`.
 * - Validation library: zod instead of Effect/Schema. Semantics are matched
 *   (trim, `terminalId` max 128, env key pattern `^[A-Za-z_][A-Za-z0-9_]*$`,
 *   value max 8192, max 128 entries, data max 65536).
 * - `TerminalSessionSnapshot` carries `cols`/`rows` (required here, absent in
 *   t3code) because the mobile grid needs the server-agreed size. `worktreePath`
 *   is accepted on inputs/snapshots/summaries for wire-compat with t3code but
 *   the server stores it and never sets it (always `null` here — no worktrees).
 * - `TerminalRestartInput.cwd` is optional here (t3code requires it) so a dead
 *   shell is always restartable from the stored session cwd.
 * - Everything else (event unions, error tags, limits, `term-N` allocation,
 *   required `terminalPid`/`cause`/`cols`/`rows` on write/resize errors) matches
 *   t3code 1:1.
 *
 * Ids are client-chosen (`term-1`, `term-2`...). The server never allocates.
 */

export const DEFAULT_TERMINAL_ID = "term-1";

const SessionIdSchema = z.string().trim().min(1);
const TerminalIdSchema = z.string().trim().min(1).max(128);
const CwdSchema = z.string().trim().min(1);
/** t3code-compat: worktree path is accepted but never populated by this server. */
const WorktreePathSchema = z.string().trim().min(1).nullable().default(null);
const ColsSchema = z.number().int().min(1).max(1000);
const RowsSchema = z.number().int().min(1).max(500);

const TerminalEnvKeySchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(128);
const TerminalEnvValueSchema = z.string().max(8_192);
const TerminalEnvSchema = z
  .record(TerminalEnvKeySchema, TerminalEnvValueSchema)
  .refine((v) => Object.keys(v).length <= 128, {
    message: "Too many env entries (max 128)",
  });

export const TerminalStatus = z.enum([
  "starting",
  "running",
  "exited",
  "error",
]);
export type TerminalStatus = z.infer<typeof TerminalStatus>;

export const TerminalSessionSnapshot = z.object({
  sessionId: SessionIdSchema,
  terminalId: TerminalIdSchema,
  cwd: z.string().min(1),
  worktreePath: WorktreePathSchema,
  status: TerminalStatus,
  pid: z.number().int().positive().nullable(),
  history: z.string(),
  exitCode: z.number().int().nullable(),
  exitSignal: z.number().int().nullable(),
  label: z.string().max(128),
  updatedAt: z.string(),
  cols: ColsSchema,
  rows: RowsSchema,
  sequence: z.number().int().min(0).optional(),
});
export type TerminalSessionSnapshot = z.infer<typeof TerminalSessionSnapshot>;

export const TerminalSummary = z.object({
  sessionId: SessionIdSchema,
  terminalId: TerminalIdSchema,
  cwd: z.string().min(1),
  worktreePath: WorktreePathSchema,
  status: TerminalStatus,
  pid: z.number().int().positive().nullable(),
  exitCode: z.number().int().nullable(),
  exitSignal: z.number().int().nullable(),
  hasRunningSubprocess: z.boolean(),
  label: z.string().max(128),
  updatedAt: z.string(),
});
export type TerminalSummary = z.infer<typeof TerminalSummary>;

/** Terminal ids are ALWAYS chosen by the client and sent explicitly — no server-side allocation. */
export const TerminalOpenInput = z.object({
  sessionId: SessionIdSchema,
  terminalId: TerminalIdSchema,
  cwd: CwdSchema,
  worktreePath: z.string().trim().min(1).nullable().optional(),
  cols: ColsSchema.optional(),
  rows: RowsSchema.optional(),
  env: TerminalEnvSchema.optional(),
});
export type TerminalOpenInput = z.infer<typeof TerminalOpenInput>;

export const TerminalAttachInput = z.object({
  sessionId: SessionIdSchema,
  terminalId: TerminalIdSchema,
  cwd: CwdSchema.optional(),
  worktreePath: z.string().trim().min(1).nullable().optional(),
  cols: ColsSchema.optional(),
  rows: RowsSchema.optional(),
  env: TerminalEnvSchema.optional(),
  restartIfNotRunning: z.boolean().optional(),
});
export type TerminalAttachInput = z.infer<typeof TerminalAttachInput>;

export const TerminalWriteInput = z.object({
  sessionId: SessionIdSchema,
  terminalId: TerminalIdSchema,
  data: z.string().min(1).max(65_536),
});
export type TerminalWriteInput = z.infer<typeof TerminalWriteInput>;

export const TerminalResizeInput = z.object({
  sessionId: SessionIdSchema,
  terminalId: TerminalIdSchema,
  cols: ColsSchema,
  rows: RowsSchema,
});
export type TerminalResizeInput = z.infer<typeof TerminalResizeInput>;

export const TerminalClearInput = z.object({
  sessionId: SessionIdSchema,
  terminalId: TerminalIdSchema,
});
export type TerminalClearInput = z.infer<typeof TerminalClearInput>;

export const TerminalRestartInput = z.object({
  sessionId: SessionIdSchema,
  terminalId: TerminalIdSchema,
  // Optional: when omitted the server reuses the session's stored cwd (so a
  // dead shell is always restartable from the client, even when no summary
  // with a cwd is available). t3code requires cwd; this accepts a superset.
  cwd: CwdSchema.optional(),
  worktreePath: z.string().trim().min(1).nullable().optional(),
  cols: ColsSchema,
  rows: RowsSchema,
  env: TerminalEnvSchema.optional(),
});
export type TerminalRestartInput = z.infer<typeof TerminalRestartInput>;

export const TerminalCloseInput = z.object({
  sessionId: SessionIdSchema,
  terminalId: TerminalIdSchema.optional(),
  deleteHistory: z.boolean().optional(),
});
export type TerminalCloseInput = z.infer<typeof TerminalCloseInput>;

// --- events (server -> client) ---

export const TerminalEventBase = z.object({
  sessionId: SessionIdSchema,
  terminalId: TerminalIdSchema,
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
export const TerminalClosedEvent = TerminalEventBase.extend({
  type: z.literal("closed"),
});
export const TerminalErrorEvent = TerminalEventBase.extend({
  type: z.literal("error"),
  message: z.string().min(1),
});
export const TerminalClearedEvent = TerminalEventBase.extend({
  type: z.literal("cleared"),
});
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

// Attach stream: `started` is converted to `snapshot` by the server (t3code
// `terminalEventToAttachEvent` parity) — the union intentionally excludes it.
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
export type TerminalAttachStreamEvent = z.infer<
  typeof TerminalAttachStreamEvent
>;

// Metadata stream: lightweight list/subscribe channel (t3code parity).
export const TerminalMetadataSnapshotEvent = z.object({
  type: z.literal("snapshot"),
  terminals: z.array(TerminalSummary),
});
export const TerminalMetadataUpsertEvent = z.object({
  type: z.literal("upsert"),
  terminal: TerminalSummary,
});
export const TerminalMetadataRemoveEvent = z.object({
  type: z.literal("remove"),
  sessionId: SessionIdSchema,
  terminalId: TerminalIdSchema,
});
export const TerminalMetadataStreamEvent = z.union([
  TerminalMetadataSnapshotEvent,
  TerminalMetadataUpsertEvent,
  TerminalMetadataRemoveEvent,
]);
export type TerminalMetadataStreamEvent = z.infer<
  typeof TerminalMetadataStreamEvent
>;

// --- error payloads (server -> client `code` mapping in rpc handlers) ---

export const TerminalCwdNotFoundError = z.object({
  tag: z.literal("TerminalCwdNotFoundError"),
  cwd: z.string(),
});
export const TerminalCwdNotDirectoryError = z.object({
  tag: z.literal("TerminalCwdNotDirectoryError"),
  cwd: z.string(),
});
export const TerminalCwdStatError = z.object({
  tag: z.literal("TerminalCwdStatError"),
  cwd: z.string(),
  cause: z.unknown(),
});
export const TerminalHistoryError = z.object({
  tag: z.literal("TerminalHistoryError"),
  operation: z.enum(["read", "truncate", "migrate"]),
  sessionId: z.string(),
  terminalId: z.string(),
});
export const TerminalSessionLookupError = z.object({
  tag: z.literal("TerminalSessionLookupError"),
  sessionId: z.string(),
  terminalId: z.string(),
});
export const TerminalNotRunningError = z.object({
  tag: z.literal("TerminalNotRunningError"),
  sessionId: z.string(),
  terminalId: z.string(),
});
export const TerminalWriteError = z.object({
  tag: z.literal("TerminalWriteError"),
  sessionId: z.string(),
  terminalId: z.string(),
  terminalPid: z.number(),
  cause: z.unknown(),
});
export const TerminalResizeError = z.object({
  tag: z.literal("TerminalResizeError"),
  sessionId: z.string(),
  terminalId: z.string(),
  terminalPid: z.number(),
  cols: ColsSchema,
  rows: RowsSchema,
  cause: z.unknown(),
});
export const TerminalError = z.union([
  TerminalCwdNotFoundError,
  TerminalCwdNotDirectoryError,
  TerminalCwdStatError,
  TerminalHistoryError,
  TerminalSessionLookupError,
  TerminalNotRunningError,
  TerminalWriteError,
  TerminalResizeError,
]);
export type TerminalError = z.infer<typeof TerminalError>;
