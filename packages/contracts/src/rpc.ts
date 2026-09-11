/**
 * RPC registry — single source of truth for method names, payloads and streaming.
 * Wire format: JSON over WebSocket:
 *  client -> { id, method, params }
 *  server -> { id, result } | { id, error: { code, message } }
 *  server -> { type:"event", channel, payload }  // subscriptions
 */
import { z } from "zod";

import { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem.ts";
import {
  FilesystemPathInput,
  FilesystemStatResult,
  FilesystemReadInput,
  FilesystemReadResult,
  FilesystemMkdirInput,
  FilesystemMkdirResult,
  FilesystemRenameInput,
  FilesystemRenameResult,
  FilesystemDeleteInput,
  FilesystemDeleteResult,
} from "./filesystem.ts";
import {
  TerminalOpenInput,
  TerminalAttachInput,
  TerminalWriteInput,
  TerminalResizeInput,
  TerminalClearInput,
  TerminalRestartInput,
  TerminalCloseInput,
  TerminalSessionSnapshot,
} from "./terminal.ts";
import { SystemStatsInput, SystemStats } from "./system.ts";
import {
  ScriptListInput,
  ScriptGetInput,
  ScriptDefinition,
  ScriptUpsertInput,
  ScriptDeleteInput,
  ScriptRunInput,
  ScriptStopInput,
  ScriptLogsInput,
  ScriptRunsInput,
  ScriptGetRunInput,
  ScriptRun,
} from "./scripts.ts";
import {
  ServiceListInput,
  ServiceGetInput,
  ServiceDefinition,
  ServiceCreateInput,
  ServiceUpdateInput,
  ServiceDeleteInput,
  ServiceStartInput,
  ServiceStopInput,
  ServiceRestartInput,
  ServiceLogsInput,
  ServiceStatusInput,
  ServiceDiscoverInput,
  ServiceSetEnabledInput,
  ServiceInstance,
  SystemdUnitSummary,
} from "./services.ts";
import { TunnelConfigureInput, TunnelInfo } from "./tunnel.ts";

export const RpcMethod = {
  // filesystem
  filesystemBrowse: "filesystem.browse",
  filesystemStat: "filesystem.stat",
  filesystemReadFile: "filesystem.readFile",
  filesystemMkdir: "filesystem.mkdir",
  filesystemRename: "filesystem.rename",
  filesystemDelete: "filesystem.delete",

  // terminal — request/response
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",
  terminalList: "terminal.list",

  // terminal — streaming attach (server streams events after ack)
  terminalAttach: "terminal.attach",

  // system
  systemStats: "system.stats",
  systemStatsSubscribe: "system.statsSubscribe",

  // scripts (short-lived)
  scriptsList: "scripts.list",
  scriptsGet: "scripts.get",
  scriptsUpsert: "scripts.upsert",
  scriptsDelete: "scripts.delete",
  scriptsRun: "scripts.run",
  scriptsStop: "scripts.stop",
  scriptsLogs: "scripts.logs",
  scriptsRuns: "scripts.runs",
  scriptsGetRun: "scripts.getRun",

  // services (long-running, e.g. jellyfin) — supervised
  servicesList: "services.list",
  servicesGet: "services.get",
  servicesCreate: "services.create",
  servicesUpdate: "services.update",
  servicesDelete: "services.delete",
  servicesStart: "services.start",
  servicesStop: "services.stop",
  servicesRestart: "services.restart",
  servicesLogs: "services.logs",
  servicesStatus: "services.status",
  servicesSubscribe: "services.subscribe",
  servicesDiscover: "services.discover",
  servicesSetEnabled: "services.setEnabled",

  // tunnel
  tunnelGet: "tunnel.get",
  tunnelConfigure: "tunnel.configure",

  // meta
  serverProbe: "server.probe",
  serverGetInfo: "server.getInfo",
} as const;

export type RpcMethod = (typeof RpcMethod)[keyof typeof RpcMethod];

/** Envelope schemas */
export const RpcRequest = z.object({
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export const RpcSuccessResponse = z.object({
  id: z.string().min(1),
  result: z.unknown(),
});
export type RpcSuccessResponse = z.infer<typeof RpcSuccessResponse>;

export const RpcErrorResponse = z.object({
  id: z.string().min(1),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type RpcErrorResponse = z.infer<typeof RpcErrorResponse>;

export const RpcEventMessage = z.object({
  type: z.literal("event"),
  channel: z.string().min(1),
  payload: z.unknown(),
});
export type RpcEventMessage = z.infer<typeof RpcEventMessage>;

// for building a typed registry (server side)
export interface RpcDefinition<I, O> {
  input: z.ZodType<I>;
  output: z.ZodType<O>;
}

// Reference map for validation / docs
export const RpcSchemas = {
  [RpcMethod.filesystemBrowse]: { input: FilesystemBrowseInput, output: FilesystemBrowseResult },
  [RpcMethod.filesystemStat]: { input: FilesystemPathInput, output: FilesystemStatResult },
  [RpcMethod.filesystemReadFile]: { input: FilesystemReadInput, output: FilesystemReadResult },
  [RpcMethod.filesystemMkdir]: { input: FilesystemMkdirInput, output: FilesystemMkdirResult },
  [RpcMethod.filesystemRename]: { input: FilesystemRenameInput, output: FilesystemRenameResult },
  [RpcMethod.filesystemDelete]: { input: FilesystemDeleteInput, output: FilesystemDeleteResult },
  [RpcMethod.terminalOpen]: { input: TerminalOpenInput, output: TerminalSessionSnapshot },
  [RpcMethod.terminalWrite]: { input: TerminalWriteInput, output: z.void() },
  [RpcMethod.terminalResize]: { input: TerminalResizeInput, output: z.void() },
  [RpcMethod.terminalClear]: { input: TerminalClearInput, output: z.void() },
  [RpcMethod.terminalRestart]: { input: TerminalRestartInput, output: TerminalSessionSnapshot },
  [RpcMethod.terminalClose]: { input: TerminalCloseInput, output: z.void() },
  [RpcMethod.terminalList]: { input: z.object({ sessionId: z.string().optional() }), output: z.array(z.any()) },
  [RpcMethod.systemStats]: { input: SystemStatsInput, output: SystemStats },
  [RpcMethod.scriptsList]: { input: ScriptListInput ?? z.object({}), output: z.array(ScriptDefinition) },
  [RpcMethod.scriptsGet]: { input: ScriptGetInput, output: ScriptDefinition },
  [RpcMethod.scriptsUpsert]: { input: ScriptUpsertInput, output: ScriptDefinition },
  [RpcMethod.scriptsDelete]: { input: ScriptDeleteInput, output: z.void() },
  [RpcMethod.scriptsRun]: { input: ScriptRunInput, output: ScriptRun },
  [RpcMethod.scriptsStop]: { input: ScriptStopInput, output: z.void() },
  [RpcMethod.scriptsLogs]: { input: ScriptLogsInput, output: z.object({ runId: z.string(), content: z.string() }) },
  [RpcMethod.scriptsRuns]: { input: ScriptRunsInput ?? z.object({}), output: z.array(ScriptRun) },
  [RpcMethod.scriptsGetRun]: { input: ScriptGetRunInput, output: ScriptRun },
  [RpcMethod.servicesList]: { input: ServiceListInput ?? z.object({}), output: z.array(ServiceInstance) },
  [RpcMethod.servicesGet]: { input: ServiceGetInput, output: ServiceInstance },
  [RpcMethod.servicesCreate]: { input: ServiceCreateInput, output: ServiceDefinition },
  [RpcMethod.servicesUpdate]: { input: ServiceUpdateInput, output: ServiceDefinition },
  [RpcMethod.servicesDelete]: { input: ServiceDeleteInput, output: z.void() },
  [RpcMethod.servicesStart]: { input: ServiceStartInput, output: ServiceInstance },
  [RpcMethod.servicesStop]: { input: ServiceStopInput, output: ServiceInstance },
  [RpcMethod.servicesRestart]: { input: ServiceRestartInput, output: ServiceInstance },
  [RpcMethod.servicesLogs]: { input: ServiceLogsInput, output: z.object({ id: z.string(), content: z.string() }) },
  [RpcMethod.servicesStatus]: { input: ServiceStatusInput, output: ServiceInstance },
  [RpcMethod.servicesDiscover]: { input: ServiceDiscoverInput ?? z.object({}), output: z.array(SystemdUnitSummary) },
  [RpcMethod.servicesSetEnabled]: { input: ServiceSetEnabledInput, output: ServiceInstance },
  [RpcMethod.tunnelGet]: { input: z.object({}), output: TunnelInfo },
  [RpcMethod.tunnelConfigure]: { input: TunnelConfigureInput, output: TunnelInfo },
  [RpcMethod.serverProbe]: { input: z.object({}), output: z.object({ ok: z.boolean() }) },
  [RpcMethod.serverGetInfo]: {
    input: z.object({}),
    output: z.object({
      name: z.string(),
      version: z.string(),
      uptimeSeconds: z.number(),
      port: z.number(),
    }),
  },
} as const satisfies Record<string, RpcDefinition<any, any>>;
