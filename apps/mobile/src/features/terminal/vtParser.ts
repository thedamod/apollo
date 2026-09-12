/**
 * Minimal VT (ANSI escape) parser + screen grid — the rendering engine behind
 * the terminal surface.
 *
 * t3code renders through a native Ghostty view. This app ships under Expo Go
 * (no native modules), so this parser gives the text surface equivalent
 * visual semantics for everyday shell output AND full-screen TUIs: SGR colors
 * (16/256/truecolor), bold, faint, dim, italic, underline, overline,
 * inverse, invisible, strike, cursor movement/styles/visibility, erase,
 * scrolling regions, alt-screen, wide (double-cell) unicode characters,
 * OSC 8 hyperlinks, and device-query replies (DSR/DA) queued for the screen
 * to write back to the PTY. Unknown sequences are skipped gracefully so raw
 * escapes never leak onto the screen.
 */
export type VtColorSpec =
  | { readonly kind: "palette"; readonly index: number }
  | {
      readonly kind: "rgb";
      readonly r: number;
      readonly g: number;
      readonly b: number;
    };

export interface VtAttrs {
  fg: VtColorSpec | null;
  bg: VtColorSpec | null;
  bold: boolean;
  faint: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  overline: boolean;
  strike: boolean;
  inverse: boolean;
  invisible: boolean;
}

export interface VtCell {
  /** grapheme; `""` with w:0 marks the trailing half of a wide char. */
  ch: string;
  /** cell width: 1, 2 (wide char lead), or 0 (wide char trail). */
  w: number;
  attrs: VtAttrs;
  /** OSC 8 hyperlink target attached to this cell, if any. */
  link?: string | null;
}

export type VtLine = VtCell[];

export type VtCursorStyle = "block" | "underline" | "bar";

export const MAX_VT_SCROLLBACK_LINES = 1000;

const DEFAULT_ATTRS: VtAttrs = {
  fg: null,
  bg: null,
  bold: false,
  faint: false,
  dim: false,
  italic: false,
  underline: false,
  overline: false,
  strike: false,
  inverse: false,
  invisible: false,
};

function blankCell(): VtCell {
  return { ch: " ", w: 1, attrs: { ...DEFAULT_ATTRS } };
}

function cloneAttrs(attrs: VtAttrs): VtAttrs {
  return { ...attrs };
}

/** Approximate wcwidth: 2 for East-Asian wide/fullwidth + emoji blocks. */
export function charCellWidth(codePoint: number): number {
  if (codePoint < 0x1100) return 1;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe52) ||
    (codePoint >= 0xfe54 && codePoint <= 0xfe66) ||
    (codePoint >= 0xfe68 && codePoint <= 0xfe6b) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

type ParserState =
  | "ground"
  | "esc"
  | "csi"
  | "osc"
  | "oscEsc"
  | "dcs"
  | "dcsEsc"
  | "sosPmApc"
  | "sosPmApcEsc"
  | "charset";

export class VtParser {
  cols: number;
  lines: VtLine[] = [];
  cursorX = 0;
  cursorY = 0;
  cursorVisible = true;
  cursorStyle: VtCursorStyle = "block";
  cursorBlink = false;
  /** Bracketed-paste mode (?2004) — the screen wraps pastes in ESC[200~…~. */
  bracketedPaste = false;
  /** Mouse-tracking mode (?1000/1002/1006…) — tracked, taps still focus. */
  mouseMode = false;

