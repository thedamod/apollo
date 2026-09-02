import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import type { ScriptDefinition, ScriptRun, ScriptEvent } from "@home-server/contracts";

/**
 * ScriptService — durable script definitions + execution.
 * Definitions persisted to `scripts.json`; runs are ephemeral with
 * logs under `<dataDir>/logs/scripts/<runId>.log`.
 *
 * Extensible via ScriptDriver interface for docker/systemd.
 */
export interface ScriptDriver {
  run(def: ScriptDefinition, runId: string, logsPath: string): Promise<ChildProcess>;
}

class ShellDriver implements ScriptDriver {
  async run(def: ScriptDefinition, _runId: string, _logsPath: string): Promise<ChildProcess> {
    const cwd = def.cwd ?? process.cwd();
    const env = { ...process.env, ...(def.env ?? {}) };
    // Use shell execution so `command` can be any shell line
    const child = spawn(def.command, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return child;
  }
}

export class ScriptService {
  private defs = new Map<string, ScriptDefinition>();
  private runs = new Map<string, ScriptRun>();
  private children = new Map<string, ChildProcess>();
  private listeners = new Set<(ev: ScriptEvent) => void>();

  constructor(
    private readonly scriptsPath: string,
    private readonly logsBase: string,
    private readonly driver: ScriptDriver = new ShellDriver(),
  ) {
    this.logsBase = path.join(logsBase, "scripts");
  }

  async init(): Promise<void> {
    await fsp.mkdir(path.dirname(this.scriptsPath), { recursive: true });
    await fsp.mkdir(this.logsBase, { recursive: true });
    try {
      const raw = await fsp.readFile(this.scriptsPath, "utf8");
      const arr = JSON.parse(raw) as ScriptDefinition[];
      for (const d of arr) this.defs.set(d.id, d);
    } catch (e: any) {
      if (e?.code !== "ENOENT") console.warn("[scripts] failed to load", e.message);
    }
  }

  private async persist(): Promise<void> {
    const arr = [...this.defs.values()];
    await fsp.writeFile(this.scriptsPath, JSON.stringify(arr, null, 2) + "\n", "utf8");
  }

  onEvent(listener: (ev: ScriptEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(ev: ScriptEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {}
    }
  }

  list(): ScriptDefinition[] {
    return [...this.defs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): ScriptDefinition | undefined {
    return this.defs.get(id);
  }

  async upsert(input: {
    id?: string;
    name: string;
    description?: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    isService?: boolean;
    cron?: string;
  }): Promise<ScriptDefinition> {
    const id = input.id ?? `scr_${crypto.randomBytes(4).toString("hex")}`;
    if (!/^[a-z0-9_-]+$/.test(id)) throw new Error(`Invalid script id: ${id}`);
    const now = new Date().toISOString();
    const existing = this.defs.get(id);
    const def: ScriptDefinition = {
      id,
      name: input.name,
      description: input.description ?? "",
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
      isService: input.isService ?? false,
      cron: input.cron,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.defs.set(id, def);
    await this.persist();
    return def;
  }

  async delete(id: string): Promise<void> {
    if (!this.defs.has(id)) throw Object.assign(new Error(`Unknown script: ${id}`), { code: "not_found" });
    this.defs.delete(id);
    await this.persist();
  }

  async runScript(id: string): Promise<ScriptRun> {
    const def = this.defs.get(id);
    if (!def) throw Object.assign(new Error(`Unknown script: ${id}`), { code: "not_found" });
    const runId = `run_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const logsPath = path.join(this.logsBase, `${runId}.log`);
    const run: ScriptRun = {
      runId,
      scriptId: id,
      status: "running",
      pid: null,
      exitCode: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      logsPath,
    };
    this.runs.set(runId, run);
    await fsp.writeFile(logsPath, `# ${def.name} — ${def.command}\n# run ${runId} at ${run.startedAt}\n`, "utf8");

    const child = await this.driver.run(def, runId, logsPath);
    run.pid = child.pid ?? null;
    this.children.set(runId, child);
    this.emit({ type: "started", run: { ...run } });

    const logStream = fs.createWriteStream(logsPath, { flags: "a" });
    child.stdout?.on("data", (d: Buffer) => {
      const data = d.toString("utf8");
      logStream.write(data);
      this.emit({ type: "output", runId, scriptId: id, data });
    });
    child.stderr?.on("data", (d: Buffer) => {
      const data = d.toString("utf8");
      logStream.write(data);
      this.emit({ type: "output", runId, scriptId: id, data });
    });

    let timeout: NodeJS.Timeout | undefined;
    if (def.timeoutMs) {
      timeout = setTimeout(() => {
        if (child.pid) {
          try {
            child.kill("SIGTERM");
          } catch {}
        }
      }, def.timeoutMs);
    }

    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      logStream.end();
      const finished: ScriptRun = {
        ...run,
        status: signal ? "killed" : code === 0 ? "success" : "error",
        exitCode: code,
        finishedAt: new Date().toISOString(),
      };
      this.runs.set(runId, finished);
      this.children.delete(runId);
      this.emit({ type: "finished", run: { ...finished } });
    });
    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      logStream.end();
      const finished: ScriptRun = {
        ...run,
        status: "error",
        exitCode: null,
        finishedAt: new Date().toISOString(),
      };
      this.runs.set(runId, finished);
      this.children.delete(runId);
      this.emit({ type: "error", runId, scriptId: id, message: err.message });
    });

    return { ...run };
  }

  async stop(runId: string): Promise<void> {
    const child = this.children.get(runId);
    if (!child) throw Object.assign(new Error(`No running process for ${runId}`), { code: "not_found" });
    try {
      child.kill("SIGTERM");
      // escalate to SIGKILL after grace
      setTimeout(() => {
        try {
          if (child.pid) child.kill("SIGKILL");
        } catch {}
      }, 1500).unref();
    } catch (e: any) {
      throw Object.assign(new Error(`Failed to kill ${runId}: ${e.message}`), { code: "kill_failed" });
    }
  }

  getRun(runId: string): ScriptRun | undefined {
    return this.runs.get(runId);
  }

  async readLogs(runId: string, tailLines = 200): Promise<string> {
    const run = this.runs.get(runId);
    if (!run?.logsPath) throw Object.assign(new Error(`Unknown run: ${runId}`), { code: "not_found" });
    try {
      const content = await fsp.readFile(run.logsPath, "utf8");
      const lines = content.split("\n");
      if (lines.length <= tailLines) return content;
      return lines.slice(lines.length - tailLines).join("\n");
    } catch (e: any) {
      if (e?.code === "ENOENT") return "";
      throw e;
    }
  }

  // service monitor: list runs with status
  listRuns(): ScriptRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
