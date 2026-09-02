import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { SystemStats, CpuSnapshot, MemorySnapshot, DiskSnapshot } from "@home-server/contracts";

const execAsync = promisify(exec);

/** Sample CPU usage over interval (like t3 resource-monitor) */
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

async function diskForPath(p: string): Promise<DiskSnapshot> {
  // Try statfs if available (Node 19+), else fallback to df
  try {
    // @ts-ignore statfs may not be typed
    if (typeof fs.statfs === "function") {
      const s: any = await (fs.promises as any).statfs(p);
      // statfs returns bsize, blocks, bfree, bavail
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
  } catch {}

  // fallback: df -k
  try {
    const { stdout } = await execAsync(`df -k "${p.replace(/"/g, '\\"')}" | tail -1`);
    const parts = stdout.trim().split(/\s+/);
    // Filesystem 1K-blocks Used Available Use% Mounted on
    if (parts.length >= 6) {
      const totalKb = Number(parts[1]);
      const usedKb = Number(parts[2]);
      const availKb = Number(parts[3]);
      const total = totalKb * 1024;
      const free = availKb * 1024;
      const used = usedKb * 1024;
      return {
        path: p,
        totalBytes: Number.isFinite(total) ? total : 0,
        freeBytes: Number.isFinite(free) ? free : 0,
        usedBytes: Number.isFinite(used) ? used : 0,
        usagePercent: total > 0 ? (used / total) * 100 : 0,
      };
    }
  } catch {}

  return { path: p, totalBytes: 0, freeBytes: 0, usedBytes: 0, usagePercent: 0 };
}

export class SystemService {
  async getStats(input: { diskPaths?: string[] } = {}): Promise<SystemStats> {
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
      disks.push(await diskForPath(dp));
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
  }
}
