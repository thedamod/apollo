import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import * as crypto from "node:crypto";
import * as net from "node:net";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  ServiceDefinition,
  ServiceInstance,
  ServiceEvent,
  ServiceStatus,
} from "@home-server/contracts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Errors — typed, no `any`
// ---------------------------------------------------------------------------

export class ServiceNotFoundError extends Schema.TaggedError<ServiceNotFoundError>()(
  "ServiceNotFoundError",
  { id: Schema.String },
) {
  get message() {
    return `Unknown service: ${this.id}`;
  }
}

export class ServiceAlreadyExistsError extends Schema.TaggedError<ServiceAlreadyExistsError>()(
  "ServiceAlreadyExistsError",
  { id: Schema.String },
) {
  get message() {
    return `Service already exists: ${this.id}`;
  }
}

export class ServiceDriverError extends Schema.TaggedError<ServiceDriverError>()(
  "ServiceDriverError",
  {
    id: Schema.String,
    driver: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  get message() {
    return `Driver ${this.driver} failed for ${this.id}`;
  }
}

export class ServiceInvalidIdError extends Schema.TaggedError<ServiceInvalidIdError>()(
  "ServiceInvalidIdError",
  { id: Schema.String },
) {
  get message() {
    return `Invalid service id: ${this.id}`;
  }
}

export class ServiceSystemError extends Schema.TaggedError<ServiceSystemError>()(
  "ServiceSystemError",
  {
    id: Schema.optional(Schema.String),
    op: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  get message() {
    return `Service operation ${this.op} failed${this.id ? ` for ${this.id}` : ""}`;
  }
}

export type ServiceError =
  | ServiceNotFoundError
  | ServiceAlreadyExistsError
  | ServiceDriverError
  | ServiceInvalidIdError
  | ServiceSystemError;

/**
 * Error surfaced to RPC callers. Real subclass (not `Object.assign`) so
 * `code` survives Effect FiberFailure wrappers — same pattern as
 * `FilesystemRpcError` in `services/filesystem.ts`.
 */
export class ServiceRpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ServiceRpcError";
    this.code = code;
  }
}

function serviceFailCode(e: ServiceError): string {
  switch (e._tag) {
    case "ServiceNotFoundError":
      return "not_found";
    case "ServiceAlreadyExistsError":
      return "already_exists";
    case "ServiceInvalidIdError":
      return "invalid_id";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// User-facing systemd filtering + detail helpers
// ---------------------------------------------------------------------------

/** Injectable exec for testability (defaults to execFile). */
export type ExecFn = (
  cmd: string,
  args: ReadonlyArray<string>,
) => Promise<{ stdout: string; stderr: string }>;

/** Substrings that mark a unit as user-facing (jellyfin/docker/samba-class). */
export const USER_FACING_PATTERNS = [
  "jellyfin",
  "plex",
  "emby",
  "sonarr",
  "radarr",
  "navidrome",
  "immich",
  "nextcloud",
  "samba",
  "smb",
  "nfs",
  "docker",
  "containerd",
  "portainer",
  "home-assistant",
  "hass",
  "mosquitto",
  "zigbee",
  "adguard",
  "pihole",
  "caddy",
  "nginx",
  "traefik",
  "transmission",
  "qbittorrent",
  "syncthing",
  "photoprism",
];

/** Prefixes that are always system plumbing (hidden when userFacingOnly). */
export const SYSTEM_UNIT_PREFIXES = [
  "systemd-",
  "dbus",
  "polkit",
  "udisks",
  "upower",
  "accounts-daemon",
  "avahi",
  "bluetooth",
  "getty",
  "serial-getty",
  "modprobe",
  "init.scope",
  "slices",
  "sockets.target",
];

export function isUserFacingUnit(unit: string, description = ""): boolean {
  const hay = `${unit} ${description}`.toLowerCase();
  if (SYSTEM_UNIT_PREFIXES.some((p) => unit.toLowerCase().startsWith(p))) return false;
  if (hay.includes("slice") || hay.includes("socket") || hay.includes("timer")) {
    // timers/sockets are plumbing unless they match a media pattern
    if (!USER_FACING_PATTERNS.some((p) => hay.includes(p))) return false;
  }
  if (USER_FACING_PATTERNS.some((p) => hay.includes(p))) return true;
  // default: hide — unknown system services stay out of the way
  return false;
}

/** Derive a browsable URL from a known port (detail page link). */
export function deriveServiceUrl(port: number | undefined): string | null {
  if (!port) return null;
  return `http://127.0.0.1:${port}`;
}

/** Best-effort CPU % + RSS for a PID via /proc (null when unavailable). */
export async function procStatsForPid(pid: number | null): Promise<{ cpuPercent: number | null; memoryBytes: number | null }> {
  if (!pid || pid <= 0) return { cpuPercent: null, memoryBytes: null };
  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
    const status = await fsp.readFile(`/proc/${pid}/status`, "utf8").catch(() => null);
    let memoryBytes: number | null = null;
    if (status) {
      const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
      if (m) memoryBytes = Number(m[1]) * 1024;
    }
    // CPU % needs two samples — return null on first call (callers poll getStatus)
    void stat;
    return { cpuPercent: null, memoryBytes };
  } catch {
    return { cpuPercent: null, memoryBytes: null };
  }
}

export class ServiceManagerTag extends Context.Tag("home-server/ServiceManager")<
  ServiceManagerTag,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<ServiceInstance>>;
    readonly get: (id: string) => Effect.Effect<ServiceInstance, ServiceNotFoundError>;
    readonly getStatus: (id: string) => Effect.Effect<ServiceInstance, ServiceNotFoundError | ServiceSystemError>;
    readonly create: (
      input: Parameters<ServiceManager["create"]>[0],
    ) => Effect.Effect<ServiceDefinition, ServiceAlreadyExistsError | ServiceInvalidIdError>;
    readonly update: (
      id: string,
      patch: Partial<Omit<ServiceDefinition, "id" | "createdAt" | "updatedAt">>,
    ) => Effect.Effect<ServiceDefinition, ServiceNotFoundError>;
    readonly delete: (id: string) => Effect.Effect<void, ServiceNotFoundError>;
    readonly start: (id: string) => Effect.Effect<ServiceInstance, ServiceNotFoundError | ServiceDriverError>;
    readonly stop: (id: string, signal?: string) => Effect.Effect<ServiceInstance, ServiceNotFoundError>;
    readonly restart: (id: string) => Effect.Effect<ServiceInstance, ServiceNotFoundError | ServiceDriverError>;
    readonly readLogs: (id: string, tailLines?: number) => Effect.Effect<string, ServiceNotFoundError>;
    readonly discover: (opts?: {
      userFacingOnly?: boolean;
      query?: string;
      limit?: number;
    }) => Effect.Effect<ReadonlyArray<import("@home-server/contracts").SystemdUnitSummary>, ServiceSystemError>;
    readonly setEnabled: (id: string, enabled: boolean) => Effect.Effect<ServiceInstance, ServiceNotFoundError | ServiceSystemError>;
    readonly dockerList: (opts?: {
      query?: string;
      limit?: number;
    }) => Effect.Effect<ReadonlyArray<import("@home-server/contracts").DockerContainerSummary>, ServiceSystemError>;
  }