  private attrs: VtAttrs = { ...DEFAULT_ATTRS };
  private state: ParserState = "ground";
  private csiParam = "";
  private csiPrivate = "";
  private csiIntermediate = "";
  private oscBuffer = "";
  private currentLink: string | null = null;
  private savedX = 0;
  private savedY = 0;
  private savedAttrs: VtAttrs = { ...DEFAULT_ATTRS };
  /** Scroll region (DECSTBM), 0-based inclusive. null = full screen. */
  private scrollTop: number | null = null;
  private scrollBottom: number | null = null;
  /** Visible viewport rows for cursor reports (set by the screen from layout).
   * A real terminal reports CPR rows within the viewport, not counting
   * scrollback — without this, answers drift once lines scroll off. */
  private viewportRows: number | null = null;
  /** True while replaying a snapshot: device-query replies generated here
   * belong to dead output and must never be written into the live shell
   * (t3code detaches the PTY reply callback on scrollback restore). */
  private replaying = false;
  /** Alt-screen stash for ?1049/?1047/?47. */
  private altActive = false;
  private altLines: VtLine[] = [];
  private altX = 0;
  private altY = 0;
  /** Device-query replies (DSR/DA) for the screen to write back to the PTY. */
  private replies: string[] = [];

  constructor(cols: number) {
    this.cols = Math.max(1, Math.floor(cols));
    this.ensureLine(0);
  }

  reset(): void {
    this.lines = [];
    this.cursorX = 0;
    this.cursorY = 0;
    this.cursorVisible = true;
    this.cursorStyle = "block";
    this.cursorBlink = false;
    this.bracketedPaste = false;
    this.mouseMode = false;
    this.attrs = { ...DEFAULT_ATTRS };
    this.state = "ground";
    this.csiParam = "";
    this.csiPrivate = "";
    this.csiIntermediate = "";
    this.oscBuffer = "";
    this.currentLink = null;
    this.savedX = 0;
    this.savedY = 0;
    this.savedAttrs = { ...DEFAULT_ATTRS };
    this.scrollTop = null;
    this.scrollBottom = null;
    this.altActive = false;
    this.altLines = [];
    this.altX = 0;
    this.altY = 0;
    this.ensureLine(0);
  }

  setCols(cols: number): void {
    const next = Math.max(1, Math.floor(cols));
    if (next !== this.cols) {
      this.cols = next;
      // Ghostty resets the scroll region on resize.
      this.scrollTop = null;
      this.scrollBottom = null;
    }
  }

  /** Viewport height in rows, for viewport-relative cursor reports (CPR). */
  setViewportRows(rows: number): void {
    this.viewportRows = Math.max(1, Math.floor(rows));
  }

  /** Drain queued device-query replies (DSR/DA) to write back to the PTY. */
  takeReplies(): string[] {
    if (this.replies.length === 0) return [];
    const out = this.replies;
    this.replies = [];
    return out;
  }

  /**
   * CPR answer with the cursor row relative to the visible viewport, like a
   * real terminal (scrollback above the viewport is not counted). The surface
   * pins to the bottom, so the row is measured up from the last line.
   */
  cursorPositionReport(): string {
    const col = Math.max(1, Math.min(this.cols, this.cursorX + 1));
    let row = this.cursorY + 1;
    if (this.viewportRows !== null && this.lines.length > this.viewportRows) {
      row = this.cursorY - (this.lines.length - this.viewportRows) + 1;
    }
    row = Math.max(1, row);
    if (this.viewportRows !== null) row = Math.min(this.viewportRows, row);
    return `\u001b[${row};${col}R`;
  }

  feedSnapshot(text: string): void {
    this.reset();
    this.replaying = true;
    try {
      this.feed(text);
    } finally {
      this.replaying = false;
    }
  }

  feed(chunk: string): void {
    for (const ch of chunk) {
      this.step(ch);
    }
    this.trimScrollback();
  }

  private ensureLine(y: number): void {
    while (this.lines.length <= y) {
      this.lines.push([]);
    }
  }

  private trimScrollback(): void {
    if (this.lines.length > MAX_VT_SCROLLBACK_LINES) {
      const drop = this.lines.length - MAX_VT_SCROLLBACK_LINES;
      this.lines.splice(0, drop);
      this.cursorY = Math.max(0, this.cursorY - drop);
      this.savedY = Math.max(0, this.savedY - drop);
    }
  }

  private inRegion(): boolean {
    return (
      this.scrollTop !== null &&
      this.scrollBottom !== null &&
      this.scrollBottom > this.scrollTop
    );
  }

