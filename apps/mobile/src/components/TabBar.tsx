import React, { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import {
  Folder,
  House,
  Play,
  Server,
  Settings as SettingsIcon,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react-native";
import { theme } from "../theme";

export type TabKey = "home" | "files" | "terminal" | "scripts" | "services" | "settings";

/**
 * Bottom dock styled after `context/glass-tabs` (react-native-glass-tabs):
 * floating pill, frosted-glass background, animated active selector,
 * badge support, haptic tap. Icon-only (no text labels).
 *
 * Adapted to our constraints: pure JS (no native GlassBarView — works in
 * Expo Go), dark-theme tokens (white active @ low-alpha selector instead of
 * blue primary), 6 tabs instead of 3–5, rendered in-flow like the mock
 * rather than as an absolute overlay.
 *
 * Spec reference — glass-tabs DEFAULTS:
 *   bar height 56, cornerRadius 28, maxWidth 344, margin 8,
 *   icon 20, selector = primary @ 0.09 alpha scaling 0.6→1
 *   over 320ms, badge #FF3B30 circle, dark bg #1C1C1E @ 0.85.
 */
const TABS: Array<{ key: TabKey; icon: LucideIcon; label: string; badge?: number }> = [
  { key: "home", icon: House, label: "Home" },
  { key: "files", icon: Folder, label: "Files" },
  { key: "terminal", icon: SquareTerminal, label: "Terminal" },
  { key: "scripts", icon: Play, label: "Scripts" },
  { key: "services", icon: Server, label: "Services" },
  { key: "settings", icon: SettingsIcon, label: "Settings" },
];

function GlassTabItem({
  tab,
  focused,
  onPress,
}: {
  tab: (typeof TABS)[number];
  focused: boolean;
  onPress: () => void;
}) {
  // Telegram-style selector: scales 0.6→1 + fades in over 320ms (glass-tabs
  // SELECTOR_SCALE_FROM/TO/DURATION), native-driven like the original.
  const anim = useRef(new Animated.Value(focused ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: focused ? 1 : 0,
      duration: 320,
      easing: Easing.out(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [focused, anim]);

  const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });
  const color = focused ? theme.colors.tabActive : theme.colors.tabInactive;
  const Icon = tab.icon;

  return (
    <Pressable
      onPress={() => {
        try {
          void Haptics.selectionAsync();
        } catch {}
        onPress();
      }}
      style={styles.tab}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityState={focused ? { selected: true } : {}}
      accessibilityLabel={tab.label}
    >
      <Animated.View
        style={[
          styles.selector,
          {
            opacity: anim,
            transform: [{ scale }],
          },
        ]}
      />
      <View style={styles.iconWrap}>
        <Icon size={22} color={color} strokeWidth={focused ? 2.2 : 1.8} />
        {tab.badge != null && tab.badge > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{tab.badge > 99 ? "99+" : String(tab.badge)}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export function TabBar({ active, onChange }: { active: TabKey; onChange: (t: TabKey) => void }) {
  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        {/* Frosted glass: native blur where available (Expo Go OK), with the
            translucent dark fill as fallback — mirrors GlassBarNativeView
            (blurRadius 25, dark #1C1C1E @ 0.85 opacity). */}
        <BlurView intensity={70} tint="dark" style={StyleSheet.absoluteFill} />
        {TABS.map((t) => (
          <GlassTabItem key={t.key} tab={t} focused={t.key === active} onPress={() => onChange(t.key)} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 8, // glass-tabs TAB_BAR_MARGIN
    paddingBottom: 8,
    alignItems: "center",
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    height: 58,
    width: "100%",
    maxWidth: 420, // glass-tabs caps at 344 for 3–5 tabs; we carry 6
    backgroundColor: "rgba(28,28,30,0.85)", // glass-tabs DARK_BACKGROUND @ OPACITY
    borderColor: theme.colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 28, // glass-tabs CORNER_RADIUS
    overflow: "hidden",
    paddingHorizontal: 4,
  },
  tab: {
    flex: 1,
    height: "100%",
    justifyContent: "center",
    alignItems: "center",
  },
  selector: {
    position: "absolute",
    top: 5,
    bottom: 5,
    left: 5,
    right: 5,
    backgroundColor: "rgba(255,255,255,0.12)", // dark-theme take on primary @ SELECTOR_ALPHA
    borderRadius: 22,
  },
  iconWrap: { position: "relative" },
  badge: {
    position: "absolute",
    top: -6,
    right: -12,
    backgroundColor: "#FF3B30", // glass-tabs badge
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 4,
  },
  badgeText: { color: "#fff", fontSize: 10, fontFamily: theme.font.bold, textAlign: "center" },
});