>() {}

// ---------- Drivers ----------

export interface ServiceDriver {
  readonly type: string;
  start(def: ServiceDefinition, logsPath: string): Promise<{ pid: number | null; proc: ChildProcess | null }>;
  stop(def: ServiceDefinition, proc: ChildProcess | null, signal?: string): Promise<void>;
  status(def: ServiceDefinition, proc: ChildProcess | null): Promise<{ running: boolean; pid: number | null }>;
  logs(def: ServiceDefinition, tailLines: number): Promise<string>;
  /** systemd only: is-enabled state, null when unknown */
  isEnabled?(def: ServiceDefinition): Promise<boolean | null>;
  /** systemd only: enable/disable at boot */
  setEnabled?(def: ServiceDefinition, enabled: boolean): Promise<void>;
  /** systemd only: raw ActiveState/SubState */
  activeState?(def: ServiceDefinition): Promise<{ active: string | null; sub: string | null }>;
}

class ShellDriver implements ServiceDriver {
  readonly type = "shell";
  async start(def: ServiceDefinition, logsPath: string): Promise<{ pid: number | null; proc: ChildProcess | null }> {
    const cwd = def.cwd ?? process.cwd();
    const env = { ...process.env, ...(def.env ?? {}) };
    const child = spawn(def.command, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    // pipe to log file
    await fsp.mkdir(path.dirname(logsPath), { recursive: true });
    // ensure header
    await fsp.appendFile(logsPath, `# ${def.name} — ${def.command}\n# started ${new Date().toISOString()} pid=${child.pid}\n`);
    const logStream = fs.createWriteStream(logsPath, { flags: "a" });
    child.stdout?.on("data", (d: Buffer) => logStream.write(d));
    child.stderr?.on("data", (d: Buffer) => logStream.write(d));
    child.on("close", () => {
      // close after a tick to flush
      setTimeout(() => logStream.end(), 100);
    });
    return { pid: child.pid ?? null, proc: child };
  }
  async stop(_def: ServiceDefinition, proc: ChildProcess | null, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!proc) return;
    try {
      proc.kill(signal);
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, 3000).unref();
    } catch {}
  }
  async status(_def: ServiceDefinition, proc: ChildProcess | null): Promise<{ running: boolean; pid: number | null }> {
    if (!proc) return { running: false, pid: null };
    // check if pid alive: proc.exitCode === null means running
    if (proc.exitCode !== null) return { running: false, pid: null };
    // also verify via kill 0
    try {
      if (proc.pid) process.kill(proc.pid, 0);
      return { running: true, pid: proc.pid ?? null };
    } catch {
      return { running: false, pid: null };
    }
  }
  async logs(def: ServiceDefinition, tailLines: number): Promise<string> {
    // logs are managed by ServiceManager, this is fallback
    return "";
  }
}

class SystemdDriver implements ServiceDriver {
  readonly type = "systemd";
  constructor(private readonly exec: ExecFn = defaultExec) {}
  private unitOf(def: ServiceDefinition): string {
    return def.systemdUnit ?? `${def.id}.service`;
  }
  async start(def: ServiceDefinition): Promise<{ pid: number | null; proc: ChildProcess | null }> {
    const unit = this.unitOf(def);
    await this.exec("systemctl", ["start", unit]);
    return { pid: null, proc: null };
  }
  async stop(def: ServiceDefinition): Promise<void> {
    const unit = this.unitOf(def);
    await this.exec("systemctl", ["stop", unit]);
  }
  async status(def: ServiceDefinition): Promise<{ running: boolean; pid: number | null }> {
    const unit = this.unitOf(def);
    try {
      await this.exec("systemctl", ["is-active", "--quiet", unit]);
      // active
      try {
        const { stdout } = await this.exec("systemctl", ["show", unit, "--property=MainPID", "--value"]);
        const pid = parseInt(stdout.trim(), 10);
        return { running: true, pid: pid > 0 ? pid : null };
      } catch {
        return { running: true, pid: null };
      }
    } catch {
      return { running: false, pid: null };
    }
  }
  async logs(def: ServiceDefinition, tailLines: number): Promise<string> {
    const unit = this.unitOf(def);
    try {
      const { stdout } = await this.exec("journalctl", ["-u", unit, "-n", String(tailLines), "--no-pager"]);
      return stdout;
    } catch (e: unknown) {
      return `journalctl failed: ${(e as Error).message}`;
    }
  }
  async isEnabled(def: ServiceDefinition): Promise<boolean | null> {
    const unit = this.unitOf(def);
    try {
      const { stdout } = await this.exec("systemctl", ["is-enabled", unit]);
      const v = stdout.trim();
      if (v === "enabled" || v === "enabled-runtime" || v === "static") return true;
      if (v === "disabled" || v === "masked") return false;
      return null;
    } catch (e: unknown) {
      // systemctl exits non-zero for disabled/masked — parse stdout when present
      const out = String((e as { stdout?: unknown })?.stdout ?? "");
      if (/^disabled/m.test(out) || /disabled/.test((e as Error)?.message ?? "")) return false;
      if (/^enabled/m.test(out)) return true;
      return null;
    }
  }
  async setEnabled(def: ServiceDefinition, enabled: boolean): Promise<void> {
    const unit = this.unitOf(def);
    await this.exec("systemctl", [enabled ? "enable" : "disable", unit]);
  }
  async activeState(def: ServiceDefinition): Promise<{ active: string | null; sub: string | null }> {
    const unit = this.unitOf(def);
    try {
      const { stdout } = await this.exec("systemctl", ["show", unit, "--property=ActiveState", "--property=SubState", "--value"]);
      // --value with two properties prints two lines
      const [active, sub] = stdout.trim().split("\n");
      return { active: active?.trim() || null, sub: sub?.trim() || null };
    } catch {
      return { active: null, sub: null };
    }
  }
}

