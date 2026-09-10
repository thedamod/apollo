/**
 * Appearance provider — t3code `AppearancePreferencesProvider` ported to this
 * app's stack (SecureStore persistence, system color scheme, no Uniwind).
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";
import * as SecureStore from "expo-secure-store";
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  resolveAppearance,
  resolveAppearancePreferences,
  resolveThemeAppearance,
  type AppearancePreferences,
  type ResolvedAppearance,
  type ThemeAppearance,
  type ThemeMode,
} from "../../lib/appearance";
import { cacheTerminalFontSize } from "../terminal/terminalUiState";

const STORE_KEY = "aether-appearance-v1";

interface AppearanceContextValue {
  readonly isReady: boolean;
  readonly preferences: AppearancePreferences;
  readonly appearance: ResolvedAppearance;
  readonly themeMode: ThemeMode;
  readonly themeAppearance: ThemeAppearance;
  readonly setThemeMode: (mode: ThemeMode) => void;
  readonly setBaseFontSize: (size: number) => void;
  readonly setTerminalFontSize: (size: number | null) => void;
  readonly setCodeFontSize: (size: number | null) => void;
  readonly setCodeWordBreak: (enabled: boolean) => void;
}

const AppearanceContext = createContext<AppearanceContextValue>({
  isReady: false,
  preferences: DEFAULT_APPEARANCE_PREFERENCES,
  appearance: resolveAppearance(DEFAULT_APPEARANCE_PREFERENCES),
  themeMode: "system",
  themeAppearance: "dark",
  setThemeMode: () => {},
  setBaseFontSize: () => {},
  setTerminalFontSize: () => {},
  setCodeFontSize: () => {},
  setCodeWordBreak: () => {},
});

export function useAppearancePreferences(): AppearanceContextValue {
  return useContext(AppearanceContext);
}

async function loadStored(): Promise<AppearancePreferences> {
  try {
    const raw = await SecureStore.getItemAsync(STORE_KEY);
    if (raw) {
      return resolveAppearancePreferences(JSON.parse(raw));
    }
  } catch {}
  return DEFAULT_APPEARANCE_PREFERENCES;
}

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [preferences, setPreferences] = useState<AppearancePreferences>(DEFAULT_APPEARANCE_PREFERENCES);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    loadStored()
      .then(setPreferences)
      .finally(() => setIsReady(true));
  }, []);

  const persist = useCallback(async (next: AppearancePreferences) => {
    setPreferences(next);
    try {
      await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(next));
    } catch {}
  }, []);

  const appearance = useMemo(() => resolveAppearance(preferences), [preferences]);
  const themeAppearance = resolveThemeAppearance(
    preferences.themeMode,
    systemScheme === "light" ? "light" : "dark",
  );

  // Mirror t3code: keep the font-size cache warm so surfaces created before
  // preferences load still pick up the right size.
  useEffect(() => {
    if (isReady) cacheTerminalFontSize(appearance.terminalFontSize);
  }, [appearance.terminalFontSize, isReady]);

  const value = useMemo<AppearanceContextValue>(
    () => ({
      isReady,
      preferences,
      appearance,
      themeMode: preferences.themeMode,
      themeAppearance,
      setThemeMode: (mode) => void persist({ ...preferences, themeMode: mode }),
      setBaseFontSize: (size) => void persist({ ...preferences, baseFontSize: size }),
      setTerminalFontSize: (size) =>
        void persist({
          ...preferences,
          terminalFontSize: size,
        }),
      setCodeFontSize: (size) => void persist({ ...preferences, codeFontSize: size }),
      setCodeWordBreak: (enabled) => void persist({ ...preferences, codeWordBreak: enabled }),
    }),
    [appearance, isReady, persist, preferences, themeAppearance],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}