  private newline(): void {
    if (this.inRegion() && this.cursorY >= (this.scrollBottom as number)) {
      // Scroll up within the region.
      this.lines.splice(this.scrollTop as number, 1);
      this.lines.splice(this.scrollBottom as number, 0, []);
      this.ensureLine(this.scrollBottom as number);
      this.cursorX = 0;
      return;
    }
    this.cursorX = 0;
    this.cursorY += 1;
    this.ensureLine(this.cursorY);
  }

  private reverseIndex(): void {
    if (this.inRegion() && this.cursorY <= (this.scrollTop as number)) {
      this.lines.splice((this.scrollBottom as number) + 1, 0, []);
      this.lines.splice(this.scrollTop as number, 1);
      this.ensureLine(this.cursorY);
      return;
    }
    this.cursorY = Math.max(0, this.cursorY - 1);
  }

  private putChar(ch: string, width: number): void {
    if (this.cursorX + width > this.cols) {
      this.newline();
    }
    this.ensureLine(this.cursorY);
    const line = this.lines[this.cursorY];
    while (line.length < this.cursorX) {
      line.push(blankCell());
    }
    const cell: VtCell = { ch, w: width, attrs: cloneAttrs(this.attrs) };
    if (this.currentLink) cell.link = this.currentLink;
    line[this.cursorX] = cell;
    if (width === 2) {
      const trail: VtCell = { ch: "", w: 0, attrs: cloneAttrs(this.attrs) };
      if (this.currentLink) trail.link = this.currentLink;
      line[this.cursorX + 1] = trail;
    }
    this.cursorX += width;
  }

  private eraseCells(line: VtLine, from: number, to: number): void {
    const end = Math.min(to, this.cols);
    for (let i = Math.max(0, from); i < end; i++) {
      line[i] = blankCell();
    }
  }

  private currentLine(): VtLine {
    this.ensureLine(this.cursorY);
    return this.lines[this.cursorY];
  }

  private enterAltScreen(): void {
    if (this.altActive) return;
    this.altActive = true;
    this.altLines = this.lines;
    this.altX = this.cursorX;
    this.altY = this.cursorY;
    this.lines = [];
    this.cursorX = 0;
    this.cursorY = 0;
    this.ensureLine(0);
  }

  private exitAltScreen(): void {
    if (!this.altActive) return;
    this.altActive = false;
    this.lines = this.altLines;
    this.altLines = [];
    this.cursorX = this.altX;
    this.cursorY = this.altY;
    this.ensureLine(this.cursorY);
  }

  private step(ch: string): void {
    const code = ch.codePointAt(0) ?? 0;

    switch (this.state) {
      case "ground":
        this.stepGround(ch, code);
        return;
      case "esc":
        this.stepEsc(ch);
        return;
      case "csi":
        this.stepCsi(ch, code);
        return;
      case "osc":
        if (ch === "\u0007") {
          this.finishOsc();
        } else if (ch === "\u001b") {
          this.state = "oscEsc";
        } else {
          this.oscBuffer += ch;
        }
        return;
      case "oscEsc":
        // Only "\\" terminates; anything else returns to OSC content.
        if (ch === "\\") this.finishOsc();
        else {
          this.oscBuffer += "\u001b" + ch;
          this.state = "osc";
        }
        return;
      case "dcs":
        if (ch === "\u001b") this.state = "dcsEsc";
        return;
      case "dcsEsc":
        this.state = ch === "\\" ? "ground" : "dcs";
        return;
      case "sosPmApc":
        if (ch === "\u001b") this.state = "sosPmApcEsc";
        return;
      case "sosPmApcEsc":
        this.state = ch === "\\" ? "ground" : "sosPmApc";
        return;
      case "charset":
        // Single-char charset designator — consumed and ignored.
        this.state = "ground";
        return;
    }
  }

  private finishOsc(): void {
    this.handleOsc(this.oscBuffer);
    this.oscBuffer = "";
    this.state = "ground";
  }