async function defaultExec(cmd: string, args: ReadonlyArray<string>): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, [...args]);
  return { stdout: String(stdout), stderr: String(stderr) };
}

class DockerDriver implements ServiceDriver {
  readonly type = "docker";
  private containerOf(def: ServiceDefinition): string {
    return def.dockerContainer ?? def.id;
  }
  async start(def: ServiceDefinition): Promise<{ pid: number | null; proc: ChildProcess | null }> {
    const container = this.containerOf(def);
    // try docker start, else docker run
    try {
      await execFileAsync("docker", ["start", container]);
      return { pid: null, proc: null };
    } catch {
      // try run if image provided
      if (def.dockerImage) {
        const args = ["run", "-d", "--name", container];
        if (def.port) args.push("-p", `${def.port}:${def.port}`);
        if (def.env) for (const [k, v] of Object.entries(def.env)) args.push("-e", `${k}=${v}`);
        args.push(def.dockerImage);
        // if command overrides entrypoint
        if (def.command && def.command !== def.dockerImage) args.push(...def.command.split(" "));
        await execFileAsync("docker", args);
        return { pid: null, proc: null };
      }
      throw new Error(`Docker container ${container} not found and no dockerImage provided`);
    }
  }
  async stop(def: ServiceDefinition): Promise<void> {
    const container = this.containerOf(def);
    await execFileAsync("docker", ["stop", container]);
  }
  async status(def: ServiceDefinition): Promise<{ running: boolean; pid: number | null }> {
    const container = this.containerOf(def);
    try {
      const { stdout } = await execFileAsync("docker", ["inspect", "-f", "{{.State.Running}}", container]);
      const running = stdout.trim() === "true";
      if (!running) return { running: false, pid: null };
      try {
        const { stdout: pidStr } = await execFileAsync("docker", ["inspect", "-f", "{{.State.Pid}}", container]);
        const pid = parseInt(pidStr.trim(), 10);
        return { running: true, pid: pid > 0 ? pid : null };
      } catch {
        return { running: true, pid: null };
      }
    } catch {
      return { running: false, pid: null };
    }
  }
  async logs(def: ServiceDefinition, tailLines: number): Promise<string> {
    const container = this.containerOf(def);
    try {
      const { stdout } = await execFileAsync("docker", ["logs", "--tail", String(tailLines), container]);
      return stdout;
    } catch (e: unknown) {
      return `docker logs failed: ${(e as Error).message}`;
    }
  }
}

// ---------- Health checks ----------

async function checkPort(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
}

async function checkHttp(url: string, timeoutMs = 2000): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// ---------- ServiceManager ----------

/** A service that stays up this long resets its consecutive-failure budget. */
const RESTART_GRACE_MS = 60_000;

interface RuntimeState {
  def: ServiceDefinition;
  status: ServiceStatus;
  proc: ChildProcess | null;
  pid: number | null;
  startedAt: string | null;
  restartCount: number;
  lastExitCode: number | null;
  lastError: string | null;
  health: ServiceInstance["health"];
  logsPath: string | null;
  // detail-page cache (refreshed by getStatus)
  systemdEnabled: boolean | null;
  systemdActiveState: string | null;
  systemdSubState: string | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  // for backoff
  consecutiveFailures: number;
  stopping: boolean;
}

