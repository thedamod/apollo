/**
 * Terminal grid surface — renders the `VtParser` screen grid with full ANSI
 * color/attribute fidelity (the t3code Ghostty view's job, in Expo-Go-safe
 * RN Text).
 *
 * Same component contract as before (`TerminalSurface` + `estimateGridSize`);
 * text input moved to the screen's hidden field, so this is render-only.
 */
import { memo } from "react";
import { Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { getMobileTerminalTheme, type TerminalTheme } from "./terminalTheme";
import { useAppearancePreferences } from "../appearance/AppearanceContext";
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
  readonly onResize: (size: { readonly cols: number; readonly rows: number }) => void;
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
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function resolveSpec(spec: VtColorSpec, theme: TerminalTheme): string {
  if (spec.kind === "rgb") return hex(spec.r, spec.g, spec.b);
  const i = spec.index;
  if (i >= 0 && i < theme.palette.length) return theme.palette[i];
  if (i >= 16 && i < 232) {
    const n = i - 16;
    return hex(CUBE_STEPS[Math.floor(n / 36)], CUBE_STEPS[Math.floor((n % 36) / 6)], CUBE_STEPS[n % 6]);
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
  textDecorationLine?: "underline" | "line-through" | "underline line-through" | "none";
  opacity?: number;
}

function styleKey(s: RunStyle): string {
  return `${s.color}|${s.backgroundColor ?? ""}|${s.fontWeight ?? ""}|${s.fontStyle ?? ""}|${s.textDecorationLine ?? ""}|${s.opacity ?? ""}`;
}

function runStyleFor(attrs: VtAttrs, theme: TerminalTheme, defaultBg: string | null): RunStyle {
  let fg = attrs.fg ? resolveSpec(attrs.fg, theme) : theme.foreground;
  // xterm convention: bold + standard color renders as the bright variant.
  if (attrs.bold && attrs.fg?.kind === "palette" && attrs.fg.index < 8) {
    fg = resolveSpec({ kind: "palette", index: attrs.fg.index + 8 }, theme);
  }
  let bg = attrs.bg ? resolveSpec(attrs.bg, theme) : defaultBg ?? undefined;
  if (attrs.inverse) {
    const swappedFg = bg ?? theme.background;
    const swappedBg = fg;
    fg = swappedFg;
    bg = swappedBg;
  }
  let decoration: "underline" | "line-through" | "underline line-through" | undefined;
  if (attrs.underline && attrs.strike) decoration = "underline line-through";
  else if (attrs.underline) decoration = "underline";
  else if (attrs.strike) decoration = "line-through";
  return {
    color: fg,
    ...(bg ? { backgroundColor: bg } : {}),
    ...(attrs.bold ? { fontWeight: "bold" as const } : {}),
    ...(attrs.italic ? { fontStyle: "italic" as const } : {}),
    ...(decoration ? { textDecorationLine: decoration } : {}),
    ...(attrs.dim ? { opacity: 0.65 } : {}),
  };
}

interface Run {
  text: string;
  width: number;
  widths: number[];
  style: RunStyle;
}

function lineRuns(line: VtCell[], theme: TerminalTheme): Run[] {
  const runs: Run[] = [];
  let text = "";
  let width = 0;
  let widths: number[] = [];
  let style: RunStyle | null = null;
  let key = "";
  const flush = () => {
    if (style) runs.push({ text, width, widths, style });
  };
  for (const cell of line) {
    if (cell.w === 0) continue; // wide-char trailing half
    const cellStyle = runStyleFor(cell.attrs, theme, null);
    const cellKey = styleKey(cellStyle);
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
      key = cellKey;
    }
  }
  flush();
  return runs;
}

function TerminalGridLine({
  runs,
  cursorCol,
  cursorStyle,
  fontSize,
  lineHeight,
}: {
  runs: Run[];
  cursorCol: number | null;
  cursorStyle: RunStyle;
  fontSize: number;
  lineHeight: number;
}) {
  if (runs.length === 0) {
    return (
      <Text style={{ fontFamily: "monospace", fontSize, lineHeight }}>
        {cursorCol === 0 ? <Text style={[{ fontFamily: "monospace", fontSize }, cursorStyle]}> </Text> : " "}
      </Text>
    );
  }
  let col = 0;
  const children: React.ReactNode[] = [];
  runs.forEach((run, ri) => {
    const runStart = col;
    const runEnd = col + run.width;
    col = runEnd;
    if (cursorCol === null || cursorCol < runStart || cursorCol >= runEnd) {
      children.push(
        <Text key={ri} style={[{ fontFamily: "monospace", fontSize }, run.style]}>
          {run.text}
        </Text>,
      );
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
      children.push(
        <Text key={`${ri}-b`} style={[{ fontFamily: "monospace", fontSize }, run.style]}>
          {before}
        </Text>,
      );
    }
    children.push(
      <Text key={`${ri}-c`} style={[{ fontFamily: "monospace", fontSize }, cursorStyle]}>
        {at || " "}
      </Text>,
    );
    if (after) {
      children.push(
        <Text key={`${ri}-a`} style={[{ fontFamily: "monospace", fontSize }, run.style]}>
          {after}
        </Text>,
      );
    }
  });
  if (cursorCol !== null && cursorCol >= col) {
    children.push(
      <Text key="cursor-pad" style={[{ fontFamily: "monospace", fontSize }, cursorStyle]}>
        {" "}
      </Text>,
    );
  }
  return (
    <Text style={{ fontFamily: "monospace", fontSize, lineHeight }}>{children}</Text>
  );
}

function TerminalSurfaceInner(props: TerminalSurfaceProps) {
  const fontSize = props.fontSize ?? 12;
  const lineHeight = Math.round(fontSize * 1.35);
  const { themeAppearance, preferences } = useAppearancePreferences();
  const theme = props.theme ?? getMobileTerminalTheme(preferences.themeMode, themeAppearance);

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) {
      props.onResize(estimateGridSize({ width, height, fontSize }));
    }
  };

  const lines = props.parser.lines;
  const start = Math.max(0, lines.length - MAX_RENDER_LINES);
  const cursorStyle: RunStyle = {
    color: theme.cursorBackground,
    backgroundColor: theme.cursorForeground,
  };
  const showCursor = props.isRunning && props.parser.cursorVisible;

  return (
    <View
      style={[{ backgroundColor: theme.background, flex: 1 }, props.style]}
      onLayout={handleLayout}
    >
      {lines.slice(start).map((line, i) => {
        const absoluteY = start + i;
        const cursorCol =
          showCursor && absoluteY === props.parser.cursorY ? props.parser.cursorX : null;
        return (
          <TerminalGridLine
            key={`${props.terminalKey}:${absoluteY}`}
            runs={lineRuns(line, theme)}
            cursorCol={cursorCol}
            cursorStyle={cursorStyle}
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
