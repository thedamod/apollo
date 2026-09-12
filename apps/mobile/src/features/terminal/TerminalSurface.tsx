/**
 * Terminal grid surface — renders the `VtParser` screen grid with full ANSI
 * color/attribute fidelity (the t3code Ghostty view's job, in Expo-Go-safe
 * RN Text).
 *
 * Same component contract as before (`TerminalSurface` + `estimateGridSize`);
 * text input moved to the screen's hidden field, so this is render-only.
 */
import { memo, useEffect, useState } from "react";
import {
  Linking,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { getMobileTerminalTheme, type TerminalTheme } from "./terminalTheme";
import { useAppearancePreferences } from "../appearance/AppearanceContext";
import { extractTerminalLinks } from "./terminalLinks";
import type { VtAttrs, VtCell, VtColorSpec, VtParser } from "./vtParser";

export interface TerminalSurfaceProps {
  readonly terminalKey: string;
  readonly parser: VtParser;
  /** bumped whenever the parser advances — the grid mutates in place. */
  readonly version: number;
  readonly fontSize?: number;
  readonly isRunning: boolean;
  readonly theme?: TerminalTheme;
  readonly style?: StyleProp<ViewStyle>;
  readonly onResize: (size: {
    readonly cols: number;
    readonly rows: number;
  }) => void;
}

export function estimateGridSize(input: {
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
}): { readonly cols: number; readonly rows: number } {
  const cellWidth = input.fontSize * 0.62;
  const cellHeight = input.fontSize * 1.35;
  return {
    cols: Math.max(20, Math.min(400, Math.floor(input.width / cellWidth))),
    rows: Math.max(5, Math.min(200, Math.floor(input.height / cellHeight))),
  };
}

const MAX_RENDER_LINES = 250;

const CUBE_STEPS = [0, 95, 135, 175, 215, 255];

function hex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function resolveSpec(spec: VtColorSpec, theme: TerminalTheme): string {
  if (spec.kind === "rgb") return hex(spec.r, spec.g, spec.b);
  const i = spec.index;
  if (i >= 0 && i < theme.palette.length) return theme.palette[i];
  if (i >= 16 && i < 232) {
    const n = i - 16;
    return hex(
      CUBE_STEPS[Math.floor(n / 36)],
      CUBE_STEPS[Math.floor((n % 36) / 6)],
      CUBE_STEPS[n % 6],
    );
  }
  if (i >= 232 && i < 256) {
    const v = 8 + (i - 232) * 10;
    return hex(v, v, v);
  }
  return theme.foreground;
}

interface RunStyle {
  color: string;
  backgroundColor?: string;
  fontWeight?: "bold";
  fontStyle?: "italic";
  textDecorationLine?:
    "underline" | "line-through" | "underline line-through" | "none";
  borderTopWidth?: number;
  borderTopColor?: string;
  opacity?: number;
}

function styleKey(s: RunStyle): string {
  return `${s.color}|${s.backgroundColor ?? ""}|${s.fontWeight ?? ""}|${s.fontStyle ?? ""}|${s.textDecorationLine ?? ""}|${s.borderTopWidth ?? ""}|${s.borderTopColor ?? ""}|${s.opacity ?? ""}`;
}

function runStyleFor(
  attrs: VtAttrs,
  theme: TerminalTheme,
  defaultBg: string | null,
): RunStyle {
  let fg = attrs.fg ? resolveSpec(attrs.fg, theme) : theme.foreground;
  // xterm convention: bold + standard color renders as the bright variant.
  if (attrs.bold && attrs.fg?.kind === "palette" && attrs.fg.index < 8) {
    fg = resolveSpec({ kind: "palette", index: attrs.fg.index + 8 }, theme);
  }
  let bg = attrs.bg ? resolveSpec(attrs.bg, theme) : (defaultBg ?? undefined);
  if (attrs.inverse) {
    const swappedFg = bg ?? theme.background;
    const swappedBg = fg;
    fg = swappedFg;
    bg = swappedBg;
  }
  // Invisible text renders as blank space (takes up its cells).
  if (attrs.invisible && !attrs.inverse) {
    fg = bg ?? theme.background;
  }
  let decoration:
    "underline" | "line-through" | "underline line-through" | undefined;
  if (attrs.underline && attrs.strike) decoration = "underline line-through";
  else if (attrs.underline) decoration = "underline";
  else if (attrs.strike) decoration = "line-through";
  return {
    color: fg,
    ...(bg ? { backgroundColor: bg } : {}),
    ...(attrs.bold ? { fontWeight: "bold" as const } : {}),
    ...(attrs.italic ? { fontStyle: "italic" as const } : {}),
    ...(decoration ? { textDecorationLine: decoration } : {}),
    // RN Text has no overline — emulate with a top border in the fg color.
    ...(attrs.overline ? { borderTopWidth: 1, borderTopColor: fg } : {}),
    ...(attrs.dim || attrs.faint ? { opacity: 0.65 } : {}),
  };
}

interface Run {
  text: string;
  width: number;
  widths: number[];
  style: RunStyle;
  link: string | null;
}

function lineRuns(line: VtCell[], theme: TerminalTheme): Run[] {
  const runs: Run[] = [];
  let text = "";
  let width = 0;
  let widths: number[] = [];
  let style: RunStyle | null = null;
  let link: string | null = null;
  let key = "";
  const flush = () => {
    if (style) runs.push({ text, width, widths, style, link });
  };
  for (const cell of line) {
    if (cell.w === 0) continue; // wide-char trailing half
    const cellStyle = runStyleFor(cell.attrs, theme, null);
    const cellLink = cell.link ?? null;
    const cellKey = `${styleKey(cellStyle)}|${cellLink ?? ""}`;
    if (style && cellKey === key) {
      text += cell.ch;
      width += cell.w;
      widths.push(cell.w);
    } else {
      flush();
      text = cell.ch;
      width = cell.w;
      widths = [cell.w];
      style = cellStyle;
      link = cellLink;
      key = cellKey;
    }
  }
  flush();
  return splitUrlRuns(runs);
}

/**
 * Split runs without an OSC 8 link on plain-text URL matches so bare URLs
 * pasted into the shell are tappable too (t3code `terminal-links.ts`
 * parity, URL kind only — path matches need a file-browser handoff).
 */
function splitUrlRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (run.link || run.text.trim().length === 0) {
      out.push(run);
      continue;
    }
    const matches = extractTerminalLinks(run.text).filter(
      (m) => m.kind === "url",
    );
    if (matches.length === 0) {
      out.push(run);
      continue;
    }
    const chars = Array.from(run.text);
    let cursor = 0;
    for (const m of matches) {
      // Map UTF-16 offsets (regex) to code-point indices.
      const startCp = Array.from(run.text.slice(0, m.start)).length;
      const endCp = startCp + Array.from(m.text).length;
      if (startCp > cursor) {
        out.push({
          text: chars.slice(cursor, startCp).join(""),
          width: run.widths.slice(cursor, startCp).reduce((a, b) => a + b, 0),
          widths: run.widths.slice(cursor, startCp),
          style: run.style,
          link: null,
        });
      }
      out.push({
        text: chars.slice(startCp, endCp).join(""),
        width: run.widths.slice(startCp, endCp).reduce((a, b) => a + b, 0),
        widths: run.widths.slice(startCp, endCp),
        style: run.style,
        link: m.text,
      });
      cursor = endCp;
    }
    if (cursor < chars.length) {
      out.push({
        text: chars.slice(cursor).join(""),
        width: run.widths.slice(cursor).reduce((a, b) => a + b, 0),
        widths: run.widths.slice(cursor),
        style: run.style,
        link: null,
      });
    }
  }
  return out;
}

