import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { SystemStats, CpuSnapshot, MemorySnapshot, DiskSnapshot } from "@home-server/contracts";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SystemStatsError extends Schema.TaggedError<SystemStatsError>()("SystemStatsError", {
  cause: Schema.optional(Schema.Defect),
}) {}

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

export class SystemServiceTag extends Context.Tag("home-server/SystemService")<
  SystemServiceTag,
  {
    readonly getStats: (
      input?: { diskPaths?: string[] },
    ) => Effect.Effect<SystemStats, SystemStatsError>;
  }
>() {}

// ---------------------------------------------------------------------------
// Helpers — pure Effect, no `any` leaking outside
// ---------------------------------------------------------------------------

let lastCpuInfo: { idle: number; total: number; at: number } | null = null;

function sampleCpu(): { idle: number; total: number } {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

function cpuUsagePercent(): number | null {
  const now = sampleCpu();
  const at = Date.now();
  if (!lastCpuInfo) {
    lastCpuInfo = { ...now, at };
    return null;
  }
  const idleDiff = now.idle - lastCpuInfo.idle;
  const totalDiff = now.total - lastCpuInfo.total;
  const elapsed = at - lastCpuInfo.at;
  lastCpuInfo = { ...now, at };
  if (totalDiff === 0 || elapsed < 200) return null;
  return Math.max(0, Math.min(100, 100 - (100 * idleDiff) / totalDiff));
}

interface StatFsResult {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
}

function diskForPathEffect(p: string): Effect.Effect<DiskSnapshot, never> {
  return Effect.gen(function* () {
    // Try Node 19+ statfs
    const statfs = (fs.promises as unknown as { statfs?: (path: string) => Promise<StatFsResult> }).statfs;
    if (typeof statfs === "function") {
      const s = yield* Effect.tryPromise({
        try: () => statfs(p),
        catch: () => null as unknown as StatFsResult | null,
      }).pipe(Effect.orElseSucceed(() => null as unknown as StatFsResult | null));
      if (s) {
        const total = s.bsize * s.blocks;
        const free = s.bsize * s.bfree;
        const used = total - free;
        return {
          path: p,
          totalBytes: total,
          freeBytes: free,
          usedBytes: used,
          usagePercent: total > 0 ? (used / total) * 100 : 0,
        };
      }
    }

    // fallback: df -k
    const dfResult = yield* Effect.tryPromise({
      try: () => execAsync(`df -k "${p.replace(/"/g, '\\"')}" | tail -1`),
      catch: () => ({ stdout: "" }) as { stdout: string },
    }).pipe(Effect.orElseSucceed(() => ({ stdout: "" }) as { stdout: string }));

    const parts = dfResult.stdout.trim().split(/\s+/);
    if (parts.length >= 6) {
      const totalKb = Number(parts[1]);
      const usedKb = Number(parts[2]);
      const availKb = Number(parts[3]);
      const total = totalKb * 1024;
      const free = availKb * 1024;
      const used = usedKb * 1024;
      if (Number.isFinite(total) && Number.isFinite(free) && Number.isFinite(used)) {
        return {
          path: p,
          totalBytes: total,
          freeBytes: free,
          usedBytes: used,
          usagePercent: total > 0 ? (used / total) * 100 : 0,
        };
      }
    }

    return { path: p, totalBytes: 0, freeBytes: 0, usedBytes: 0, usagePercent: 0 };
  });
}

function getStatsEffect(input: { diskPaths?: string[] } = {}): Effect.Effect<SystemStats, SystemStatsError> {
  return Effect.gen(function* () {
    const loadAvg = os.loadavg();
    const cores = os.cpus().length || 1;
    const usagePercent = cpuUsagePercent();

    const cpu: CpuSnapshot = {
      loadAvg1: loadAvg[0] ?? 0,
      loadAvg5: loadAvg[1] ?? 0,
      loadAvg15: loadAvg[2] ?? 0,
      cores,
      usagePercent,
    };

    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = totalBytes - freeBytes;
    const memory: MemorySnapshot = {
      totalBytes,
      freeBytes,
      usedBytes,
      availableBytes: freeBytes,
      usagePercent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0,
    };

    const diskPaths = input.diskPaths?.length
      ? input.diskPaths
      : process.platform === "win32"
        ? [path.parse(process.cwd()).root]
        : ["/"];

    const disks: DiskSnapshot[] = [];
    for (const dp of diskPaths) {
      const d = yield* diskForPathEffect(dp);
      disks.push(d);
    }

    return {
      cpu,
      memory,
      disks,
      uptimeSeconds: os.uptime(),
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      timestamp: new Date().toISOString(),
    };
  }).pipe(Effect.catchAll((cause) => Effect.fail(new SystemStatsError({ cause }))));
}

export const SystemServiceLive = Layer.succeed(
  SystemServiceTag,
  SystemServiceTag.of({ getStats: getStatsEffect }),
);

// ---------------------------------------------------------------------------
// Legacy class — keeps `new SystemService()` working
// ---------------------------------------------------------------------------

export class SystemService {
  /** Effect-native */
  getStatsEffect(input: { diskPaths?: string[] } = {}): Effect.Effect<SystemStats, SystemStatsError> {
    return getStatsEffect(input);
  }

  /** Promise wrapper for existing callers */
  async getStats(input: { diskPaths?: string[] } = {}): Promise<SystemStats> {
    return Effect.runPromise(this.getStatsEffect(input));
  }
}
