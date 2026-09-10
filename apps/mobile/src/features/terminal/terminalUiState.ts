/**
 * In-memory terminal UI caches — ported 1:1 from t3code
 * `apps/mobile/src/features/terminal/terminalUiState.ts`.
 *
 * t3code keys by environment+thread+terminal; this app has a single
 * connection with `sessionId` scoping, so the key is `sessionId:terminalId`.
 */
import { DEFAULT_TERMINAL_FONT_SIZE, normalizeTerminalFontSize } from "./terminalPreferences";

export interface TerminalGridSize {
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalUiStateTarget {
  readonly sessionId: string;
  readonly terminalId: string;
}

const terminalGridSizeCache = new Map<string, TerminalGridSize>();
let cachedTerminalFontSize: number | null = null;

function terminalUiStateKey(target: TerminalUiStateTarget): string {
  return `${target.sessionId}:${target.terminalId}`;
}

export function getCachedTerminalFontSize(): number | null {
  return cachedTerminalFontSize;
}

export function cacheTerminalFontSize(value: number | null | undefined): number {
  const normalized = normalizeTerminalFontSize(value ?? DEFAULT_TERMINAL_FONT_SIZE);
  cachedTerminalFontSize = normalized;
  return normalized;
}

export function getCachedTerminalGridSize(target: TerminalUiStateTarget): TerminalGridSize | null {
  return terminalGridSizeCache.get(terminalUiStateKey(target)) ?? null;
}

export function cacheTerminalGridSize(
  target: TerminalUiStateTarget,
  size: TerminalGridSize,
): TerminalGridSize {
  const normalized = {
    cols: Math.max(1, Math.floor(size.cols)),
    rows: Math.max(1, Math.floor(size.rows)),
  };
  terminalGridSizeCache.set(terminalUiStateKey(target), normalized);
  return normalized;
}

export function resetTerminalUiStateCaches() {
  cachedTerminalFontSize = null;
  terminalGridSizeCache.clear();
}
