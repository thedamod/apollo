/**
 * @deprecated — split into focused screens:
 *  - `screens/Terminal.tsx` (t3code terminal port)
 *  - `screens/Settings.tsx` (structured settings)
 *  - `screens/AppearanceSettings.tsx`
 *  - `screens/Environments.tsx` (connection settings)
 *
 * Kept as a re-export shim so older imports keep resolving.
 */
export { TerminalScreen } from "./Terminal";
export { SettingsScreen } from "./Settings";