export class ServiceManager {
  private defs = new Map<string, ServiceDefinition>();
  private runtimes = new Map<string, RuntimeState>();
  private drivers = new Map<string, ServiceDriver>();
  private listeners = new Set<(ev: ServiceEvent) => void>();
  private monitorTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly servicesPath: string,
    private readonly logsBase: string,
    opts?: { exec?: ExecFn; drivers?: ReadonlyArray<ServiceDriver> },
  ) {
    this.logsBase = path.join(logsBase, "services");
    if (opts?.drivers) {
      for (const d of opts.drivers) this.drivers.set(d.type, d);
    } else {
      const exec = opts?.exec ?? defaultExec;
      this.drivers.set("shell", new ShellDriver());
      this.drivers.set("systemd", new SystemdDriver(exec));
      this.drivers.set("docker", new DockerDriver());
    }
  }

  async init(): Promise<void> {
    await fsp.mkdir(path.dirname(this.servicesPath), { recursive: true });
    await fsp.mkdir(this.logsBase, { recursive: true });
    try {
      const raw = await fsp.readFile(this.servicesPath, "utf8");
      const arr = JSON.parse(raw) as ServiceDefinition[];
      for (const d of arr) {
        const normalized = this.normalizeDef(d);
        this.defs.set(normalized.id, normalized);
        this.runtimes.set(normalized.id, this.makeRuntime(normalized));
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") console.warn("[services] failed to load", (e as Error).message);
    }
    // auto-start enabled services
    for (const rt of this.runtimes.values()) {
      if (rt.def.enabled) {
        this.start(rt.def.id).catch((err: unknown) => console.warn(`[services] auto-start ${rt.def.id} failed:`, (err as Error).message));
      }
    }
    this.startMonitors();
  }

  private normalizeDef(d: ServiceDefinition): ServiceDefinition {
    // fill defaults if missing (backwards compat) — spread first, then defaults
    return {
      ...d,
      type: d.type ?? "shell",
      autoRestart: d.autoRestart ?? true,
      restartDelayMs: d.restartDelayMs ?? 3000,
      maxRestarts: d.maxRestarts ?? 5,
      enabled: d.enabled ?? false,
      healthCheck:
        d.healthCheck ??
        (d.port
          ? { type: "port" as const, target: String(d.port), intervalMs: 5000, timeoutMs: 2000 }
          : { type: "process" as const, intervalMs: 5000, timeoutMs: 2000 }),
    } as ServiceDefinition;
  }

  private makeRuntime(def: ServiceDefinition): RuntimeState {
    const logsPath = def.type === "shell" ? path.join(this.logsBase, `${def.id}.log`) : null;
    return {
      def,
      status: "stopped",
      proc: null,
      pid: null,
      startedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastError: null,
      health: null,
      logsPath,
      systemdEnabled: null,
      systemdActiveState: null,
      systemdSubState: null,
      cpuPercent: null,
      memoryBytes: null,
      consecutiveFailures: 0,
      stopping: false,
    };
  }

  private async persist(): Promise<void> {
    const arr = [...this.defs.values()];
    await fsp.writeFile(this.servicesPath, JSON.stringify(arr, null, 2) + "\n", "utf8");
  }

  onEvent(listener: (ev: ServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(ev: ServiceEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {}
    }
  }

  private toInstance(rt: RuntimeState): ServiceInstance {
    const uptimeSeconds = rt.startedAt ? (Date.now() - new Date(rt.startedAt).getTime()) / 1000 : null;
    // `error` is a legacy alias of `failed` — normalize on the wire so the
    // client only has to render Running / Stopped / Failed.
    const status = rt.status === "error" ? "failed" : rt.status;
    return {
      ...rt.def,
      status,
      pid: rt.pid,
      uptimeSeconds: rt.status === "running" && uptimeSeconds !== null ? Math.max(0, uptimeSeconds) : null,
      restartCount: rt.restartCount,
      lastExitCode: rt.lastExitCode,
      lastError: rt.lastError,
      startedAt: rt.startedAt,
      health: rt.health,
      logsPath: rt.logsPath,
      url: deriveServiceUrl(rt.def.port),
      systemdEnabled: rt.systemdEnabled ?? null,
      systemdActiveState: rt.systemdActiveState ?? null,
      systemdSubState: rt.systemdSubState ?? null,
      cpuPercent: rt.cpuPercent ?? null,
      memoryBytes: rt.memoryBytes ?? null,
    };
  }

  list(): ServiceInstance[] {
    return [...this.runtimes.values()].map((rt) => this.toInstance(rt)).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): ServiceInstance | undefined {
    const rt = this.runtimes.get(id);
    return rt ? this.toInstance(rt) : undefined;
  }

  async create(input: {
    id?: string;
    name: string;
    description?: string;
    icon?: string;
    command: string;
    type?: ServiceDefinition["type"];
    systemdUnit?: string;
    dockerContainer?: string;
    dockerImage?: string;
    cwd?: string;
    env?: Record<string, string>;
    healthCheck?: ServiceDefinition["healthCheck"];
    port?: number;
    autoRestart?: boolean;
    restartDelayMs?: number;
    maxRestarts?: number;
    enabled?: boolean;
  }): Promise<ServiceDefinition> {
    const id = input.id ?? `svc_${crypto.randomBytes(4).toString("hex")}`;
    if (!/^[a-z0-9_-]+$/.test(id)) throw new ServiceRpcError("invalid_id", `Invalid service id: ${id}`);
    if (this.defs.has(id)) throw new ServiceRpcError("already_exists", `Service already exists: ${id}`);
    const now = new Date().toISOString();
    const def: ServiceDefinition = {
      id,
      name: input.name,
      description: input.description ?? "",
      icon: input.icon,
      command: input.command,
      type: input.type ?? "shell",
      systemdUnit: input.systemdUnit,
      dockerContainer: input.dockerContainer,
      dockerImage: input.dockerImage,
      cwd: input.cwd,
      env: input.env,
      healthCheck: input.healthCheck ?? (input.port ? { type: "port", target: String(input.port), intervalMs: 5000, timeoutMs: 2000 } : undefined),
      port: input.port,
      autoRestart: input.autoRestart ?? true,
      restartDelayMs: input.restartDelayMs ?? 3000,
      maxRestarts: input.maxRestarts ?? 5,
      enabled: input.enabled ?? false,
      createdAt: now,
      updatedAt: now,
    };
    const normalized = this.normalizeDef(def);
    this.defs.set(id, normalized);
    this.runtimes.set(id, this.makeRuntime(normalized));
    await this.persist();
    this.emit({ type: "status", service: this.toInstance(this.runtimes.get(id)!) });
    return normalized;
  }

  async update(id: string, patch: Partial<Omit<ServiceDefinition, "id" | "createdAt" | "updatedAt">>): Promise<ServiceDefinition> {
    const existing = this.defs.get(id);
    if (!existing) throw new ServiceRpcError("not_found", `Unknown service: ${id}`);
    const now = new Date().toISOString();
    const updated: ServiceDefinition = {
      ...existing,
      ...patch,
      id,
      updatedAt: now,
    };
    const normalized = this.normalizeDef(updated);
    this.defs.set(id, normalized);
    const rt = this.runtimes.get(id)!;
    rt.def = normalized;
    await this.persist();
    this.emit({ type: "status", service: this.toInstance(rt) });
    return normalized;
  }

  async delete(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) throw new ServiceRpcError("not_found", `Unknown service: ${id}`);
    // stop if running
    if (rt.status === "running" || rt.status === "starting") {
      await this.stop(id).catch(() => {});
    }
    this.defs.delete(id);
    this.runtimes.delete(id);
    await this.persist();
  }

  async start(id: string): Promise<ServiceInstance> {
    const rt = this.runtimes.get(id);
    if (!rt) throw new ServiceRpcError("not_found", `Unknown service: ${id}`);
    if (rt.status === "running" || rt.status === "starting") return this.toInstance(rt);
    const def = rt.def;
    const driver = this.drivers.get(def.type);
    if (!driver) throw new ServiceRpcError("unknown", `Unknown driver: ${def.type}`);

    rt.status = "starting";
    rt.lastError = null;
    rt.stopping = false;
    this.emit({ type: "status", service: this.toInstance(rt) });

    try {
      const { pid, proc } = await driver.start(def, rt.logsPath ?? path.join(this.logsBase, `${id}.log`));
      rt.proc = proc;
      rt.pid = pid;
      rt.startedAt = new Date().toISOString();
      rt.status = "running";
      rt.consecutiveFailures = 0;
      // hook exit for shell
      if (proc && typeof proc.on === "function") {
        const onClose = (code: number | null, signal: string | null) => {
          this.handleUnexpectedExit(id, code, signal);
        };
        proc.on("close", onClose);
        proc.on("error", (err: Error) => {
          rt.lastError = (err as Error).message;
          rt.status = "failed";
          this.emit({ type: "error", serviceId: id, message: (err as Error).message });
        });
        // pipe output events for shell
        proc.stdout?.on("data", (d: Buffer) => this.emit({ type: "output", serviceId: id, data: d.toString("utf8") }));
        proc.stderr?.on("data", (d: Buffer) => this.emit({ type: "output", serviceId: id, data: d.toString("utf8") }));
        // fail-fast race: the process may already be gone before we attached
        // (driver.start awaits log setup) — missed 'close' events would leave
        // a zombie "running" state restarted forever by the monitor.
        if (proc.exitCode !== null || proc.signalCode !== null) {
          setImmediate(() => this.handleUnexpectedExit(id, proc.exitCode, proc.signalCode));
        }
      } else {
        // for systemd/docker, we need to poll status; assume running
        rt.consecutiveFailures = 0;
      }
      // immediate health check
      this.runHealthCheck(rt).catch(() => {});
      this.emit({ type: "status", service: this.toInstance(rt) });
      return this.toInstance(rt);
    } catch (e: unknown) {
      rt.status = "failed";
      rt.lastError = (e as Error).message;
      this.emit({ type: "error", serviceId: id, message: (e as Error).message });
      throw e;
    }
  }

  async stop(id: string, signal = "SIGTERM"): Promise<ServiceInstance> {
    const rt = this.runtimes.get(id);
    if (!rt) throw new ServiceRpcError("not_found", `Unknown service: ${id}`);
    if (rt.status === "stopped") return this.toInstance(rt);
    rt.stopping = true;
    rt.status = "stopping";
    this.emit({ type: "status", service: this.toInstance(rt) });
    const driver = this.drivers.get(rt.def.type);
    try {
      await driver?.stop(rt.def, rt.proc, signal);
    } catch (e: unknown) {
      rt.lastError = (e as Error).message;
    }
    // for shell, wait a bit then force
    if (rt.proc) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            rt.proc?.kill("SIGKILL");
          } catch {}
          resolve();
        }, 2000);
        rt.proc!.once("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    rt.proc = null;
    rt.pid = null;
    rt.status = "stopped";
    rt.startedAt = null;
    rt.health = null;
    this.emit({ type: "status", service: this.toInstance(rt) });
    return this.toInstance(rt);
  }

  async restart(id: string): Promise<ServiceInstance> {
    await this.stop(id);
    // small delay
    await new Promise((r) => setTimeout(r, 500));
    return this.start(id);
  }

  /**
   * Shared unexpected-exit path (close event, missed close for fail-fast
   * processes, monitor catch-up). Counts quick deaths against the restart
   * budget so fail-fast loops settle on Failed; a service that stayed up
   * past the grace period resets the counter.
   */
  private handleUnexpectedExit(id: string, code: number | null, signal: string | null): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    if (rt.stopping) return; // intentional stop
    if (rt.status !== "running" && rt.status !== "starting" && rt.status !== "failed") return;
    // already accounted for (e.g. close event + missed-exit check both firing)
    if (rt.status === "failed" && rt.proc === null && rt.lastExitCode === (code ?? null)) return;
    const def = rt.def;
    rt.lastExitCode = code ?? null;
    rt.proc = null;
    rt.pid = null;
    rt.status = "failed";
    rt.lastError = `Exited with code ${code} signal ${signal}`;
    this.emit({ type: "status", service: this.toInstance(rt) });
    const uptimeMs = rt.startedAt ? Date.now() - new Date(rt.startedAt).getTime() : 0;
    if (uptimeMs > RESTART_GRACE_MS) rt.consecutiveFailures = 0;
    if (def.autoRestart && rt.consecutiveFailures < (def.maxRestarts ?? 5)) {
      rt.consecutiveFailures++;
      rt.restartCount++;
      const delay = def.restartDelayMs ?? 3000;
      setTimeout(() => {
        const cur = this.runtimes.get(id);
        if (!cur || cur.stopping) return;
        if (cur.status !== "failed" && cur.status !== "error") return;
        this.start(id).catch((e) => {
          cur.lastError = (e as Error).message;
          this.emit({ type: "error", serviceId: id, message: (e as Error).message });
        });
      }, delay);
    }
  }

  async getStatus(id: string): Promise<ServiceInstance> {
    const rt = this.runtimes.get(id);
    if (!rt) throw new ServiceRpcError("not_found", `Unknown service: ${id}`);
    // refresh status from driver (for systemd/docker)
    if (rt.def.type !== "shell") {
      const driver = this.drivers.get(rt.def.type);
      if (driver) {
        const { running, pid } = await driver.status(rt.def, rt.proc);
        rt.status = running ? "running" : "stopped";
        rt.pid = pid;
        if (running && !rt.startedAt) rt.startedAt = new Date().toISOString();
        if (!running) rt.startedAt = null;
        if (rt.def.type === "systemd") {
          const [state, mem] = await Promise.all([
            driver.activeState?.(rt.def).catch(() => ({ active: null, sub: null })) ?? { active: null, sub: null },
            procStatsForPid(pid).catch(() => ({ cpuPercent: null, memoryBytes: null })),
          ]);
          rt.systemdActiveState = state.active ?? null;
          rt.systemdSubState = state.sub ?? null;
          rt.systemdEnabled = (await driver.isEnabled?.(rt.def).catch(() => null)) ?? rt.systemdEnabled ?? null;
          rt.memoryBytes = mem.memoryBytes ?? rt.memoryBytes ?? null;
        }
      }
    } else if (rt.proc) {
      // for shell, verify still running
      const driver = this.drivers.get("shell")!;
      const { running, pid } = await driver.status(rt.def, rt.proc);
      if (!running) {
        // was considered running but died without close event
        if (!rt.stopping) {
          rt.status = "failed";
          rt.lastError = "Process died unexpectedly";
          rt.proc = null;
          rt.pid = null;
        }
      } else {
        rt.pid = pid;
        const mem = await procStatsForPid(pid).catch(() => ({ cpuPercent: null, memoryBytes: null }));
        rt.memoryBytes = mem.memoryBytes ?? rt.memoryBytes ?? null;
      }
    }
    await this.runHealthCheck(rt);
    const inst = this.toInstance(rt);
    this.emit({ type: "status", service: inst });
    return inst;
  }

  private async runHealthCheck(rt: RuntimeState): Promise<void> {
    const hc = rt.def.healthCheck;
    if (!hc || rt.status !== "running") {
      rt.health = null;
      return;
    }
    let ok = false;
    let message: string | undefined;
    try {
      if (hc.type === "port" || (rt.def.port && hc.type === "process" && false)) {
        const port = rt.def.port ?? parseInt(hc.target ?? "", 10);
        if (port) ok = await checkPort(port, hc.timeoutMs ?? 2000);
        else ok = rt.status === "running";
        if (!ok) message = `Port ${port} not reachable`;
      } else if (hc.type === "http") {
        const url = hc.target ?? (rt.def.port ? `http://127.0.0.1:${rt.def.port}/` : "");
        if (url) ok = await checkHttp(url, hc.timeoutMs ?? 2000);
        else ok = rt.status === "running";
        if (!ok) message = `HTTP ${url} failed`;
      } else {
        // process
        ok = rt.status === "running" && !!rt.pid;
        if (!ok) message = "Process not running";
      }
    } catch (e: unknown) {
      ok = false;
      message = (e as Error).message;
    }
    rt.health = { ok, checkedAt: new Date().toISOString(), message };
    this.emit({ type: "health", serviceId: rt.def.id, health: rt.health });
  }

  async readLogs(id: string, tailLines = 200): Promise<string> {
    const rt = this.runtimes.get(id);
    if (!rt) throw new ServiceRpcError("not_found", `Unknown service: ${id}`);
    if (rt.def.type !== "shell") {
      const driver = this.drivers.get(rt.def.type);
      if (driver) return driver.logs(rt.def, tailLines);
    }
    const p = rt.logsPath ?? path.join(this.logsBase, `${id}.log`);
    try {
      const content = await fsp.readFile(p, "utf8");
      const lines = content.split("\n");
      if (lines.length <= tailLines) return content;
      return lines.slice(lines.length - tailLines).join("\n");
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return "";
      throw e;
    }
  }

  /**
   * List systemd units, hiding system plumbing by default.
   * Powers the Services list "add from system" flow — user-facing only
   * (Jellyfin, Docker, Samba-class) unless `userFacingOnly: false`.
   */
  async discover(opts?: { userFacingOnly?: boolean; query?: string; limit?: number }): Promise<
    ReadonlyArray<import("@home-server/contracts").SystemdUnitSummary>
  > {
    return Effect.runPromise(this.discoverEffect(opts));
  }

  discoverEffect(opts?: {
    userFacingOnly?: boolean;
    query?: string;
    limit?: number;
  }): Effect.Effect<
    ReadonlyArray<import("@home-server/contracts").SystemdUnitSummary>,
    ServiceSystemError
  > {
    const userFacingOnly = opts?.userFacingOnly ?? true;
    const query = opts?.query?.trim().toLowerCase() || "";
    const limit = opts?.limit ?? 100;
    return Effect.tryPromise({
      try: async () => {
        const exec = defaultExec;
        let stdout = "";
        try {
          ({ stdout } = await exec("systemctl", [
            "list-units",
            "--type=service",
            "--all",
            "--plain",
            "--no-legend",
            "--no-pager",
          ]));
        } catch (e: unknown) {
          throw new ServiceSystemError({ op: "systemctl list-units", cause: e });
        }
        const managedUnits = new Map<string, string>();
        for (const rt of this.runtimes.values()) {
          if (rt.def.type === "systemd") {
            managedUnits.set(rt.def.systemdUnit ?? `${rt.def.id}.service`, rt.def.id);
          }
        }
        // descriptions come from `systemctl list-units` 4th+ column; enabled
        // state is resolved lazily per unit only for candidates (bounded)
        const rows: Array<{ unit: string; description: string; load: string; active: string; sub: string }> = [];
        for (const line of stdout.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          const parts = t.split(/\s+/);
          const unit = parts[0];
          if (!unit || !unit.endsWith(".service")) continue;
          const load = parts[1] ?? "";
          const active = parts[2] ?? "";
          const sub = parts[3] ?? "";
          const description = parts.slice(4).join(" ");
          rows.push({ unit, description, load, active, sub });
        }
        let out = rows.map((r) => ({
          unit: r.unit,
          description: r.description,
          loadState: r.load,
          activeState: r.active,
          subState: r.sub,
          enabled: null as boolean | null,
          userFacing: isUserFacingUnit(r.unit, r.description),
          managedId: managedUnits.get(r.unit) ?? null,
        }));
        if (userFacingOnly) out = out.filter((u) => u.userFacing);
        if (query) {
          out = out.filter(
            (u) => u.unit.toLowerCase().includes(query) || u.description.toLowerCase().includes(query),
          );
        }
        out.sort((a, b) => a.unit.localeCompare(b.unit));
        const sliced = out.slice(0, limit);
        // resolve is-enabled for the visible slice only (bounded systemctl calls)
        await Promise.all(
          sliced.map(async (u) => {
            try {
              const { stdout: en } = await exec("systemctl", ["is-enabled", u.unit]);
              const v = en.trim();
              u.enabled = v === "enabled" || v === "enabled-runtime" || v === "static";
            } catch {
              u.enabled = null;
            }
          }),
        );
        return sliced;
      },
      catch: (cause) =>
        cause instanceof ServiceSystemError ? cause : new ServiceSystemError({ op: "discover", cause }),
    });
  }

  /**
   * List docker containers (`docker ps -a`), powering the "from a container"
   * creation flow. Best-effort: empty list when docker is unavailable.
   */
  async dockerList(opts?: { query?: string; limit?: number }): Promise<
    ReadonlyArray<import("@home-server/contracts").DockerContainerSummary>
  > {
    return Effect.runPromise(this.dockerListEffect(opts));
  }

  dockerListEffect(opts?: {
    query?: string;
    limit?: number;
  }): Effect.Effect<
    ReadonlyArray<import("@home-server/contracts").DockerContainerSummary>,
    ServiceSystemError
  > {
    const query = opts?.query?.trim().toLowerCase() || "";
    const limit = opts?.limit ?? 100;
    return Effect.tryPromise({
      try: async () => {
        const managed = new Map<string, string>();
        for (const rt of this.runtimes.values()) {
          if (rt.def.type === "docker") {
            managed.set(rt.def.dockerContainer ?? rt.def.id, rt.def.id);
          }
        }
        let stdout = "";
        try {
          ({ stdout } = await defaultExec("docker", ["ps", "-a", "--format", "{{json .}}"]));
        } catch {
          return [];
        }
        let out: Array<{
          name: string;
          image: string;
          state: string;
          status: string;
          running: boolean;
          managedId: string | null;
        }> = [];
        for (const line of stdout.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          try {
            const c = JSON.parse(t) as { Names?: string; Image?: string; State?: string; Status?: string };
            const name = (c.Names ?? "").trim();
            if (!name) continue;
            out.push({
              name,
              image: (c.Image ?? "").trim(),
              state: (c.State ?? "").trim(),
              status: (c.Status ?? "").trim(),
              running: (c.State ?? "").toLowerCase() === "running",
              managedId: managed.get(name) ?? null,
            });
          } catch {
            // skip unparseable lines
          }
        }
        let filtered = out;
        if (query) {
          filtered = filtered.filter(
            (c) => c.name.toLowerCase().includes(query) || c.image.toLowerCase().includes(query),
          );
        }
        filtered.sort((a, b) => a.name.localeCompare(b.name));
        return filtered.slice(0, limit);
      },
      catch: (cause) => new ServiceSystemError({ op: "dockerList", cause }),
    });
  }

  /** Enable/disable start-on-boot. systemd → `systemctl enable/disable`; else `enabled` flag. */
  async setEnabled(id: string, enabled: boolean): Promise<ServiceInstance> {
    const rt = this.runtimes.get(id);
    if (!rt) throw new ServiceRpcError("not_found", `Unknown service: ${id}`);
    if (rt.def.type === "systemd") {
      const driver = this.drivers.get("systemd");
      try {
        await driver?.setEnabled?.(rt.def, enabled);
        rt.systemdEnabled = enabled;
      } catch (e: unknown) {
        throw new ServiceRpcError("unknown", `systemctl ${enabled ? "enable" : "disable"} failed: ${(e as Error).message}`);
      }
    }
    const updated = await this.update(id, { enabled });
    void updated;
    const inst = await this.getStatus(id).catch(() => this.toInstance(rt));
    this.emit({ type: "status", service: inst });
    return inst;
  }

  // ---- Effect-native adapters (same structure as terminal/filesystem) ----

  listEffect(): Effect.Effect<ReadonlyArray<ServiceInstance>> {
    return Effect.succeed(this.list());
  }

  getEffect(id: string): Effect.Effect<ServiceInstance, ServiceNotFoundError> {
    const s = this.get(id);
    return s ? Effect.succeed(s) : Effect.fail(new ServiceNotFoundError({ id }));
  }

  getStatusEffect(id: string): Effect.Effect<ServiceInstance, ServiceNotFoundError | ServiceSystemError> {
    return Effect.tryPromise({
      try: () => this.getStatus(id),
      catch: (cause) =>
        cause instanceof ServiceRpcError && cause.code === "not_found"
          ? new ServiceNotFoundError({ id })
          : new ServiceSystemError({ id, op: "getStatus", cause }),
    });
  }

  createEffect(
    input: Parameters<ServiceManager["create"]>[0],
  ): Effect.Effect<ServiceDefinition, ServiceAlreadyExistsError | ServiceInvalidIdError> {
    return Effect.tryPromise({
      try: () => this.create(input),
      catch: (cause) => {
        const code = (cause as ServiceRpcError)?.code;
        const id = String((input as { id?: string }).id ?? "");
        if (code === "already_exists") return new ServiceAlreadyExistsError({ id });
        return new ServiceInvalidIdError({ id }) as unknown as ServiceAlreadyExistsError;
      },
    });
  }

  startEffect(id: string): Effect.Effect<ServiceInstance, ServiceNotFoundError | ServiceDriverError> {
    return Effect.tryPromise({
      try: () => this.start(id),
      catch: (cause) =>
        (cause as ServiceRpcError)?.code === "not_found"
          ? new ServiceNotFoundError({ id })
          : new ServiceDriverError({ id, driver: this.runtimes.get(id)?.def.type ?? "unknown", cause }),
    });
  }

  stopEffect(id: string, signal?: string): Effect.Effect<ServiceInstance, ServiceNotFoundError> {
    return Effect.tryPromise({
      try: () => this.stop(id, signal),
      catch: () => new ServiceNotFoundError({ id }),
    });
  }

  restartEffect(id: string): Effect.Effect<ServiceInstance, ServiceNotFoundError | ServiceDriverError> {
    return Effect.tryPromise({
      try: () => this.restart(id),
      catch: (cause) =>
        (cause as ServiceRpcError)?.code === "not_found"
          ? new ServiceNotFoundError({ id })
          : new ServiceDriverError({ id, driver: this.runtimes.get(id)?.def.type ?? "unknown", cause }),
    });
  }

  readLogsEffect(id: string, tailLines = 200): Effect.Effect<string, ServiceNotFoundError> {
    return Effect.tryPromise({
      try: () => this.readLogs(id, tailLines),
      catch: () => new ServiceNotFoundError({ id }),
    });
  }

  setEnabledEffect(
    id: string,
    enabled: boolean,
  ): Effect.Effect<ServiceInstance, ServiceNotFoundError | ServiceSystemError> {
    return Effect.tryPromise({
      try: () => this.setEnabled(id, enabled),
      catch: (cause) =>
        (cause as ServiceRpcError)?.code === "not_found"
          ? new ServiceNotFoundError({ id })
          : new ServiceSystemError({ id, op: "setEnabled", cause }),
    });
  }

  onEventEffect(listener: (ev: ServiceEvent) => void): Effect.Effect<() => void> {
    return Effect.sync(() => this.onEvent(listener));
  }

  private startMonitors(): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    // status monitor: every 5s ensure autoRestart services are up + refresh systemd/docker
    this.monitorTimer = setInterval(() => {
      for (const rt of this.runtimes.values()) {
        // refresh external
        if (rt.def.type !== "shell") {
          this.getStatus(rt.def.id).catch(() => {});
        } else if (rt.def.autoRestart && (rt.status === "failed" || rt.status === "error") && !rt.stopping) {
          // missed by the close handler (or it already gave up) — retry within
          // budget so this backstop can't loop forever either.
          if (rt.consecutiveFailures < (rt.def.maxRestarts ?? 5)) {
            rt.consecutiveFailures++;
            rt.restartCount++;
            this.start(rt.def.id).catch(() => {});
          }
        }
      }
    }, 5000);
    this.monitorTimer.unref?.();

    this.healthTimer = setInterval(() => {
      for (const rt of this.runtimes.values()) {
        if (rt.status === "running") this.runHealthCheck(rt).catch(() => {});
      }
    }, 5000);
    this.healthTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    // don't stop services on shutdown by default; leave them running unless enabled? But we can stop shell ones
    // For now, just clear timers and leave shell procs — they will be orphaned? Better stop them? Let's keep them running
    // as jellyfin should persist beyond server restart if possible, but shell procs are children so they die with parent.
    // So we intentionally keep them? Actually child will die, so we might want to NOT stop? But they will die anyway.
    // For clean shutdown, we leave them.
  }

  // For extensibility: allow registering custom driver
  registerDriver(driver: ServiceDriver): void {
    this.drivers.set(driver.type, driver);
  }

  shutdownEffect(): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.monitorTimer) clearInterval(this.monitorTimer);
      if (this.healthTimer) clearInterval(this.healthTimer);
    });
  }
}

