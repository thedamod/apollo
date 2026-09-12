import { describe, expect, it } from "vitest";
import {
  VtParser,
  type VtCell,
  type VtLine,
} from "../../../../mobile/src/features/terminal/vtParser.js";

/**
 * VT parser device-query + erase behavior. The mobile surface answers DSR/DA
 * from parser state, so the answers must match what a real terminal reports
 * (fzf-tab completion reads CPR to position its UI; a wrong row wedges the
 * shell, and stray answers leak into vi-mode shells as mode-flipping input).
 * Runs under the server vitest — vtParser is pure TypeScript, zero RN deps.
 */
describe("vtParser device queries", () => {
  it("answers DSR 5 with OK", () => {
    const p = new VtParser(80);
    p.feed("hi\u001b[5n");
    expect(p.takeReplies()).toEqual(["\u001b[0n"]);
    expect(p.takeReplies()).toEqual([]);
  });

  it("answers CPR with the live cursor position", () => {
    const p = new VtParser(80);
    p.feed("hello");
    p.feed("\u001b[6n");
    expect(p.takeReplies()).toEqual(["\u001b[1;6R"]);
  });

  it("reports the CPR row viewport-relative once scrolled", () => {
    const p = new VtParser(80);
    p.setViewportRows(24);
    for (let i = 0; i < 30; i++) p.feed(`line${i}\r\n`);
    // 31 lines in a 24-row viewport, cursor on the last line -> row 24.
    p.feed("\u001b[6n");
    expect(p.takeReplies()).toEqual(["\u001b[24;1R"]);
  });

  it("answers DA with a VT220 id", () => {
    const p = new VtParser(80);
    p.feed("\u001b[c");
    expect(p.takeReplies()).toEqual(["\u001b[?62c"]);
  });

  it("never answers queries replayed from a snapshot", () => {
    const p = new VtParser(80);
    // A stale query stored in history must not be answered into the live
    // shell on re-attach (t3code detaches the reply callback on restore).
    p.feedSnapshot("stale prompt \u001b[6n$ ");
    expect(p.takeReplies()).toEqual([]);
  });
});

describe("vtParser erase display", () => {
  it("ED 0 clears through the end of the screen, not just the row", () => {
    const p = new VtParser(80);
    p.feed("one\r\ntwo\r\nthree");
    p.feed("[1;1H[J");
    const text = p.lines
      .map((l: VtLine) =>
        l
          .filter((c: VtCell) => c.w !== 0)
          .map((c: VtCell) => c.ch)
          .join(""),
      )
      .join("\n");
    expect(text.trim()).toBe("");
  });
});
