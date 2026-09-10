/**
 * Appearance preferences — ported 1:1 from t3code
 * `apps/mobile/src/lib/appearancePreferences.ts`.
 */
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STEP,
  normalizeTerminalFontSize,
} from "../features/terminal/terminalPreferences";

export const DEFAULT_BASE_FONT_SIZE = 16;
export const MIN_BASE_FONT_SIZE = 11;
export const MAX_BASE_FONT_SIZE = 22;
export const BASE_FONT_SIZE_STEP = 1;

export const DEFAULT_CODE_FONT_SIZE = 12;
export const MIN_CODE_FONT_SIZE = 8;
export const MAX_CODE_FONT_SIZE = 18;
export const CODE_FONT_SIZE_STEP = 1;

export type ThemeMode = "system" | "light" | "dark";
export type ThemeAppearance = "light" | "dark";

/**
 * User-configurable appearance preferences as stored. `null` overrides mean
 * "automatic": the value is derived from the base font size.
 */
export interface AppearancePreferences {
  readonly themeMode: ThemeMode;
  readonly baseFontSize: number;
  readonly terminalFontSize: number | null;
  readonly codeFontSize: number | null;
  readonly codeWordBreak: boolean;
}

/** Effective appearance values after applying base-size derivation. */
export interface ResolvedAppearance {
  readonly baseFontSize: number;
  readonly terminalFontSize: number;
  readonly codeFontSize: number;
  readonly codeWordBreak: boolean;
  readonly isTerminalFontSizeCustom: boolean;
  readonly isCodeFontSizeCustom: boolean;
}

export function normalizeBaseFontSize(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_BASE_FONT_SIZE;
  }

  return Math.min(MAX_BASE_FONT_SIZE, Math.max(MIN_BASE_FONT_SIZE, Math.round(value)));
}

export function normalizeCodeFontSize(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CODE_FONT_SIZE;
  }

  return Math.min(MAX_CODE_FONT_SIZE, Math.max(MIN_CODE_FONT_SIZE, Math.round(value)));
}

export function normalizeCodeWordBreak(value: boolean | null | undefined): boolean {
  return value === true;
}

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

/** Terminal size derived from base: 10.5pt at base 16, snapped to 0.5pt steps. */
export function deriveTerminalFontSize(baseFontSize: number): number {
  const scale = normalizeBaseFontSize(baseFontSize) / DEFAULT_BASE_FONT_SIZE;
  return normalizeTerminalFontSize(Math.round(DEFAULT_TERMINAL_FONT_SIZE * scale * 2) / 2);
}

/** Code/diff size derived from base: 12pt at base 16. */
export function deriveCodeFontSize(baseFontSize: number): number {
  const scale = normalizeBaseFontSize(baseFontSize) / DEFAULT_BASE_FONT_SIZE;
  return normalizeCodeFontSize(Math.round(DEFAULT_CODE_FONT_SIZE * scale));
}

interface StoredAppearancePreferences {
  readonly themeMode?: ThemeMode | null | undefined;
  readonly baseFontSize?: number | null | undefined;
  readonly terminalFontSize?: number | null | undefined;
  readonly codeFontSize?: number | null | undefined;
  readonly codeWordBreak?: boolean | null | undefined;
}

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  themeMode: "system",
  baseFontSize: DEFAULT_BASE_FONT_SIZE,
  terminalFontSize: null,
  codeFontSize: null,
  codeWordBreak: false,
};

export function resolveAppearancePreferences(
  stored: StoredAppearancePreferences | null | undefined,
): AppearancePreferences {
  return {
    themeMode: normalizeThemeMode(stored?.themeMode),
    baseFontSize: normalizeBaseFontSize(stored?.baseFontSize),
    terminalFontSize:
      typeof stored?.terminalFontSize === "number" && Number.isFinite(stored.terminalFontSize)
        ? normalizeTerminalFontSize(stored.terminalFontSize)
        : null,
    codeFontSize:
      typeof stored?.codeFontSize === "number" && Number.isFinite(stored.codeFontSize)
        ? normalizeCodeFontSize(stored.codeFontSize)
        : null,
    codeWordBreak: normalizeCodeWordBreak(stored?.codeWordBreak),
  };
}

export function resolveAppearance(preferences: AppearancePreferences): ResolvedAppearance {
  return {
    baseFontSize: preferences.baseFontSize,
    terminalFontSize:
      preferences.terminalFontSize ?? deriveTerminalFontSize(preferences.baseFontSize),
    codeFontSize: preferences.codeFontSize ?? deriveCodeFontSize(preferences.baseFontSize),
    codeWordBreak: preferences.codeWordBreak,
    isTerminalFontSizeCustom: preferences.terminalFontSize !== null,
    isCodeFontSizeCustom: preferences.codeFontSize !== null,
  };
}

export function resolveThemeAppearance(themeMode: ThemeMode, systemScheme: ThemeAppearance): ThemeAppearance {
  return themeMode === "system" ? systemScheme : themeMode;
}

export function stepBaseFontSize(current: number, direction: -1 | 1): number {
  const next = direction === -1 ? current - BASE_FONT_SIZE_STEP : current + BASE_FONT_SIZE_STEP;
  return normalizeBaseFontSize(next);
}

export function stepTerminalFontSize(current: number, direction: -1 | 1): number {
  const next =
    direction === -1 ? current - TERMINAL_FONT_SIZE_STEP : current + TERMINAL_FONT_SIZE_STEP;
  return normalizeTerminalFontSize(next);
}

export function stepCodeFontSize(current: number, direction: -1 | 1): number {
  const next = direction === -1 ? current - CODE_FONT_SIZE_STEP : current + CODE_FONT_SIZE_STEP;
  return normalizeCodeFontSize(next);
}

export {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STEP,
  normalizeTerminalFontSize,
};
