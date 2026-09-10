/**
 * Design tokens — ported from t3code `apps/mobile/global.css` dark variant
 * (DM Sans, near-black screen, translucent cards) and tuned to the
 * Aether home mock: #0b0b0c screen, #161617 cards, soft white borders.
 */
export const theme = {
  colors: {
    screen: "#0b0b0c",
    card: "#161617",
    cardAlt: "#1c1c1e",
    border: "rgba(255,255,255,0.07)",
    borderSubtle: "rgba(255,255,255,0.04)",
    foreground: "#f5f5f5",
    secondary: "#a3a3a3",
    muted: "#8e8e93",
    tertiary: "#636366",
    chevron: "rgba(255,255,255,0.25)",
    cpu: "#34c759",
    ram: "#0a84ff",
    disk: "#a78bfa",
    uptime: "#8e8e93",
    danger: "#ff453a",
    link: "#0a84ff",
    tabActive: "#ffffff",
    tabInactive: "#8e8e93",
    dotOnline: "#30d158",
  },
  radius: {
    card: 18,
    pill: 999,
    tabBar: 26,
  },
  font: {
    // t3code registers DM Sans PostScript names on both platforms
    // (see context/t3code app.config.ts). Fall back to system until loaded.
    regular: "DMSans-Regular",
    medium: "DMSans-Medium",
    bold: "DMSans-Bold",
  },
} as const;

export type Theme = typeof theme;
