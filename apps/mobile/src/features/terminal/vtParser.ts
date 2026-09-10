/**
 * Minimal VT (ANSI escape) parser + screen grid — the rendering engine behind
 * the terminal surface.
 *
 * t3code renders through a native Ghostty view. This app ships under Expo Go
 * (no native modules), so this parser gives the text surface the same visual
 * semantics for everyday shell output: SGR colors (16/256/truecolor), bold,
 * dim, italic, underline, inverse, cursor movement, erase, scrolling, and
 * wide (double-cell) unicode characters. Unknown sequences are skipped
 * gracefully so raw escapes never leak onto the screen.
 */
export type VtColorSpec =
  | { readonly kind: "palette"; readonly index: number }
  | { readonly kind: "rgb"; readonly r: number; readonly g: number; readonly b: number };

export interface VtAttrs {
  fg: VtColorSpec | null;
  bg: VtColorSpec | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
}

export interface VtCell {
  /** grapheme; `""` with w:0 marks the trailing half of a wide char. */
  ch: string;
  /** cell width: 1, 2 (wide char lead), or 0 (wide char trail). */
  w: number;
  attrs: VtAttrs;
}

export type VtLine = VtCell[];

export const MAX_VT_SCROLLBACK_LINES = 1000;

const DEFAULT_ATTRS: VtAttrs = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
  inverse: false,
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

type ParserState = "ground" | "esc" | "csi" | "osc" | "oscEsc" | "charset";

export class VtParser {
  cols: number;
  lines: VtLine[] = [];
  cursorX = 0;
  cursorY = 0;
  cursorVisible = true;

  private attrs: VtAttrs = { ...DEFAULT_ATTRS };
  private state: ParserState = "ground";
  private csiParam = "";
  private csiPrivate = "";
  private csiIntermediate = "";
  private savedX = 0;
  private savedY = 0;
  private savedAttrs: VtAttrs = { ...DEFAULT_ATTRS };

  constructor(cols: number) {
    this.cols = Math.max(1, Math.floor(cols));
    this.ensureLine(0);
  }

  reset(): void {
    this.lines = [];
    this.cursorX = 0;
    this.cursorY = 0;
    this.cursorVisible = true;
    this.attrs = { ...DEFAULT_ATTRS };
    this.state = "ground";
    this.csiParam = "";
    this.csiPrivate = "";
    this.csiIntermediate = "";
    this.savedX = 0;
    this.savedY = 0;
    this.savedAttrs = { ...DEFAULT_ATTRS };
    this.ensureLine(0);
  }

  setCols(cols: number): void {
    this.cols = Math.max(1, Math.floor(cols));
  }

  feedSnapshot(text: string): void {
    this.reset();
    this.feed(text);
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

  private newline(): void {
    this.cursorX = 0;
    this.cursorY += 1;
    this.ensureLine(this.cursorY);
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
    line[this.cursorX] = { ch, w: width, attrs: cloneAttrs(this.attrs) };
    if (width === 2) {
      line[this.cursorX + 1] = { ch: "", w: 0, attrs: cloneAttrs(this.attrs) };
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
          this.state = "ground";
        } else if (ch === "\u001b") {
          this.state = "oscEsc";
        }
        return;
      case "oscEsc":
        // Only "\\" terminates; anything else returns to OSC content.
        this.state = ch === "\\" ? "ground" : "osc";
        return;
      case "charset":
        // Single-char charset designator — consumed and ignored.
        this.state = "ground";
        return;
    }
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
          this.cursorY += 1;
          this.ensureLine(this.cursorY);
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
        return;
      case "(":
      case ")":
      case "*":
      case "+":
        this.state = "charset";
        return;
      case "M": // reverse index
        this.cursorY = Math.max(0, this.cursorY - 1);
        break;
      case "E": // next line
        this.newline();
        break;
      case "D": // index
        this.cursorY += 1;
        this.ensureLine(this.cursorY);
        break;
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
    // Private (`?`) and intermediate-modified sequences are modes/queries
    // the surface doesn't implement — consume silently.
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
          this.ensureLine(0);
        } else if (mode === 1) {
          for (let y = 0; y < this.cursorY; y++) {
            this.eraseCells(this.lines[y] ?? [], 0, this.cols);
          }
          this.eraseCells(this.currentLine(), 0, this.cursorX + 1);
        } else {
          this.eraseCells(this.currentLine(), this.cursorX, this.cols);
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
        line.splice(this.cursorX, 0, ...Array.from({ length: rep(0, 1) }, blankCell));
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
        this.lines.splice(this.cursorY, 0, ...Array.from({ length: rep(0, 1) }, () => [] as VtLine));
        break;
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
      case "m":
        this.applySgr(p);
        break;
      default:
        // "h", "l", "r", "c", "n", "q", "g", "t", … — ignored.
        break;
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
          this.attrs.dim = true;
          break;
        case 3:
          this.attrs.italic = true;
          break;
        case 4:
          this.attrs.underline = true;
          break;
        case 7:
          this.attrs.inverse = true;
          break;
        case 9:
          this.attrs.strike = true;
          break;
        case 22:
          this.attrs.bold = false;
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
        case 29:
          this.attrs.strike = false;
          break;
        case 30: case 31: case 32: case 33:
        case 34: case 35: case 36: case 37:
          this.attrs.fg = { kind: "palette", index: n - 30 };
          break;
        case 39:
          this.attrs.fg = null;
          break;
        case 40: case 41: case 42: case 43:
        case 44: case 45: case 46: case 47:
          this.attrs.bg = { kind: "palette", index: n - 40 };
          break;
        case 49:
          this.attrs.bg = null;
          break;
        case 90: case 91: case 92: case 93:
        case 94: case 95: case 96: case 97:
          this.attrs.fg = { kind: "palette", index: n - 90 + 8 };
          break;
        case 100: case 101: case 102: case 103:
        case 104: case 105: case 106: case 107:
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
