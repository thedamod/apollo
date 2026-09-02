import type { PtyAdapter, PtyProcess } from "./ptyAdapter.ts";

let pty: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pty = await import("node-pty").catch(() => null);
} catch {
  pty = null;
}

export class NodePtyAdapter implements PtyAdapter {
  spawn(opts: {
    shell: string;
    args?: string[];
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
  }): PtyProcess {
    if (!pty) {
      throw new Error("node-pty not available — install native module or use FakePtyAdapter for tests");
    }
    const proc = pty.spawn(opts.shell, opts.args ?? [], {
      name: "xterm-256color",
      cwd: opts.cwd,
      env: opts.env as any,
      cols: opts.cols,
      rows: opts.rows,
    });

    return {
      get pid() {
        return proc.pid;
      },
      write(data: string) {
        proc.write(data);
      },
      resize(cols: number, rows: number) {
        proc.resize(cols, rows);
      },
      kill(signal?: string) {
        try {
          proc.kill(signal);
        } catch {}
      },
      onData(cb: (data: string) => void) {
        const disp = proc.onData(cb);
        return () => disp.dispose?.();
      },
      onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
        const disp = proc.onExit((e: any) => cb({ exitCode: e.exitCode, signal: e.signal }));
        return () => disp.dispose?.();
      },
    } satisfies PtyProcess;
  }
}

export class FakePtyAdapter implements PtyAdapter {
  spawn(opts: {
    shell: string;
    args?: string[];
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
  }): PtyProcess {
    let dataCb: ((d: string) => void) | null = null;
    let exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
    const pid = 10000 + Math.floor(Math.random() * 50000);
    // fake echo: immediately emit shell prompt, then echo writes
    queueMicrotask(() => dataCb?.(`\r\n$ ${opts.shell} (fake pty ${pid})\r\n`));
    return {
      get pid() {
        return pid;
      },
      write(data: string) {
        // echo input
        dataCb?.(data);
        // if user typed "exit", close
        if (data.includes("exit")) {
          queueMicrotask(() => exitCb?.({ exitCode: 0 }));
        } else if (data.trim()) {
          // simulate command output
          const cmd = data.replace(/\r/g, "").trim();
          if (cmd) {
            queueMicrotask(() => dataCb?.(`\r\n[fake output for: ${cmd}]\r\n$ `));
          }
        }
      },
      resize() {},
      kill() {
        queueMicrotask(() => exitCb?.({ exitCode: 0, signal: 9 }));
      },
      onData(cb) {
        dataCb = cb;
        return () => {
          dataCb = null;
        };
      },
      onExit(cb) {
        exitCb = cb;
        return () => {
          exitCb = null;
        };
      },
    };
  }
}

export function createPtyAdapter(): PtyAdapter {
  if (pty) return new NodePtyAdapter();
  console.warn("[pty] node-pty not available, using FakePtyAdapter (tests/dev)");
  return new FakePtyAdapter();
}
