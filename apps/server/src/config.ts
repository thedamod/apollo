import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ServerConfig {
  port: number;
  host: string;
  baseDir: string;
  dataDir: string;
  logsDir: string;
  terminalLogsDir: string;
  scriptsPath: string;
  servicesPath: string;
  tokenPath: string;
  runtimeStatePath: string;
  tailscaleServeEnabled: boolean;
  tailscaleServePort: number;
  authToken: string | undefined; // loaded from disk
}

export interface DerivedPaths {
  baseDir: string;
  dataDir: string;
  logsDir: string;
  terminalLogsDir: string;
  scriptsPath: string;
  servicesPath: string;
  tokenPath: string;
  runtimeStatePath: string;
}

export function derivePaths(baseDir: string): DerivedPaths {
  const dataDir = path.join(baseDir, "userdata");
  const logsDir = path.join(dataDir, "logs");
  return {
    baseDir,
    dataDir,
    logsDir,
    terminalLogsDir: path.join(logsDir, "terminals"),
    scriptsPath: path.join(dataDir, "scripts.json"),
    servicesPath: path.join(dataDir, "services.json"),
    tokenPath: path.join(dataDir, "secrets", "token"),
    runtimeStatePath: path.join(dataDir, "server-runtime.json"),
  };
}

export function resolveBaseDir(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.HOME_SERVER_HOME) return path.resolve(process.env.HOME_SERVER_HOME);
  return path.join(os.homedir(), ".home-server");
}

export function loadOrCreateConfig(opts: {
  port?: number;
  host?: string;
  baseDir?: string;
  tailscaleServeEnabled?: boolean;
  tailscaleServePort?: number;
}): ServerConfig {
  const baseDir = resolveBaseDir(opts.baseDir);
  const d = derivePaths(baseDir);

  // ensure dirs
  fs.mkdirSync(d.dataDir, { recursive: true });
  fs.mkdirSync(d.logsDir, { recursive: true });
  fs.mkdirSync(d.terminalLogsDir, { recursive: true });
  fs.mkdirSync(path.dirname(d.tokenPath), { recursive: true });

  let authToken: string | undefined;
  try {
    if (fs.existsSync(d.tokenPath)) authToken = fs.readFileSync(d.tokenPath, "utf8").trim();
  } catch {}

  return {
    port: opts.port ?? Number(process.env.HOME_SERVER_PORT ?? 7070),
    host: opts.host ?? process.env.HOME_SERVER_HOST ?? "127.0.0.1",
    baseDir: d.baseDir,
    dataDir: d.dataDir,
    logsDir: d.logsDir,
    terminalLogsDir: d.terminalLogsDir,
    scriptsPath: d.scriptsPath,
    servicesPath: d.servicesPath,
    tokenPath: d.tokenPath,
    runtimeStatePath: d.runtimeStatePath,
    tailscaleServeEnabled: opts.tailscaleServeEnabled ?? process.env.HOME_SERVER_TAILSCALE === "1",
    tailscaleServePort: opts.tailscaleServePort ?? Number(process.env.HOME_SERVER_TAILSCALE_PORT ?? 443),
    authToken,
  };
}

export function getDefaultAllowedRoots(): string[] {
  // For NAS browsing, allow HOME and root (configurable later)
  return [os.homedir(), "/"];
}
