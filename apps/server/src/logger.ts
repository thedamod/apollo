import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

export type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info";

export function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (levelOrder[level] < levelOrder[currentLevel]) return;
  const ts = new Date().toISOString();
  const line = meta ? `${ts} [${level}] ${msg} ${JSON.stringify(meta)}` : `${ts} [${level}] ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (m: string, meta?: Record<string, unknown>) => log("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => log("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => log("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => log("error", m, meta),
};

// ---------------------------------------------------------------------------
// Effect-native
// ---------------------------------------------------------------------------

export class LoggerService extends Context.Tag("home-server/Logger")<
  LoggerService,
  {
    readonly debug: (message: string, meta?: Record<string, unknown>) => Effect.Effect<void>;
    readonly info: (message: string, meta?: Record<string, unknown>) => Effect.Effect<void>;
    readonly warn: (message: string, meta?: Record<string, unknown>) => Effect.Effect<void>;
    readonly error: (message: string, meta?: Record<string, unknown>) => Effect.Effect<void>;
  }
>() {}

export const LoggerLive = Layer.succeed(
  LoggerService,
  LoggerService.of({
    debug: (m, meta) => Effect.sync(() => log("debug", m, meta)),
    info: (m, meta) => Effect.sync(() => log("info", m, meta)),
    warn: (m, meta) => Effect.sync(() => log("warn", m, meta)),
    error: (m, meta) => Effect.sync(() => log("error", m, meta)),
  }),
);