function TerminalGridLine({
  runs,
  cursorCol,
  cursorBlock,
  cursorText,
  fontSize,
  lineHeight,
}: {
  runs: Run[];
  cursorCol: number | null;
  /** block-cursor cell style (inverted). */
  cursorBlock: RunStyle;
  /** underline/bar-cursor cell style (fg-colored, underlined). */
  cursorText: RunStyle | null;
  fontSize: number;
  lineHeight: number;
}) {
  const cursorCellStyle = cursorText ?? cursorBlock;
  if (runs.length === 0) {
    return (
      <Text style={{ fontFamily: "monospace", fontSize, lineHeight }}>
        {cursorCol === 0 ? (
          <Text
            style={[{ fontFamily: "monospace", fontSize }, cursorCellStyle]}
          >
            {" "}
          </Text>
        ) : (
          " "
        )}
      </Text>
    );
  }
  let col = 0;
  const children: React.ReactNode[] = [];
  runs.forEach((run, ri) => {
    const runStart = col;
    const runEnd = col + run.width;
    col = runEnd;
    const runText = (t: string, keySuffix: string, style: RunStyle) =>
      run.link ? (
        <Text
          key={`${ri}-${keySuffix}`}
          style={[
            { fontFamily: "monospace", fontSize },
            style,
            { textDecorationLine: "underline" },
          ]}
          onPress={() => {
            Linking.openURL(run.link as string).catch(() => {});
          }}
        >
          {t}
        </Text>
      ) : (
        <Text
          key={`${ri}-${keySuffix}`}
          style={[{ fontFamily: "monospace", fontSize }, style]}
        >
          {t}
        </Text>
      );
    if (cursorCol === null || cursorCol < runStart || cursorCol >= runEnd) {
      children.push(runText(run.text, "t", run.style));
      return;
    }
    // Split the run around the cursor column.
    const chars = Array.from(run.text);
    let used = 0;
    let before = "";
    let at = "";
    let after = "";
    for (let ci = 0; ci < chars.length; ci++) {
      const ch = chars[ci];
      const cw = run.widths[ci] ?? 1;
      if (used + cw <= cursorCol - runStart) {
        before += ch;
        used += cw;
      } else if (at === "") {
        at = ch;
        used += cw;
      } else {
        after += ch;
      }
    }
    if (before) {
      children.push(runText(before, "b", run.style));
    }
    children.push(
      <Text
        key={`${ri}-c`}
        style={[{ fontFamily: "monospace", fontSize }, cursorCellStyle]}
      >
        {at || " "}
      </Text>,
    );
    if (after) {
      children.push(runText(after, "a", run.style));
    }
  });
  if (cursorCol !== null && cursorCol >= col) {
    children.push(
      <Text
        key="cursor-pad"
        style={[{ fontFamily: "monospace", fontSize }, cursorCellStyle]}
      >
        {" "}
      </Text>,
    );
  }
  return (
    <Text style={{ fontFamily: "monospace", fontSize, lineHeight }}>
      {children}
    </Text>
  );
}

