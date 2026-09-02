/**
 * Tailscale serve integration — port of t3code/packages/tailscale/src/tailscale.ts
 * without Effect dependency. Uses plain Node child_process.
 *
 * Provides:
 *  - readTailscaleStatus() -> { magicDnsName, tailnetIpv4Addresses }
 *  - ensureTailscaleServe({ localPort, servePort })
 *  - disableTailscaleServe({ servePort })
 *  - probeTailscaleHttpsEndpoint({ baseUrl })
 *  - buildTailscaleHttpsBaseUrl({ magicDnsName, servePort })
 *
 * Lifecycle matches t3code:300:apps/server/src/server.ts:559 — acquire on startup,
 * release on shutdown.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;
export const TAILSCALE_STATUS_TIMEOUT_MS = 1_500;
export const TAILSCALE_SERVE_TIMEOUT_MS = 10_000;
export const TAILSCALE_PROBE_TIMEOUT_MS = 2_500;

export type TailscaleStderrDiagnostic =
  | "no-existing-handler"
  | "not-logged-in"
  | "permission-denied"
  | "unknown";

const STDERR_PATTERNS: ReadonlyArray<[RegExp, Exclude<TailscaleStderrDiagnostic, "unknown">]> = [
  [/handler does not exist/i, "no-existing-handler"],
  [/not logged in|logged out|needs? login/i, "not-logged-in"],
  [/permission denied|access denied|must be root|operation not permitted/i, "permission-denied"],
];

export function stderrDiagnosticOf(stderr: string): TailscaleStderrDiagnostic | undefined {
  if (stderr.trim().length === 0) return undefined;
  return STDERR_PATTERNS.find(([re]) => re.test(stderr))?.[1] ?? "unknown";
}

export class TailscaleCommandError extends Error {
  override name = "TailscaleCommandError";
  constructor(
    message: string,
    public readonly subcommand: "status" | "serve",
    public readonly exitCode: number | null,
    public readonly stderrDiagnostic?: TailscaleStderrDiagnostic,
  ) {
    super(message);
  }
}

export interface TailscaleStatus {
  readonly magicDnsName: string | null;
  readonly tailnetIpv4Addresses: readonly string[];
}

function tailscaleBin(platform: NodeJS.Platform): string {
  return platform === "win32" ? "tailscale.exe" : "tailscale";
}

function runCommand(
  args: readonly string[],
  timeoutMs: number,
  subcommand: "status" | "serve",
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const bin = tailscaleBin(process.platform);
    const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill("SIGTERM");
        reject(new TailscaleCommandError(`tailscale ${subcommand} timed out after ${timeoutMs}ms`, subcommand, null));
      }
    }, timeoutMs);
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new TailscaleCommandError(`Failed to spawn tailscale ${subcommand}: ${err.message}`, subcommand, null));
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const exitCode = code ?? 0;
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export function isTailscaleIpv4Address(addr: string): boolean {
  const parts = addr.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

function normalizeMagicDnsName(dns: unknown): string | null {
  if (typeof dns !== "string") return null;
  const n = dns.trim().replace(/\.$/, "");
  return n.length > 0 ? n : null;
}

export function parseTailscaleStatus(rawJson: string): TailscaleStatus {
  const parsed = JSON.parse(rawJson) as { Self?: { DNSName?: unknown; TailscaleIPs?: unknown } };
  const magicDnsName = normalizeMagicDnsName(parsed.Self?.DNSName);
  const tailnetIpv4Addresses: string[] = [];
  if (Array.isArray(parsed.Self?.TailscaleIPs)) {
    for (const addr of parsed.Self.TailscaleIPs) {
      if (typeof addr === "string" && isTailscaleIpv4Address(addr)) tailnetIpv4Addresses.push(addr);
    }
  }
  return { magicDnsName, tailnetIpv4Addresses };
}

export async function readTailscaleStatus(): Promise<TailscaleStatus> {
  const { stdout, stderr, exitCode } = await runCommand(["status", "--json"], TAILSCALE_STATUS_TIMEOUT_MS, "status");
  if (exitCode !== 0) {
    throw new TailscaleCommandError(
      `tailscale status exited with code ${exitCode}`,
      "status",
      exitCode,
      stderrDiagnosticOf(stderr),
    );
  }
  return parseTailscaleStatus(stdout);
}

export function buildTailscaleHttpsBaseUrl(input: { magicDnsName: string; servePort?: number }): string {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const url = new URL(`https://${input.magicDnsName}`);
  if (servePort !== DEFAULT_TAILSCALE_SERVE_PORT) url.port = String(servePort);
  url.pathname = "/";
  return url.toString();
}

export async function ensureTailscaleServe(input: {
  localPort: number;
  servePort?: number;
  localHost?: string;
}): Promise<void> {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const host = input.localHost ?? "127.0.0.1";
  const args = ["serve", "--bg", `--https=${servePort}`, `http://${host}:${input.localPort}`];
  const { stderr, exitCode } = await runCommand(args, TAILSCALE_SERVE_TIMEOUT_MS, "serve");
  if (exitCode !== 0) {
    throw new TailscaleCommandError(
      `tailscale serve exited with code ${exitCode}`,
      "serve",
      exitCode,
      stderrDiagnosticOf(stderr),
    );
  }
}

export async function disableTailscaleServe(input: { servePort?: number } = {}): Promise<void> {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const args = ["serve", `--https=${servePort}`, "off"];
  const { stderr, exitCode } = await runCommand(args, TAILSCALE_SERVE_TIMEOUT_MS, "serve");
  if (exitCode !== 0) {
    const diag = stderrDiagnosticOf(stderr);
    // t3code treats no-existing-handler as success on disable
    if (diag === "no-existing-handler") return;
    throw new TailscaleCommandError(
      `tailscale serve off exited with code ${exitCode}`,
      "serve",
      exitCode,
      diag,
    );
  }
}

export async function probeTailscaleHttpsEndpoint(input: {
  baseUrl: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const timeoutMs = input.timeoutMs ?? TAILSCALE_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL("/.well-known/home-server", input.baseUrl).toString();
    const res = await fetch(url, { signal: controller.signal });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// Small helper for the server lifecycle: try to enable, but do not crash if tailscale missing
export async function tryEnsureTailscaleServe(opts: Parameters<typeof ensureTailscaleServe>[0]): Promise<boolean> {
  try {
    await ensureTailscaleServe(opts);
    return true;
  } catch (e) {
    console.warn("[tailscale] serve not configured:", (e as Error).message);
    return false;
  }
}
export async function tryDisableTailscaleServe(opts?: Parameters<typeof disableTailscaleServe>[0]): Promise<void> {
  try {
    await disableTailscaleServe(opts);
  } catch (e) {
    console.warn("[tailscale] disable failed:", (e as Error).message);
  }
}
export async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await sleep(ms);
}
