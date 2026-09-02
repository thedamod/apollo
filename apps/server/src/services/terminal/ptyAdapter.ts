/**
 * PtyAdapter — abstraction over node-pty so tests can use a fake.
 * Mirrors t3code apps/server/src/terminal/PtyAdapter.ts but minimal.
 */
export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): () => void;
}

export interface PtyAdapter {
  spawn(opts: {
    shell: string;
    args?: string[];
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
  }): PtyProcess;
}

export interface PtyAdapterFactory {
  create(): PtyAdapter;
}
