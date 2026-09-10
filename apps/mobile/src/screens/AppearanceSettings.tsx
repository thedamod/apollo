/**
 * Appearance settings — t3code `SettingsAppearanceRouteScreen` + its four
 * sections (Theme / Text / Terminal / Code) ported to this app's stack.
 */
import React from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { theme } from "../theme";
import {
  CODE_FONT_SIZE_STEP,
  MAX_BASE_FONT_SIZE,
  MAX_CODE_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_BASE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  type ThemeMode,
} from "../lib/appearance";
import { useAppearancePreferences } from "../features/appearance/AppearanceContext";
import { getMobileTerminalTheme } from "../features/terminal/terminalTheme";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Stepper({
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <View style={styles.stepper}>
      <Pressable
        style={styles.stepBtn}
        accessibilityLabel="Decrease font size"
        onPress={() => onChange(Math.max(min, Math.round((value - step) * 10) / 10))}
      >
        <Text style={styles.stepLabel}>−</Text>
      </Pressable>
      <Text style={styles.stepValue}>{format(value)}</Text>
      <Pressable
        style={styles.stepBtn}
        accessibilityLabel="Increase font size"
        onPress={() => onChange(Math.min(max, Math.round((value + step) * 10) / 10))}
      >
        <Text style={styles.stepLabel}>+</Text>
      </Pressable>
    </View>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

function ThemeAppearanceSection() {
  const { themeMode, themeAppearance, setThemeMode } = useAppearancePreferences();
  const modes: Array<{ id: ThemeMode; label: string; hint: string }> = [
    { id: "system", label: "System", hint: `Follows device (${themeAppearance})` },
    { id: "light", label: "Light", hint: "Light terminal + surfaces" },
    { id: "dark", label: "Dark", hint: "Dark terminal + surfaces" },
  ];
  return (
    <Section title="Theme">
      {modes.map((m) => {
        const active = themeMode === m.id;
        return (
          <Pressable
            key={m.id}
            style={[styles.row, active && styles.rowActive]}
            onPress={() => setThemeMode(m.id)}
          >
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>{m.label}</Text>
              <Text style={styles.rowHint}>{m.hint}</Text>
            </View>
            <View style={[styles.radio, active && styles.radioActive]}>
              {active ? <View style={styles.radioDot} /> : null}
            </View>
          </Pressable>
        );
      })}
    </Section>
  );
}

function TextAppearanceSection() {
  const { appearance, setBaseFontSize } = useAppearancePreferences();
  return (
    <Section title="Text">
      <View style={[styles.row, styles.previewWrap]}>
        <Text style={{ color: theme.colors.foreground, fontSize: appearance.baseFontSize }}>
          The quick brown fox jumps over the lazy dog.
        </Text>
        <Text style={[styles.rowHint, { fontSize: Math.max(10, Math.round(appearance.baseFontSize * 0.85)) }]}>
          Messages, labels, and headings scale with this size.
        </Text>
      </View>
      <View style={styles.divider} />
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={styles.rowLabel}>Base font size</Text>
          <Text style={styles.rowHint}>Interface text scaling</Text>
        </View>
        <Stepper
          value={appearance.baseFontSize}
          min={MIN_BASE_FONT_SIZE}
          max={MAX_BASE_FONT_SIZE}
          step={1}
          format={(v) => `${v} pt`}
          onChange={setBaseFontSize}
        />
      </View>
    </Section>
  );
}

function TerminalAppearancePreview({ fontSize }: { fontSize: number }) {
  const { themeAppearance: scheme, preferences } = useAppearancePreferences();
  const t = getMobileTerminalTheme(preferences.themeMode, scheme);
  const lineHeight = Math.round(fontSize * 1.6);
  const mono = { fontFamily: "monospace", fontSize, lineHeight } as const;
  return (
    <View style={[styles.previewWrap, { backgroundColor: t.background, borderRadius: 8 }]}>
      <Text style={[mono, { color: t.foreground }]}>
        <Text style={[mono, { color: t.palette[2] }]}>→ </Text>
        <Text style={[mono, { color: t.palette[6] }]}>aether </Text>
        <Text style={[mono, { color: t.palette[4] }]}>git:(</Text>
        <Text style={[mono, { color: t.palette[1] }]}>main</Text>
        <Text style={[mono, { color: t.palette[4] }]}>)</Text>
        <Text style={[mono, { color: t.palette[3] }]}> ✗</Text>
        <Text style={[mono, { color: t.foreground }]}> home-server start</Text>
      </Text>
      <Text style={[mono, { color: t.foreground }]}>
        <Text style={[mono, { color: t.palette[2] }]}>✓ up</Text>
        <Text style={[mono, { color: t.mutedForeground }]}> listening on</Text>
        <Text style={[mono, { color: t.foreground }]}> :7070</Text>
      </Text>
      <Text style={[mono, { color: t.foreground }]}>
        <Text style={[mono, { backgroundColor: t.palette[2], color: t.background }]}>{" READY "}</Text>
        <Text style={[mono, { color: t.mutedForeground }]}> watching for changes</Text>{" "}
        <Text style={[mono, { color: t.cursorForeground }]}>▏</Text>
      </Text>
    </View>
  );
}

function TerminalAppearanceSection() {
  const { isReady, appearance, setTerminalFontSize } = useAppearancePreferences();
  const custom = appearance.isTerminalFontSizeCustom;
  return (
    <Section title="Terminal">
      <TerminalAppearancePreview fontSize={appearance.terminalFontSize} />
      <View style={styles.divider} />
      <ToggleRow
        label="Custom font size"
        hint={custom ? "Using custom size" : "Derived from base text size"}
        value={custom}
        onChange={(enabled) => setTerminalFontSize(enabled ? appearance.terminalFontSize : null)}
      />
      {custom ? (
        <>
          <View style={styles.divider} />
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>Font size</Text>
              <Text style={styles.rowHint}>Terminal grid text</Text>
            </View>
            <Stepper
              value={appearance.terminalFontSize}
              min={MIN_TERMINAL_FONT_SIZE}
              max={MAX_TERMINAL_FONT_SIZE}
              step={0.5}
              format={(v) => `${v.toFixed(1)} pt`}
              onChange={(v) => isReady && setTerminalFontSize(v)}
            />
          </View>
        </>
      ) : null}
    </Section>
  );
}

function CodeAppearanceSection() {
  const { appearance, setCodeFontSize, setCodeWordBreak } = useAppearancePreferences();
  const custom = appearance.isCodeFontSizeCustom;
  return (
    <Section title="Code">
      <View style={styles.previewWrap}>
        <Text style={{ fontFamily: "monospace", fontSize: appearance.codeFontSize, color: theme.colors.foreground }}>
          {"function formatUser(user) {"}
        </Text>
        <Text
          style={{ fontFamily: "monospace", fontSize: appearance.codeFontSize, color: theme.colors.foreground }}
          numberOfLines={appearance.codeWordBreak ? undefined : 1}
        >
          {"  return `${user.name} <${user.email}>` // long lines wrap when word break is on"}
        </Text>
        <Text style={{ fontFamily: "monospace", fontSize: appearance.codeFontSize, color: theme.colors.foreground }}>
          {"}"}
        </Text>
      </View>
      <View style={styles.divider} />
      <ToggleRow
        label="Custom font size"
        hint={custom ? "Using custom size" : "Derived from base text size"}
        value={custom}
        onChange={(enabled) => setCodeFontSize(enabled ? appearance.codeFontSize : null)}
      />
      {custom ? (
        <>
          <View style={styles.divider} />
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>Font size</Text>
              <Text style={styles.rowHint}>File + log surfaces</Text>
            </View>
            <Stepper
              value={appearance.codeFontSize}
              min={MIN_CODE_FONT_SIZE}
              max={MAX_CODE_FONT_SIZE}
              step={CODE_FONT_SIZE_STEP}
              format={(v) => `${v} pt`}
              onChange={setCodeFontSize}
            />
          </View>
        </>
      ) : null}
      <View style={styles.divider} />
      <ToggleRow
        label="Word break"
        hint="Wrap long lines instead of scrolling"
        value={appearance.codeWordBreak}
        onChange={setCodeWordBreak}
      />
    </Section>
  );
}

export function AppearanceSettingsScreen() {
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Appearance</Text>
      <ThemeAppearanceSection />
      <TextAppearanceSection />
      <TerminalAppearanceSection />
      <CodeAppearanceSection />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.screen },
  content: { padding: 16, paddingBottom: 32, gap: 20 },
  title: { color: theme.colors.foreground, fontSize: 26, fontFamily: theme.font.bold },
  section: { gap: 8 },
  sectionTitle: {
    color: theme.colors.secondary,
    fontSize: 13,
    fontFamily: theme.font.medium,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    paddingHorizontal: 4,
  },
  card: { backgroundColor: theme.colors.card, borderRadius: theme.radius.card, overflow: "hidden" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  rowActive: { backgroundColor: theme.colors.cardAlt },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { color: theme.colors.foreground, fontSize: 15, fontFamily: theme.font.medium },
  rowHint: { color: theme.colors.secondary, fontSize: 12, fontFamily: theme.font.regular },
  divider: { height: 1, backgroundColor: theme.colors.border, marginLeft: 16 },
  previewWrap: { flexDirection: "column", alignItems: "stretch", gap: 4, padding: 16 },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 99,
    borderWidth: 2,
    borderColor: theme.colors.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  radioActive: { borderColor: theme.colors.foreground },
  radioDot: { width: 10, height: 10, borderRadius: 99, backgroundColor: theme.colors.foreground },
  stepper: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepBtn: {
    backgroundColor: theme.colors.cardAlt,
    borderRadius: 8,
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  stepLabel: { color: theme.colors.foreground, fontSize: 16, fontFamily: theme.font.bold },
  stepValue: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 13, minWidth: 52, textAlign: "center" },
});
