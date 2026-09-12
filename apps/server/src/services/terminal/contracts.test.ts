import { describe, expect, it } from "vitest";
import {
  TerminalOpenInput,
  TerminalAttachInput,
  TerminalWriteInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalCloseInput,
  TerminalSessionSnapshot,
  TerminalSummary,
  TerminalMetadataStreamEvent,
  TerminalAttachStreamEvent,
} from "@home-server/contracts";

/**
 * Terminal wire-contract parity with t3code
 * (`context/t3code/packages/contracts/src/terminal.test.ts` adapted to zod
 * + the sessionId scoping rename).
 */
describe("terminal contracts", () => {
  it("requires an explicit client-chosen terminalId (no server allocation)", () => {
    expect(() =>
      TerminalOpenInput.parse({ sessionId: "s", cwd: "/tmp" }),
    ).toThrow();
    expect(() => TerminalAttachInput.parse({ sessionId: "s" })).toThrow();
    const open = TerminalOpenInput.parse({
      sessionId: "s",
      terminalId: "term-1",
      cwd: "/tmp",
    });
    expect(open.terminalId).toBe("term-1");
  });

  it("trims ids and enforces terminalId max length", () => {
    const open = TerminalOpenInput.parse({
      sessionId: "  s1  ",
      terminalId: "  term-2  ",
      cwd: " /tmp ",
    });
    expect(open.sessionId).toBe("s1");
    expect(open.terminalId).toBe("term-2");
    expect(open.cwd).toBe("/tmp");
    expect(() =>
      TerminalOpenInput.parse({
        sessionId: "s",
        terminalId: "x".repeat(129),
        cwd: "/tmp",
      }),
    ).toThrow();
    expect(() =>
      TerminalOpenInput.parse({
        sessionId: "   ",
        terminalId: "term-1",
        cwd: "/tmp",
      }),
    ).toThrow();
  });

  it("leaves cols/rows optional on open/attach (server defaults apply)", () => {
    const open = TerminalOpenInput.parse({
      sessionId: "s",
      terminalId: "term-1",
      cwd: "/tmp",
    });
    expect(open.cols).toBeUndefined();
    expect(open.rows).toBeUndefined();
    const attach = TerminalAttachInput.parse({
      sessionId: "s",
      terminalId: "term-1",
    });
    expect(attach.cols).toBeUndefined();
  });

  it("validates env keys/values like t3code", () => {
    const ok = TerminalOpenInput.parse({
      sessionId: "s",
      terminalId: "term-1",
      cwd: "/tmp",
      env: { FOO: "bar" },
    });
    expect(ok.env).toEqual({ FOO: "bar" });
    expect(() =>
      TerminalOpenInput.parse({
        sessionId: "s",
        terminalId: "term-1",
        cwd: "/tmp",
        env: { "bad-key": "x" },
      }),
    ).toThrow();
    expect(() =>
      TerminalOpenInput.parse({
        sessionId: "s",
        terminalId: "term-1",
        cwd: "/tmp",
        env: { FOO: "x".repeat(8193) },
      }),
    ).toThrow();
  });

  it("accepts attach cwd/env for server-side restart", () => {
    const attach = TerminalAttachInput.parse({
      sessionId: "s",
      terminalId: "term-1",
      cwd: "/tmp",
      cols: 100,
      restartIfNotRunning: true,
    });
    expect(attach.cwd).toBe("/tmp");
    expect(attach.restartIfNotRunning).toBe(true);
  });

  it("accepts t3code worktreePath payloads for wire-compat", () => {
    const snap = TerminalSessionSnapshot.parse({
      sessionId: "s",
      terminalId: "term-1",
      cwd: "/tmp",
      worktreePath: null,
      status: "running",
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      label: "Terminal 1",
      updatedAt: new Date().toISOString(),
      cols: 120,
      rows: 30,
    });
    expect(snap.worktreePath).toBeNull();
  });

  it("supports the metadata list/subscribe channel", () => {
    const summary = TerminalSummary.parse({
      sessionId: "s",
      terminalId: "term-1",
      cwd: "/tmp",
      worktreePath: null,
      status: "running",
      pid: 1,
      exitCode: null,
      exitSignal: null,
      hasRunningSubprocess: false,
      label: "Terminal 1",
      updatedAt: new Date().toISOString(),
    });
    expect(
      TerminalMetadataStreamEvent.parse({
        type: "snapshot",
        terminals: [summary],
      }).type,
    ).toBe("snapshot");
    expect(
      TerminalMetadataStreamEvent.parse({ type: "upsert", terminal: summary })
        .type,
    ).toBe("upsert");
    expect(
      TerminalMetadataStreamEvent.parse({
        type: "remove",
        sessionId: "s",
        terminalId: "term-1",
      }).type,
    ).toBe("remove");
  });

  it("attach stream excludes started (server converts to snapshot)", () => {
    const snapshot = TerminalSessionSnapshot.parse({
      sessionId: "s",
      terminalId: "term-1",
      cwd: "/tmp",
      worktreePath: null,
      status: "running",
      pid: 1,
      history: "hi",
      exitCode: null,
      exitSignal: null,
      label: "Terminal 1",
      updatedAt: new Date().toISOString(),
      cols: 80,
      rows: 24,
    });
    expect(
      TerminalAttachStreamEvent.parse({ type: "snapshot", snapshot }).type,
    ).toBe("snapshot");
  });

  it("restart accepts a missing cwd (server reuses the stored one)", () => {
    const restart = TerminalRestartInput.parse({
      sessionId: "s",
      terminalId: "term-1",
      cols: 80,
      rows: 24,
    });
    expect(restart.cwd).toBeUndefined();
    expect(
      TerminalRestartInput.parse({
        sessionId: "s",
        terminalId: "term-1",
        cwd: "/tmp",
        cols: 80,
        rows: 24,
      }).cwd,
    ).toBe("/tmp");
  });

  it("rejects oversize writes and bad dims", () => {
    expect(() =>
      TerminalWriteInput.parse({ sessionId: "s", terminalId: "t", data: "" }),
    ).toThrow();
    expect(() =>
      TerminalWriteInput.parse({
        sessionId: "s",
        terminalId: "t",
        data: "x".repeat(65537),
      }),
    ).toThrow();
    expect(() =>
      TerminalResizeInput.parse({
        sessionId: "s",
        terminalId: "t",
        cols: 0,
        rows: 24,
      }),
    ).toThrow();
    expect(
      TerminalCloseInput.parse({ sessionId: "s" }).terminalId,
    ).toBeUndefined();
  });
});
