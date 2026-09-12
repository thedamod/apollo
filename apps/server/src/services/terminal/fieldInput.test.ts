import { describe, expect, it } from "vitest";
import { diffFieldText } from "@home-server/shared/fieldInput";

/**
 * Hidden-field diffing: every keystroke must forward exactly its own input —
 * never resends, never phantom DELs. Runs under the server vitest (the
 * helper is pure TypeScript with zero RN imports; the screen in
 * `apps/mobile/src/screens/Terminal.tsx` applies the identical protocol).
 */
describe("diffFieldText", () => {
  it("forwards a single typed char", () => {
    expect(diffFieldText(" ", " x")).toEqual({ inserted: "x", deletes: 0 });
  });

  it("forwards batched/pasted text whole, not per char", () => {
    expect(diffFieldText(" ", " hello")).toEqual({
      inserted: "hello",
      deletes: 0,
    });
  });

  it("maps a lone backspace on the sentinel to one DEL", () => {
    expect(diffFieldText(" ", "")).toEqual({ inserted: "", deletes: 1 });
  });

  it("does not bill the unsent sentinel on wipes down to empty", () => {
    // " xy" holds two forwarded chars plus the never-sent sentinel: wiping
    // to "" deletes two, not three.
    expect(diffFieldText(" xy", "")).toEqual({ inserted: "", deletes: 2 });
  });

  it("bills every char when no sentinel prefix is present", () => {
    // Accumulated/foreign state with no reset sentinel: all five go.
    expect(diffFieldText("hello", "")).toEqual({ inserted: "", deletes: 5 });
  });

  it("maps coalesced rapid backspaces to one DEL per removed char", () => {
    expect(diffFieldText(" abc", " ")).toEqual({ inserted: "", deletes: 3 });
  });

  it("handles mid-field cursor placement without resending", () => {
    // field " xy", user moves cursor before y and types z -> " xzy"
    expect(diffFieldText(" xy", " xzy")).toEqual({
      inserted: "z",
      deletes: 0,
    });
  });

  it("reports substitutions as the inserted text (insert wins, t3code parity)", () => {
    expect(diffFieldText(" x", " y")).toEqual({ inserted: "y", deletes: 0 });
  });
});

describe("echo-counter protocol (screen-side rule)", () => {
  const SENTINEL = " ";

  /**
   * Faithful simulator of the screen's handleFieldChange bookkeeping:
   * returns the list of payloads forwarded to the pty ("x" chars / "DEL").
   */
  function simulate(events: string[]): string[] {
    let last = SENTINEL;
    let pendingEchoes = 0;
    const sent: string[] = [];
    for (const next of events) {
      if (next === last) continue; // duplicate event
      if (next === SENTINEL) {
        last = next;
        if (pendingEchoes > 0) {
          pendingEchoes -= 1;
          continue; // reset echo
        }
        for (let i = 0; i < last.length - next.length; i++) sent.push("DEL");
        continue;
      }
      const edit = diffFieldText(last, next);
      last = next;
      if (edit.inserted) {
        sent.push(edit.inserted);
      } else if (edit.deletes > 0) {
        for (let i = 0; i < edit.deletes; i++) sent.push("DEL");
      }
      pendingEchoes += 1; // clearField
    }
    return sent;
  }

  it("fast typing sends each char once and swallows both echoes", () => {
    // " x" (send x, clear#1), " xy" (send y, clear#2), echo, echo
    expect(simulate([" x", " xy", SENTINEL, SENTINEL])).toEqual(["x", "y"]);
  });

  it("a stale echo arriving after more typing sends no phantom DELs", () => {
    // Both echoes arrive late, after last advanced to " xy".
    expect(simulate([" x", " xy", SENTINEL, SENTINEL])).toEqual(["x", "y"]);
  });

  it("lone backspace on the sentinel sends exactly one DEL", () => {
    expect(simulate([""])).toEqual(["DEL"]);
  });

  it("a second echo for the same reset is a duplicate no-op", () => {
    // No-op programmatic resets may or may not echo; a repeated bare
    // sentinel with last already at the sentinel sends nothing.
    expect(simulate([" x", SENTINEL, SENTINEL])).toEqual(["x"]);
  });

  it("backspaces keep working when echoes never arrive (no-echo keyboards)", () => {
    // iOS-style: setNativeProps never echoes, so every event is user input.
    expect(simulate([" x", " xy", " x", ""])).toEqual(["x", "y", "DEL", "DEL"]);
  });

  it("insert after an echo does not resend the echo", () => {
    expect(simulate([" x", SENTINEL, " y"])).toEqual(["x", "y"]);
  });
});
