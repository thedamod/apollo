import { z } from "zod";

/**
 * Service contracts — for long-running daemons like Jellyfin, Plex, etc.
 * Extends the short-lived Script model with supervision semantics.
 */

export const ServiceType = z.enum(["shell", "systemd", "docker"]);
export type ServiceType = z.infer<typeof ServiceType>;

export const ServiceStatus = z.enum([
  "running",
  "stopped",
  "starting",
  "stopping",
  "error",
  "unknown",
]);
export type ServiceStatus = z.infer<typeof ServiceStatus>;

export const HealthCheckConfig = z.object({
  type: z.enum(["process", "port", "http"]).default("process"),
  target: z.string().max(512).optional(), // port number as string, or http url, or pid
  intervalMs: z.number().int().min(1000).max(60_000).optional().default(5000),
  timeoutMs: z.number().int().min(500).max(10_000).optional().default(2000),
});
export type HealthCheckConfig = z.infer<typeof HealthCheckConfig>;

export const ServiceDefinition = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1).max(128),
  description: z.string().max(2048).optional().default(""),
  // For type=shell: shell command. For systemd: ignored, uses systemdUnit. For docker: image or compose.
  command: z.string().min(1).max(4096),
  type: ServiceType.optional().default("shell"),
  // systemd: unit name like "jellyfin.service"
  systemdUnit: z.string().max(128).optional(),
  // docker: container name or image
  dockerContainer: z.string().max(128).optional(),
  dockerImage: z.string().max(256).optional(),
  cwd: z.string().max(512).optional(),
  env: z.record(z.string(), z.string()).optional(),
  // health check — for jellyfin default is http://localhost:8096/health or port 8096
  healthCheck: HealthCheckConfig.optional(),
  port: z.number().int().min(1).max(65535).optional(), // convenience: implies port health check
  autoRestart: z.boolean().optional().default(true),
  restartDelayMs: z.number().int().min(500).max(60_000).optional().default(3000),
  maxRestarts: z.number().int().min(0).max(100).optional().default(5),
  // start on boot
  enabled: z.boolean().optional().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ServiceDefinition = z.infer<typeof ServiceDefinition>;

export const ServiceInstance = ServiceDefinition.extend({
  status: ServiceStatus,
  pid: z.number().int().positive().nullable(),
  uptimeSeconds: z.number().nullable(),
  restartCount: z.number().int().nonnegative(),
  lastExitCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  startedAt: z.string().nullable(),
  // last health check result
  health: z
    .object({
      ok: z.boolean(),
      checkedAt: z.string(),
      message: z.string().optional(),
    })
    .nullable(),
  logsPath: z.string().nullable(),
});
export type ServiceInstance = z.infer<typeof ServiceInstance>;

export const ServiceEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), service: ServiceInstance }),
  z.object({ type: z.literal("output"), serviceId: z.string(), data: z.string() }),
  z.object({ type: z.literal("error"), serviceId: z.string(), message: z.string() }),
  z.object({ type: z.literal("health"), serviceId: z.string(), health: ServiceInstance.shape.health }),
]);
export type ServiceEvent = z.infer<typeof ServiceEvent>;

// --- RPC inputs ---

export const ServiceListInput = z.object({}).optional();
export type ServiceListInput = z.infer<typeof ServiceListInput>;

export const ServiceGetInput = z.object({ id: z.string().min(1) });
export type ServiceGetInput = z.infer<typeof ServiceGetInput>;

export const ServiceCreateInput = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/).optional(),
  name: z.string().min(1).max(128),
  description: z.string().max(2048).optional(),
  command: z.string().min(1).max(4096),
  type: ServiceType.optional(),
  systemdUnit: z.string().max(128).optional(),
  dockerContainer: z.string().max(128).optional(),
  dockerImage: z.string().max(256).optional(),
  cwd: z.string().max(512).optional(),
  env: z.record(z.string(), z.string()).optional(),
  healthCheck: HealthCheckConfig.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  autoRestart: z.boolean().optional(),
  restartDelayMs: z.number().int().min(500).max(60_000).optional(),
  maxRestarts: z.number().int().min(0).max(100).optional(),
  enabled: z.boolean().optional(),
});
export type ServiceCreateInput = z.infer<typeof ServiceCreateInput>;

export const ServiceUpdateInput = ServiceCreateInput.extend({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
});
export type ServiceUpdateInput = z.infer<typeof ServiceUpdateInput>;

export const ServiceDeleteInput = z.object({ id: z.string().min(1) });
export type ServiceDeleteInput = z.infer<typeof ServiceDeleteInput>;

export const ServiceStartInput = z.object({ id: z.string().min(1) });
export type ServiceStartInput = z.infer<typeof ServiceStartInput>;

export const ServiceStopInput = z.object({ id: z.string().min(1), killSignal: z.string().optional() });
export type ServiceStopInput = z.infer<typeof ServiceStopInput>;

export const ServiceRestartInput = z.object({ id: z.string().min(1) });
export type ServiceRestartInput = z.infer<typeof ServiceRestartInput>;

export const ServiceLogsInput = z.object({
  id: z.string().min(1),
  tailLines: z.number().int().min(1).max(5000).optional().default(200),
});
export type ServiceLogsInput = z.infer<typeof ServiceLogsInput>;

export const ServiceStatusInput = z.object({ id: z.string().min(1) });
export type ServiceStatusInput = z.infer<typeof ServiceStatusInput>;