/** Effect Layer — same structure as FilesystemServiceLive / TerminalManagerLive. */
export const ServiceManagerLive = (servicesPath: string, logsBase: string, opts?: { exec?: ExecFn }) =>
  Layer.sync(ServiceManagerTag, () => {
    const mgr = new ServiceManager(servicesPath, logsBase, opts);
    return ServiceManagerTag.of({
      list: () => mgr.listEffect(),
      get: (id) => mgr.getEffect(id),
      getStatus: (id) => mgr.getStatusEffect(id),
      create: (input) => mgr.createEffect(input),
      update: (id, patch) => Effect.tryPromise({
        try: () => mgr.update(id, patch),
        catch: () => new ServiceNotFoundError({ id }),
      }),
      delete: (id) => Effect.tryPromise({
        try: () => mgr.delete(id),
        catch: () => new ServiceNotFoundError({ id }),
      }),
      start: (id) => mgr.startEffect(id),
      stop: (id, signal) => mgr.stopEffect(id, signal),
      restart: (id) => mgr.restartEffect(id),
      readLogs: (id, tailLines) => mgr.readLogsEffect(id, tailLines),
      discover: (dOpts) => mgr.discoverEffect(dOpts),
      setEnabled: (id, enabled) => mgr.setEnabledEffect(id, enabled),
      dockerList: (dOpts) => mgr.dockerListEffect(dOpts),
    });
  });