function TerminalSurfaceInner(props: TerminalSurfaceProps) {
  const fontSize = props.fontSize ?? 12;
  const lineHeight = Math.round(fontSize * 1.35);
  const { themeAppearance, preferences } = useAppearancePreferences();
  const theme =
    props.theme ??
    getMobileTerminalTheme(preferences.themeMode, themeAppearance);

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) {
      props.onResize(estimateGridSize({ width, height, fontSize }));
    }
  };

  const lines = props.parser.lines;
  const start = Math.max(0, lines.length - MAX_RENDER_LINES);
  const cursorBlock: RunStyle = {
    color: theme.cursorBackground,
    backgroundColor: theme.cursorForeground,
  };
  // Underline/bar cursor: fg-colored cell with an underline instead of the
  // inverted block (t3code Ghostty cursor-style parity).
  const cursorText: RunStyle | null =
    props.parser.cursorStyle === "block"
      ? null
      : {
          color: theme.cursorForeground,
          textDecorationLine: "underline",
        };
  // Blinking cursor (DECSCUSR … blink): 500 ms timer like t3code's canvas.
  const [blinkOn, setBlinkOn] = useState(true);
  useEffect(() => {
    if (!props.parser.cursorBlink) {
      setBlinkOn(true);
      return;
    }
    const timer = setInterval(() => setBlinkOn((v) => !v), 500);
    return () => clearInterval(timer);
  }, [props.parser.cursorBlink, props.version]);
  const showCursor = props.isRunning && props.parser.cursorVisible && blinkOn;

  return (
    <View
      style={[{ backgroundColor: theme.background, flex: 1 }, props.style]}
      onLayout={handleLayout}
    >
      {lines.slice(start).map((line, i) => {
        const absoluteY = start + i;
        const cursorCol =
          showCursor && absoluteY === props.parser.cursorY
            ? props.parser.cursorX
            : null;
        return (
          <TerminalGridLine
            key={`${props.terminalKey}:${absoluteY}`}
            runs={lineRuns(line, theme)}
            cursorCol={cursorCol}
            cursorBlock={cursorBlock}
            cursorText={cursorText}
            fontSize={fontSize}
            lineHeight={lineHeight}
          />
        );
      })}
    </View>
  );
}

export const TerminalSurface = memo(
  TerminalSurfaceInner,
  (prev, next) =>
    prev.version === next.version &&
    prev.fontSize === next.fontSize &&
    prev.theme === next.theme &&
    prev.parser === next.parser &&
    prev.isRunning === next.isRunning &&
    prev.terminalKey === next.terminalKey,
);