  private handleOsc(content: string): void {
    // OSC 8 hyperlinks: "8;params;URI" opens, "8;;" (empty URI) closes.
    if (content.startsWith("8;")) {
      const rest = content.slice(2);
      const sep = rest.indexOf(";");
      const uri = sep >= 0 ? rest.slice(sep + 1) : "";
      this.currentLink = uri.length > 0 ? uri : null;
    }
    // All other OSC (window title, clipboard, color queries…) is consumed
    // and discarded — never rendered.
  }

  private stepGround(ch: string, code: number): void {
    if (ch === "\u001b") {
      this.state = "esc";
      return;
    }
    if (ch === "\u009b") {
      this.beginCsi();
      return;
    }
    if (ch === "\u009d") {
      this.state = "osc";
      this.oscBuffer = "";
      return;
    }
    if (ch === "\u0090") {
      this.state = "dcs";
      return;
    }
    if (ch === "\u0098" || ch === "\u009e" || ch === "\u009f") {
      this.state = "sosPmApc";
      return;
    }
    if (code < 0x20) {
      switch (ch) {
        case "\u0007": // BEL
        case "\u0000": // NUL
        case "\u000e": // SO
        case "\u000f": // SI
        case "\u007f": // DEL
          return;
        case "\b":
          this.cursorX = Math.max(0, this.cursorX - 1);
          return;
        case "\t": {
          const next = this.cursorX + 1;
          this.cursorX = Math.min(this.cols, next + ((8 - (next % 8)) % 8));
          return;
        }
        case "\n":
        case "\u000b": // VT
        case "\u000c": // FF
          this.newline();
          return;
        case "\r":
          this.cursorX = 0;
          return;
        default:
          return;
      }
    }
    this.putChar(ch, charCellWidth(code));
  }

  private beginCsi(): void {
    this.state = "csi";
    this.csiParam = "";
    this.csiPrivate = "";
    this.csiIntermediate = "";
  }

  private stepEsc(ch: string): void {
    switch (ch) {
      case "[":
        this.beginCsi();
        return;
      case "]":
        this.state = "osc";
        this.oscBuffer = "";
        return;
      case "P":
        this.state = "dcs";
        return;
      case "X":
      case "^":
      case "_":
        this.state = "sosPmApc";
        return;
      case "(":
      case ")":
      case "*":
      case "+":
        this.state = "charset";
        return;
      case "M": // reverse index
        this.reverseIndex();
        break;
      case "E": // next line
        this.newline();
        break;
      case "D": {
        // index — move down, keep column (scrolls region at its bottom).
        const col = this.cursorX;
        this.newline();
        this.cursorX = col;
        break;
      }
      case "c": // full reset
        this.reset();
        return;
      case "7": // save cursor
        this.savedX = this.cursorX;
        this.savedY = this.cursorY;
        this.savedAttrs = cloneAttrs(this.attrs);
        break;
      case "8": // restore cursor
        this.cursorX = this.savedX;
        this.cursorY = this.savedY;
        this.ensureLine(this.cursorY);
        break;
      default:
        // "=", ">", "H", "Z", "\\" and friends — ignored.
        break;
    }
    this.state = "ground";
  }

  private stepCsi(ch: string, code: number): void {
    if (ch === "?" || ch === ">" || ch === "=" || ch === "!") {
      if (this.csiParam.length === 0 && this.csiIntermediate.length === 0) {
        this.csiPrivate = ch;
      }
      return;
    }
    if (code >= 0x30 && code <= 0x3f) {
      this.csiParam += ch;
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.csiIntermediate += ch;
      return;
    }
    if (code >= 0x40 && code <= 0x7e) {
      this.dispatchCsi(ch);
      this.state = "ground";
      return;
    }
    // Anything else aborts the sequence.
    this.state = "ground";
  }

