import { z } from "zod";

export const ScriptStatus = z.enum(["idle", "running", "success", "error", "killed"]);
export type ScriptStatus = z.infer<typeof ScriptStatus>;

/**
 * How a script is triggered: by hand, on a schedule, or both.
 * The schedule itself is `schedule` (systemd timer underneath).
 */
export const ScriptRunMode = z.enum(["manual", "scheduled", "both"]);
export type ScriptRunMode = z.infer<typeof ScriptRunMode>;

// --- parameterized actions: schema → generated mobile UI → values → execution ---

export const ScriptParamType = z.enum(["slider", "number", "text", "toggle", "select", "color", "file"]);
export type ScriptParamType = z.infer<typeof ScriptParamType>;

export const ScriptParamOption = z.object({
  value: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
});
export type ScriptParamOption = z.infer<typeof ScriptParamOption>;

export const ScriptParam = z.object({
  /** `{{key}}` in the command + `PARAM_KEY` in the environment */
  key: z.string().min(1).max(64).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  type: ScriptParamType,
  label: z.string().min(1).max(128),
  defaultValue: z.union([z.string().max(1024), z.number(), z.boolean()]).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  unit: z.string().max(32).optional(),
  required: z.boolean().optional(),
  /** select only */
  options: z.array(ScriptParamOption).max(100).optional(),
  placeholder: z.string().max(256).optional(),
  hint: z.string().max(512).optional(),
});
export type ScriptParam = z.infer<typeof ScriptParam>;

/** Raw values as sent by clients (`scripts.run { params }`). */
export const ScriptParamValue = z.union([z.string().max(4096), z.number(), z.boolean()]);
export type ScriptParamValue = z.infer<typeof ScriptParamValue>;

export const ScriptSchedule = z.object({
  /** backed by a systemd timer underneath; UI only exposes on/off + plain schedule */
  enabled: z.boolean().optional().default(false),
  /** systemd OnCalendar value, e.g. "daily", "hourly", "*:0/15" */
  onCalendar: z.string().max(128).optional(),
  /** run once on boot if a scheduled run was missed */
  persistent: z.boolean().optional().default(false),
});
export type ScriptSchedule = z.infer<typeof ScriptSchedule>;

/** Input variant — no defaults applied, all fields optional for PATCH-style upserts. */
export const ScriptScheduleInput = z.object({
  enabled: z.boolean().optional(),
  onCalendar: z.string().max(128).optional(),
  persistent: z.boolean().optional(),
});
export type ScriptScheduleInput = z.infer<typeof ScriptScheduleInput>;

export const ScriptDefinition = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1).max(128),
  description: z.string().max(1024).optional().default(""),
  /** short icon key shown in the UI (emoji or lucide name), e.g. "💾" */
  icon: z.string().max(64).optional(),
  command: z.string().min(1).max(4096), // shell command
  cwd: z.string().max(512).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** system user to run as (via `sudo -n -u`); defaults to the server user */
  runUser: z.string().max(64).optional(),
  /** manual (Run button only), scheduled (timer only), or both */
  runMode: ScriptRunMode.optional().default("manual"),
  /** parameter schema — the app generates the Run screen from this */
  params: z.array(ScriptParam).max(50).optional(),
  timeoutMs: z.number().int().min(1000).max(86_400_000).optional(), // default no timeout
  // service mode: keep running, restart on failure, monitor
  isService: z.boolean().optional().default(false),
  cron: z.string().max(128).optional(), // deprecated: use `schedule.onCalendar`
  schedule: ScriptSchedule.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScriptDefinition = z.infer<typeof ScriptDefinition>;

export const ScriptRun = z.object({
  runId: z.string().min(1),
  scriptId: z.string().min(1),
  status: ScriptStatus,
  pid: z.number().int().positive().nullable(),
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  logsPath: z.string().nullable(), // absolute path on server
  /** serialized parameter values this run executed with */
  params: z.record(z.string(), ScriptParamValue).optional(),
});
export type ScriptRun = z.infer<typeof ScriptRun>;

export const ScriptEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("started"),
    run: ScriptRun,
  }),
  z.object({
    type: z.literal("output"),
    runId: z.string(),
    scriptId: z.string(),
    data: z.string(),
  }),
  z.object({
    type: z.literal("finished"),
    run: ScriptRun,
  }),
  z.object({
    type: z.literal("error"),
    runId: z.string(),
    scriptId: z.string(),
    message: z.string(),
  }),
]);
export type ScriptEvent = z.infer<typeof ScriptEvent>;

// --- RPC inputs ---

export const ScriptListInput = z.object({}).optional();
export type ScriptListInput = z.infer<typeof ScriptListInput>;

export const ScriptGetInput = z.object({ id: z.string().min(1) });
export type ScriptGetInput = z.infer<typeof ScriptGetInput>;

export const ScriptUpsertInput = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/).optional(),
  name: z.string().min(1).max(128),
  description: z.string().max(1024).optional(),
  icon: z.string().max(64).optional(),
  command: z.string().min(1).max(4096),
  cwd: z.string().max(512).optional(),
  env: z.record(z.string(), z.string()).optional(),
  runUser: z.string().max(64).optional(),
  runMode: ScriptRunMode.optional(),
  params: z.array(ScriptParam).max(50).optional(),
  timeoutMs: z.number().int().min(1000).max(86_400_000).optional(),
  isService: z.boolean().optional(),
  cron: z.string().max(128).optional(),
  schedule: ScriptScheduleInput.optional(),
});
export type ScriptUpsertInput = z.infer<typeof ScriptUpsertInput>;

export const ScriptDeleteInput = z.object({ id: z.string().min(1) });
export type ScriptDeleteInput = z.infer<typeof ScriptDeleteInput>;

export const ScriptRunInput = z.object({
  id: z.string().min(1),
  /** values for the script's `params` schema (defaults apply when omitted) */
  params: z.record(z.string(), ScriptParamValue).optional(),
});
export type ScriptRunInput = z.infer<typeof ScriptRunInput>;

export const ScriptStopInput = z.object({ runId: z.string().min(1) });
export type ScriptStopInput = z.infer<typeof ScriptStopInput>;

export const ScriptLogsInput = z.object({
  runId: z.string().min(1),
  tailLines: z.number().int().min(1).max(5000).optional().default(200),
});
export type ScriptLogsInput = z.infer<typeof ScriptLogsInput>;

// --- execution history (detail page: past runs + active run) ---

export const ScriptWithStatus = ScriptDefinition.extend({
  lastRun: ScriptRun.nullable().optional(),
  activeRun: ScriptRun.nullable().optional(),
});
export type ScriptWithStatus = z.infer<typeof ScriptWithStatus>;

export const ScriptRunsInput = z
  .object({
    scriptId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional().default(50),
  })
  .optional();
export type ScriptRunsInput = z.infer<typeof ScriptRunsInput>;

export const ScriptGetRunInput = z.object({ runId: z.string().min(1) });
export type ScriptGetRunInput = z.infer<typeof ScriptGetRunInput>;
