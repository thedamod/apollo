/**
 * PtyAdapter - Terminal PTY adapter service contract.
 *
 * Defines the process primitives required by terminal session management
 * without binding to a specific PTY implementation.
 * Mirrors context/t3code/apps/server/src/terminal/PtyAdapter.ts
 *
 * @module PtyAdapter
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * PtySpawnError - Error type for PTY spawn failures.
 */
export class PtySpawnError extends Schema.TaggedError<PtySpawnError>()("PtySpawnError", {
  adapter: Schema.String,
  shell: Schema.optional(Schema.String),
  attemptedShells: Schema.optional(Schema.Array(Schema.String)),
  cause: Schema.optional(Schema.Defect),
}) {
  get message(): string {
    const shell = this.shell === undefined ? "" : ` '${this.shell}'`;
    const attemptedShells =
      this.attemptedShells === undefined || this.attemptedShells.length === 0
        ? ""
        : ` Tried shells: ${this.attemptedShells.join(", ")}.`;
    return `Failed to spawn PTY process${shell} with ${this.adapter}.${attemptedShells}`;
  }
}

export interface PtyExitEvent {
  exitCode: number;
  signal: number | null;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (event: PtyExitEvent) => void): () => void;
}

export interface PtySpawnInput {
  shell: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

/**
 * PtyAdapter - Service tag for PTY process integration.
 */
export class PtyAdapter extends Context.Tag("home-server/terminal/PtyAdapter")<
  PtyAdapter,
  {
    /**
     * Spawn a PTY process for a terminal session.
     */
    readonly spawn: (input: PtySpawnInput) => Effect.Effect<PtyProcess, PtySpawnError>;
  }
>() {}

/**
 * Legacy synchronous adapter shape — kept for incremental migration of
 * `TerminalManager` which historically constructed the adapter synchronously.
 * New code should depend on the `PtyAdapter` Context.Tag and `Layer`s.
 */
export interface PtyAdapterSync {
  spawn(input: PtySpawnInput): PtyProcess;
}
