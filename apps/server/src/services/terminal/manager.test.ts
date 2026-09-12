import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  TerminalManager,
  capHistory,
  createTerminalSpawnEnv,
  historyFileName,
  isRetryableShellSpawnError,
  resolveShellCandidates,
  sanitizeTerminalHistoryChunk,
  terminalWireLabel,
} from "./manager.ts";
import { FakePtyAdapterSync } from "./nodePtyAdapter.ts";
import { PtySpawnError } from "./ptyAdapter.ts";

/** Focused terminal backend tests: t3code Manager behaviors, sessionId-scoped. */
describe("terminal history helpers", () => {
  it("caps history preserving the trailing newline", () => {
    expect(capHistory("a\nb\nc\n", 2)).toBe("b\nc\n");
    expect(capHistory("a\nb\nc", 2)).toBe("b\nc");
    expect(capHistory("", 2)).toBe("");
  });

  it("uses collision-free base64url history names", () => {
    expect(historyFileName("mobile", "term-1")).toBe(
      `terminal_${Buffer.from("mobile").toString("base64url")}.log`,
    );
    expect(historyFileName("a/b", "term-1")).not.toBe(
      historyFileName("a_b", "term-1"),
    );
  });

  it("strips device-query traffic from persisted history only", () => {
    // DSR CPR query + reply-shaped traffic is dropped…
    const q = sanitizeTerminalHistoryChunk("", "prompt \u001b[6n$ ");
    expect(q.visibleText).toBe("prompt $ ");
    expect(q.pendingControlSequence).toBe("");
    // …split sequences held across chunks reassemble…
    const part = sanitizeTerminalHistoryChunk("", "out \u001b[");
    expect(part.visibleText).toBe("out ");
    expect(part.pendingControlSequence).toBe("\u001b[");
    const rest = sanitizeTerminalHistoryChunk(
      part.pendingControlSequence,
      "6n$",
    );
    expect(rest.visibleText).toBe("$");
    // …while ordinary SGR color is preserved.
    const color = sanitizeTerminalHistoryChunk("", "\u001b[31mred\u001b[0m");
    expect(color.visibleText).toBe("\u001b[31mred\u001b[0m");
    // OSC color queries stripped, OSC 8 hyperlinks kept.
    const osc = sanitizeTerminalHistoryChunk("", "\u001b]11;?\u0007kept");
    expect(osc.visibleText).toBe("kept");
    const link = sanitizeTerminalHistoryChunk(
      "",
      "\u001b]8;;https://x.y\u0007T\u001b]8;;\u0007",
    );
    expect(link.visibleText).toContain("https://x.y");
  });
});

