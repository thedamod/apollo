import { z } from "zod";

export const CpuSnapshot = z.object({
  loadAvg1: z.number(),
  loadAvg5: z.number(),
  loadAvg15: z.number(),
  cores: z.number().int().min(1),
  usagePercent: z.number().min(0).max(100).nullable(), // null if not yet sampled
});
export type CpuSnapshot = z.infer<typeof CpuSnapshot>;

export const MemorySnapshot = z.object({
  totalBytes: z.number().int().nonnegative(),
  freeBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  availableBytes: z.number().int().nonnegative(),
  usagePercent: z.number().min(0).max(100),
});
export type MemorySnapshot = z.infer<typeof MemorySnapshot>;

export const DiskSnapshot = z.object({
  path: z.string(),
  totalBytes: z.number().int().nonnegative(),
  freeBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  usagePercent: z.number().min(0).max(100),
});
export type DiskSnapshot = z.infer<typeof DiskSnapshot>;

export const SystemStats = z.object({
  cpu: CpuSnapshot,
  memory: MemorySnapshot,
  disks: z.array(DiskSnapshot),
  uptimeSeconds: z.number().nonnegative(),
  hostname: z.string(),
  platform: z.string(),
  arch: z.string(),
  timestamp: z.string(), // ISO
});
export type SystemStats = z.infer<typeof SystemStats>;

export const SystemStatsInput = z.object({
  diskPaths: z.array(z.string().max(512)).optional(), // default ["/"] or ["C:\\"]
});
export type SystemStatsInput = z.infer<typeof SystemStatsInput>;
