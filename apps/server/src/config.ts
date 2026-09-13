import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";

export interface ServerConfig {
  port: number;
  host: string;
  baseDir: string;
  dataDir: string;
  logsDir: string;
  terminalLogsDir: string;
  scriptsPath: string;
  widgetsPath: string;
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
  widgetsPath: string;
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
    widgetsPath: path.join(dataDir, "widgets.json"),
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
    widgetsPath: d.widgetsPath,
    servicesPath: d.servicesPath,
    tokenPath: d.tokenPath,
    runtimeStatePath: d.runtimeStatePath,
    tailscaleServeEnabled: opts.tailscaleServeEnabled ?? process.env.HOME_SERVER_TAILSCALE === "1",
    tailscaleServePort: opts.tailscaleServePort ?? Number(process.env.HOME_SERVER_TAILSCALE_PORT ?? 443),
    authToken,
  };
}

export function getDefaultAllowedRoots(): string[] {
  return [os.homedir(), "/"];
}

// ---------------------------------------------------------------------------
// Effect-native
// ---------------------------------------------------------------------------

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  cause: Schema.optional(Schema.Defect),
  message: Schema.optional(Schema.String),
}) {}

export class ServerConfigService extends Context.Tag("home-server/ServerConfig")<
  ServerConfigService,
  ServerConfig
>() {}

export function loadOrCreateConfigEffect(
  opts: {
    port?: number;
    host?: string;
    baseDir?: string;
    tailscaleServeEnabled?: boolean;
    tailscaleServePort?: number;
  } = {},
): Effect.Effect<ServerConfig, ConfigError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = resolveBaseDir(opts.baseDir);
    const d = derivePaths(baseDir);
    yield* fs.makeDirectory(d.dataDir, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
    yield* fs.makeDirectory(d.logsDir, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
    yield* fs.makeDirectory(d.terminalLogsDir, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
    const tokenDir = path.dirname(d.tokenPath);
    yield* fs.makeDirectory(tokenDir, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));

    const authToken = yield* fs
      .readFileString(d.tokenPath)
      .pipe(
        Effect.map((s) => s.trim() || undefined),
        Effect.orElseSucceed(() => undefined as string | undefined),
        Effect.catchAll(() => Effect.succeed(undefined as string | undefined)),
      );

    return {
      port: opts.port ?? Number(process.env.HOME_SERVER_PORT ?? 7070),
      host: opts.host ?? process.env.HOME_SERVER_HOST ?? "127.0.0.1",
      baseDir: d.baseDir,
      dataDir: d.dataDir,
      logsDir: d.logsDir,
      terminalLogsDir: d.terminalLogsDir,
      scriptsPath: d.scriptsPath,
      widgetsPath: d.widgetsPath,
      servicesPath: d.servicesPath,
      tokenPath: d.tokenPath,
      runtimeStatePath: d.runtimeStatePath,
      tailscaleServeEnabled: opts.tailscaleServeEnabled ?? process.env.HOME_SERVER_TAILSCALE === "1",
      tailscaleServePort: opts.tailscaleServePort ?? Number(process.env.HOME_SERVER_TAILSCALE_PORT ?? 443),
      authToken,
    };
  }).pipe(Effect.mapError((cause) => new ConfigError({ cause, message: String(cause) })));
}

export const ServerConfigLive = (
  opts: Parameters<typeof loadOrCreateConfigEffect>[0] = {},
): Layer.Layer<ServerConfigService, ConfigError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(ServerConfigService, loadOrCreateConfigEffect(opts));