describe("terminal spawn env", () => {
  it("blocklists app/electron keys and scrubs AppImage runtime env", () => {
    const env = createTerminalSpawnEnv(
      {
        KEEP: "1",
        PORT: "7070",
        ELECTRON_RUN_AS_NODE: "1",
        T3CODE_FOO: "x",
        VITE_BAR: "y",
        APPIMAGE: "/app",
        APPDIR: "/tmp/.mount_X",
        PATH: "/tmp/.mount_X/usr/bin:/usr/bin",
      },
      { EXTRA: "yes" },
    );
    expect(env.KEEP).toBe("1");
    expect(env.EXTRA).toBe("yes");
    expect(env.PORT).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.T3CODE_FOO).toBeUndefined();
    expect(env.VITE_BAR).toBeUndefined();
    expect(env.APPIMAGE).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("shell candidates", () => {
  it("resolves an ordered fallback list", () => {
    const list = resolveShellCandidates("linux", { SHELL: "/bin/zsh" });
    expect(list.length).toBeGreaterThan(1);
    expect(list[0]).toEqual({ shell: "/bin/zsh", args: ["-o", "nopromptsp"] });
  });

  it("detects retryable spawn errors by message chain", () => {
    const retryable = new PtySpawnError({
      adapter: "node-pty",
      shell: "bash",
      cause: new Error("posix_spawnp failed: ENOENT"),
    });
    expect(isRetryableShellSpawnError(retryable)).toBe(true);
    const fatal = new PtySpawnError({
      adapter: "node-pty",
      shell: "bash",
      cause: new Error("permission denied"),
    });
    expect(isRetryableShellSpawnError(fatal)).toBe(false);
  });
});

describe("terminal wire label", () => {
  it("prefers the running subprocess command", () => {
    expect(
      terminalWireLabel({
        terminalId: "term-1",
        hasRunningSubprocess: false,
        childCommandLabel: null,
      }),
    ).toBe("Terminal 1");
    expect(
      terminalWireLabel({
        terminalId: "term-1",
        hasRunningSubprocess: true,
        childCommandLabel: "vim",
      }),
    ).toBe("vim");
  });
});

describe("TerminalManager lifecycle (fake pty)", () => {
  function setup() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "home-term-"));
    const tm = new TerminalManager(dir, new FakePtyAdapterSync());
    return { dir, tm };
  }

  it("open/write/resize/clear/restart/close round-trip", async () => {
    const { dir, tm } = setup();
    try {
      const snap = await tm.open({
        sessionId: "s",
        terminalId: "term-1",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      });
      expect(snap.status).toBe("running");
      expect(snap.worktreePath).toBeNull();
      await tm.write({ sessionId: "s", terminalId: "term-1", data: "hello\r" });
      await tm.resize({
        sessionId: "s",
        terminalId: "term-1",
        cols: 100,
        rows: 30,
      });
      const listed = tm.list("s");
      expect(listed).toHaveLength(1);
      expect(listed[0]!.terminalId).toBe("term-1");
      await tm.clear({ sessionId: "s", terminalId: "term-1" });
      const restarted = await tm.restart({
        sessionId: "s",
        terminalId: "term-1",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      });
      expect(restarted.status).toBe("running");
      await tm.close({ sessionId: "s", terminalId: "term-1" });
      expect(tm.list("s")).toHaveLength(0);
    } finally {
      await tm.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restart without cwd reuses the stored session cwd", async () => {
    const { dir, tm } = setup();
    try {
      await tm.open({
        sessionId: "s",
        terminalId: "term-1",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      });
      const restarted = await tm.restart({
        sessionId: "s",
        terminalId: "term-1",
        cols: 80,
        rows: 24,
      });
      expect(restarted.status).toBe("running");
      expect(restarted.cwd).toBe(os.tmpdir());
      await expect(
        tm.restart({
          sessionId: "missing",
          terminalId: "term-1",
          cols: 80,
          rows: 24,
        }),
      ).rejects.toThrow();
    } finally {
      await tm.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write to an exited terminal is a silent no-op", async () => {
    const { dir, tm } = setup();
    try {
      await tm.open({
        sessionId: "s",
        terminalId: "term-1",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      });
      await tm.write({ sessionId: "s", terminalId: "term-1", data: "exit\r" });
      await new Promise((r) => setTimeout(r, 50));
      expect(tm.list("s")[0]!.status).toBe("exited");
      await expect(
        tm.write({ sessionId: "s", terminalId: "term-1", data: "lost\r" }),
      ).resolves.toBeUndefined();
    } finally {
      await tm.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes metadata upsert/remove events", async () => {
    const { dir, tm } = setup();
    try {
      const seen: string[] = [];
      const off = tm.subscribeMetadata((ev) => {
        seen.push(ev.type);
      });
      await new Promise((r) => setTimeout(r, 10));
      await tm.open({
        sessionId: "s",
        terminalId: "term-1",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      });
      await tm.close({
        sessionId: "s",
        terminalId: "term-1",
        deleteHistory: true,
      });
      off();
      expect(seen[0]).toBe("snapshot");
      expect(seen).toContain("upsert");
      expect(seen).toContain("remove");
    } finally {
      await tm.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown sessions and bad cwds with coded errors", async () => {
    const { dir, tm } = setup();
    try {
      await expect(
        tm.write({ sessionId: "nope", terminalId: "term-1", data: "x" }),
      ).rejects.toThrow();
      await expect(
        tm.open({
          sessionId: "s",
          terminalId: "term-1",
          cwd: path.join(dir, "missing"),
          cols: 80,
          rows: 24,
        }),
      ).rejects.toThrow();
    } finally {
      await tm.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
