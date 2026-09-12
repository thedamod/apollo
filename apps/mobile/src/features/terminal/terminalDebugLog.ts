/**
 * Terminal debug log — ported from t3code
 * `apps/mobile/src/features/terminal/terminalDebugLog.ts`.
 *
 * Gated on `__DEV__` (or an explicit `globalThis.__T3_TERMINAL_DEBUG__` /
 * `__HOME_TERMINAL_DEBUG__` flag) so release builds stay silent.
 */

declare const __DEV__: boolean | undefined;

export function isTerminalDebugEnabled(): boolean {
  try {
    const flag = (globalThis as Record<string, unknown>)
      .__HOME_TERMINAL_DEBUG__;
    if (flag === true) return true;
    const t3Flag = (globalThis as Record<string, unknown>)
      .__T3_TERMINAL_DEBUG__;
    if (t3Flag === true) return true;
    return typeof __DEV__ !== "undefined" && __DEV__ === true;
  } catch {
    return false;
  }
}

export function terminalDebugLog(
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!isTerminalDebugEnabled()) return;
  if (data !== undefined) {
    // eslint-disable-next-line no-console
    console.log(`[home-terminal] ${message}`, data);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[home-terminal] ${message}`);
  }
}