  private csiParams(): number[] {
    if (this.csiParam.length === 0) return [];
    return this.csiParam.split(";").map((part) => {
      if (part.length === 0) return 0;
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
  }

  private dispatchCsi(final: string): void {
    // Cursor-style (DECSCUSR): CSI Ps SP q.
    if (final === "q" && this.csiIntermediate === " ") {
      const mode = this.csiParams()[0] ?? 0;
      switch (mode) {
        case 0:
        case 1:
          this.cursorStyle = "block";
          this.cursorBlink = true;
          break;
        case 2:
          this.cursorStyle = "block";
          this.cursorBlink = false;
          break;
        case 3:
          this.cursorStyle = "underline";
          this.cursorBlink = true;
          break;
        case 4:
          this.cursorStyle = "underline";
          this.cursorBlink = false;
          break;
        case 5:
          this.cursorStyle = "bar";
          this.cursorBlink = true;
          break;
        case 6:
          this.cursorStyle = "bar";
          this.cursorBlink = false;
          break;
        default:
          break;
      }
      return;
    }
    // DEC private modes (?…h / ?…l).
    if (this.csiPrivate === "?" && (final === "h" || final === "l")) {
      this.dispatchPrivateMode(final === "h");
      return;
    }
    if (this.csiPrivate.length > 0 || this.csiIntermediate.length > 0) {
      if (final === "s") {
        this.savedX = this.cursorX;
        this.savedY = this.cursorY;
        this.savedAttrs = cloneAttrs(this.attrs);
      } else if (final === "u") {
        this.cursorX = this.savedX;
        this.cursorY = this.savedY;
        this.ensureLine(this.cursorY);
      }
      return;
    }
    const p = this.csiParams();
    const rep = (index: number, fallback: number) => {
      const v = p[index] ?? 0;
      return v <= 0 ? fallback : v;
    };

    switch (final) {
      case "A":
        this.cursorY = Math.max(0, this.cursorY - rep(0, 1));
        break;
      case "B":
        this.cursorY += rep(0, 1);
        this.ensureLine(this.cursorY);
        break;
      case "C":
        this.cursorX = Math.min(this.cols, this.cursorX + rep(0, 1));
        break;
      case "D":
        this.cursorX = Math.max(0, this.cursorX - rep(0, 1));
        break;
      case "E":
        this.cursorY += rep(0, 1);
        this.cursorX = 0;
        this.ensureLine(this.cursorY);
        break;
      case "F":
        this.cursorY = Math.max(0, this.cursorY - rep(0, 1));
        this.cursorX = 0;
        break;
      case "G":
      case "`":
        this.cursorX = Math.max(0, Math.min(this.cols - 1, rep(0, 1) - 1));
        break;
      case "d":
        this.cursorY = Math.max(0, rep(0, 1) - 1);
        this.ensureLine(this.cursorY);
        break;
      case "H":
      case "f":
        this.cursorY = Math.max(0, rep(0, 1) - 1);
        this.cursorX = Math.max(0, Math.min(this.cols - 1, rep(1, 1) - 1));
        this.ensureLine(this.cursorY);
        break;
      case "J": {
        const mode = p[0] ?? 0;
        if (mode === 2 || mode === 3) {
          this.lines = [];
          this.cursorX = 0;
          this.cursorY = 0;
          this.scrollTop = null;
          this.scrollBottom = null;
          this.ensureLine(0);
        } else if (mode === 1) {
          // Erase from start of screen through the cursor.
          for (let y = 0; y < this.cursorY; y++) {
            this.eraseCells(this.lines[y] ?? [], 0, this.cols);
          }
          this.eraseCells(this.currentLine(), 0, this.cursorX + 1);
        } else {
          // Erase from the cursor through the end of the screen (all lines
          // below too — fzf-style TUIs rely on this, not just the row).
          this.eraseCells(this.currentLine(), this.cursorX, this.cols);
          for (let y = this.cursorY + 1; y < this.lines.length; y++) {
            this.eraseCells(this.lines[y] ?? [], 0, this.cols);
          }
        }
        break;
      }
      case "K": {
        const mode = p[0] ?? 0;
        const line = this.currentLine();
        if (mode === 2) {
          this.eraseCells(line, 0, this.cols);
        } else if (mode === 1) {
          this.eraseCells(line, 0, this.cursorX + 1);
        } else {
          this.eraseCells(line, this.cursorX, this.cols);
        }
        break;
      }
      case "X": {
        const line = this.currentLine();
        this.eraseCells(line, this.cursorX, this.cursorX + rep(0, 1));
        break;
      }
      case "P": {
        const line = this.currentLine();
        line.splice(this.cursorX, rep(0, 1));
        break;
      }
      case "@": {
        const line = this.currentLine();
        line.splice(
          this.cursorX,
          0,
          ...Array.from({ length: rep(0, 1) }, blankCell),
        );
        break;
      }
      case "L": {
        const count = rep(0, 1);
        const blanks: VtLine[] = Array.from({ length: count }, () => []);
        this.lines.splice(this.cursorY, 0, ...blanks);
        break;
      }
      case "M": {
        this.lines.splice(this.cursorY, rep(0, 1));
        this.ensureLine(this.cursorY);
        break;
      }
      case "S":
        for (let i = 0; i < rep(0, 1); i++) this.newline();
        break;
      case "T":
        this.lines.splice(
          this.cursorY,
          0,
          ...Array.from({ length: rep(0, 1) }, () => [] as VtLine),
        );
        break;
      case "r": {
        // DECSTBM scroll region (1-based top;bottom, defaults full).
        const top = p[0] ?? 0;
        const bottom = p[1] ?? 0;
        if (top <= 0 && bottom <= 0) {
          this.scrollTop = null;
          this.scrollBottom = null;
        } else {
          this.scrollTop = Math.max(0, top - 1);
          this.scrollBottom = bottom > 0 ? bottom - 1 : 9999;
          this.cursorX = 0;
          this.cursorY = this.scrollTop;
          this.ensureLine(this.cursorY);
        }
        break;
      }
      case "s":
        this.savedX = this.cursorX;
        this.savedY = this.cursorY;
        this.savedAttrs = cloneAttrs(this.attrs);
        break;
      case "u":
        this.cursorX = this.savedX;
        this.cursorY = this.savedY;
        this.ensureLine(this.cursorY);
        break;
      case "n":
        // DSR device-status reports — queue the reply for write-back.
        // Skipped while replaying a snapshot: those answers belong to dead
        // output and would leak into the live shell as stray input (which
        // flips vi-mode shells into normal mode and wedges editing).
        if (this.replaying) break;
        if (p[0] === 5) this.replies.push("\u001b[0n");
        else if (p[0] === 6) this.replies.push(this.cursorPositionReport());
        break;
      case "c":
        // DA device-attributes query — answer minimal VT220 id.
        if (!this.replaying && (this.csiParam === "" || this.csiParam === "0"))
          this.replies.push("\u001b[?62c");
        break;
      case "m":
        this.applySgr(p);
        break;
      default:
        // "h", "l", "g", "t", … — ignored.
        break;
    }
  }

  private dispatchPrivateMode(set: boolean): void {
    const params = this.csiParam.split(";").map((s) => Number.parseInt(s, 10));
    for (const mode of params) {
      if (!Number.isFinite(mode)) continue;
      switch (mode) {
        case 1: // DECCKM — tracked, no behavior change
          break;
        case 7: // DECAWM autowrap — always on here
          break;
        case 25:
          this.cursorVisible = set;
          break;
        case 47:
        case 1047:
          if (set) this.enterAltScreen();
          else this.exitAltScreen();
          break;
        case 1048:
          if (set) {
            this.savedX = this.cursorX;
            this.savedY = this.cursorY;
            this.savedAttrs = cloneAttrs(this.attrs);
          } else {
            this.cursorX = this.savedX;
            this.cursorY = this.savedY;
            this.ensureLine(this.cursorY);
          }
          break;
        case 1049:
          if (set) {
            this.savedX = this.cursorX;
            this.savedY = this.cursorY;
            this.savedAttrs = cloneAttrs(this.attrs);
            this.enterAltScreen();
            this.lines = [];
            this.cursorX = 0;
            this.cursorY = 0;
            this.ensureLine(0);
          } else {
            this.exitAltScreen();
            this.cursorX = this.savedX;
            this.cursorY = this.savedY;
            this.ensureLine(this.cursorY);
          }
          break;
        case 1000:
        case 1001:
        case 1002:
        case 1003:
        case 1005:
        case 1006:
          // Mouse tracking — tracked only; taps still focus the input.
          this.mouseMode = set;
          break;
        case 2004:
          this.bracketedPaste = set;
          break;
        default:
          break;
      }
    }
  }

  private applySgr(params: number[]): void {
    if (params.length === 0) {
      this.attrs = { ...DEFAULT_ATTRS };
      return;
    }
    let i = 0;
    while (i < params.length) {
      const n = params[i];
      switch (n) {
        case 0:
          this.attrs = { ...DEFAULT_ATTRS };
          break;
        case 1:
          this.attrs.bold = true;
          break;
        case 2:
          this.attrs.faint = true;
          this.attrs.dim = true;
          break;
        case 3:
          this.attrs.italic = true;
          break;
        case 4:
        case 21:
          this.attrs.underline = true;
          break;
        case 7:
          this.attrs.inverse = true;
          break;
        case 8:
          this.attrs.invisible = true;
          break;
        case 9:
          this.attrs.strike = true;
          break;
        case 53:
          this.attrs.overline = true;
          break;
        case 22:
          this.attrs.bold = false;
          this.attrs.faint = false;
          this.attrs.dim = false;
          break;
        case 23:
          this.attrs.italic = false;
          break;
        case 24:
          this.attrs.underline = false;
          break;
        case 27:
          this.attrs.inverse = false;
          break;
        case 28:
          this.attrs.invisible = false;
          break;
        case 29:
          this.attrs.strike = false;
          break;
        case 55:
          this.attrs.overline = false;
          break;
        case 30:
        case 31:
        case 32:
        case 33:
        case 34:
        case 35:
        case 36:
        case 37:
          this.attrs.fg = { kind: "palette", index: n - 30 };
          break;
        case 39:
          this.attrs.fg = null;
          break;
        case 40:
        case 41:
        case 42:
        case 43:
        case 44:
        case 45:
        case 46:
        case 47:
          this.attrs.bg = { kind: "palette", index: n - 40 };
          break;
        case 49:
          this.attrs.bg = null;
          break;
        case 58:
        case 59:
          // Underline color — tracked structurally, skipped visually.
          if (params[i + 1] === 5 && params[i + 2] !== undefined) i += 2;
          else if (params[i + 1] === 2 && params[i + 4] !== undefined) i += 4;
          break;
        case 90:
        case 91:
        case 92:
        case 93:
        case 94:
        case 95:
        case 96:
        case 97:
          this.attrs.fg = { kind: "palette", index: n - 90 + 8 };
          break;
        case 100:
        case 101:
        case 102:
        case 103:
        case 104:
        case 105:
        case 106:
        case 107:
          this.attrs.bg = { kind: "palette", index: n - 100 + 8 };
          break;
        case 38:
        case 48: {
          const isFg = n === 38;
          const mode = params[i + 1] ?? 0;
          if (mode === 5 && params[i + 2] !== undefined) {
            const spec: VtColorSpec = { kind: "palette", index: params[i + 2] };
            if (isFg) this.attrs.fg = spec;
            else this.attrs.bg = spec;
            i += 2;
          } else if (
            mode === 2 &&
            params[i + 2] !== undefined &&
            params[i + 3] !== undefined &&
            params[i + 4] !== undefined
          ) {
            const spec: VtColorSpec = {
              kind: "rgb",
              r: params[i + 2],
              g: params[i + 3],
              b: params[i + 4],
            };
            if (isFg) this.attrs.fg = spec;
            else this.attrs.bg = spec;
            i += 4;
          }
          break;
        }
        default:
          break;
      }
      i += 1;
    }
  }
}
