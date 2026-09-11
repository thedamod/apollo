import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { X } from "lucide-react-native";
import { theme } from "../theme";

/**
 * Shared creation-flow primitives: bottom sheet + compact fields.
 * Kept deliberately small — pill buttons, hairline rows, no large CTAs.
 */

export function Sheet({
  visible,
  title,
  stepLabel,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  stepLabel?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.dismiss} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{title}</Text>
              {stepLabel ? <Text style={styles.step}>{stepLabel}</Text> : null}
            </View>
            <Pressable onPress={onClose} style={styles.x} hitSlop={12}>
              <X size={18} color={theme.colors.muted} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ gap: 14, paddingBottom: 8 }} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      {children}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  multiline,
  autoCapitalize,
  keyboardType,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  multiline?: boolean;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  keyboardType?: "default" | "numeric";
}) {
  return (
    <Field label={label} hint={hint}>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.tertiary}
        multiline={multiline}
        autoCapitalize={autoCapitalize ?? "none"}
        autoCorrect={false}
        keyboardType={keyboardType ?? "default"}
        style={[styles.input, multiline ? styles.inputMulti : null]}
      />
    </Field>
  );
}

export function Segmented<T extends string>({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  options: Array<{ value: T; label: string; desc?: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <View style={styles.segList}>
        {options.map((o) => {
          const active = o.value === value;
          return (
            <Pressable
              key={o.value}
              onPress={() => onChange(o.value)}
              style={[styles.segRow, active ? styles.segRowActive : null]}
            >
              <View style={[styles.radio, active ? styles.radioActive : null]}>
                {active ? <View style={styles.radioDot} /> : null}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.segLabel}>{o.label}</Text>
                {o.desc ? <Text style={styles.segDesc}>{o.desc}</Text> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </Field>
  );
}

export function ToggleRow({
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
    <Pressable onPress={() => onChange(!value)} style={styles.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.segLabel}>{label}</Text>
        {hint ? <Text style={styles.segDesc}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: theme.colors.cpu }} />
    </Pressable>
  );
}

export function ChipRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label={label}>
      <View style={styles.chips}>
        {options.map((o) => {
          const active = o === value;
          return (
            <Pressable key={o || "none"} onPress={() => onChange(o)} style={[styles.chip, active ? styles.chipActive : null]}>
              <Text style={styles.chipLabel}>{o || "–"}</Text>
            </Pressable>
          );
        })}
      </View>
    </Field>
  );
}

/** Multiline KEY=value editor → record. */
export function EnvEditor({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const text = React.useMemo(() => Object.entries(value).map(([k, v]) => `${k}=${v}`).join("\n"), [value]);
  return (
    <TextField
      label="Environment variables"
      value={text}
      onChange={(t) => onChange(parseEnv(t))}
      placeholder={"KEY=value\none per line"}
      hint="Optional — passed to the command."
      multiline
      autoCapitalize="characters"
    />
  );
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    if (k) out[k] = t.slice(i + 1).trim();
  }
  return out;
}

export function WizardNav({
  step,
  total,
  onBack,
  onNext,
  nextLabel,
  busy,
  canNext,
}: {
  step: number;
  total: number;
  onBack: () => void;
  onNext: () => void;
  nextLabel?: string;
  busy?: boolean;
  canNext?: boolean;
}) {
  const last = step === total - 1;
  return (
    <View style={styles.nav}>
      {step > 0 ? (
        <Pressable onPress={onBack} style={styles.navBtn}>
          <Text style={styles.navLabel}>Back</Text>
        </Pressable>
      ) : (
        <View style={{ flex: 1 }} />
      )}
      <Pressable
        onPress={onNext}
        disabled={busy || canNext === false}
        style={[styles.navBtn, styles.navPrimary, (busy || canNext === false) && { opacity: 0.5 }]}
      >
        <Text style={[styles.navLabel, styles.navPrimaryLabel]}>{busy ? "Saving…" : (nextLabel ?? (last ? "Create" : "Next"))}</Text>
      </Pressable>
    </View>
  );
}

/** "id" from a name: lowercase slug, server-compatible. */
export function slugify(name: string, fallback: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || fallback;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  dismiss: { flex: 1 },
  sheet: {
    backgroundColor: theme.colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    maxHeight: "88%",
    padding: 16,
    paddingBottom: 24,
    gap: 12,
  },
  header: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  title: { color: theme.colors.foreground, fontSize: 19, fontFamily: theme.font.bold },
  step: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular, marginTop: 2 },
  x: { backgroundColor: theme.colors.cardAlt, borderRadius: 999, padding: 8 },
  label: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.medium, marginBottom: 6 },
  hint: { color: theme.colors.tertiary, fontSize: 12, fontFamily: theme.font.regular, marginTop: 4 },
  input: {
    backgroundColor: theme.colors.cardAlt,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    color: theme.colors.foreground,
    fontFamily: theme.font.regular,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  inputMulti: { minHeight: 76, textAlignVertical: "top", fontSize: 13 },
  segList: { gap: 6 },
  segRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.colors.cardAlt,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  segRowActive: { borderColor: theme.colors.cpu },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: theme.colors.muted, alignItems: "center", justifyContent: "center" },
  radioActive: { borderColor: theme.colors.cpu },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.cpu },
  segLabel: { color: theme.colors.foreground, fontSize: 14, fontFamily: theme.font.medium },
  segDesc: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular, marginTop: 1 },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.colors.cardAlt,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { backgroundColor: theme.colors.cardAlt, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border },
  chipActive: { borderColor: theme.colors.cpu },
  chipLabel: { color: theme.colors.foreground, fontSize: 15, fontFamily: theme.font.regular },
  nav: { flexDirection: "row", gap: 8, marginTop: 4 },
  navBtn: { flex: 1, backgroundColor: theme.colors.cardAlt, borderRadius: 999, paddingVertical: 11, alignItems: "center" },
  navPrimary: { backgroundColor: theme.colors.foreground },
  navLabel: { color: theme.colors.foreground, fontFamily: theme.font.medium, fontSize: 14 },
  navPrimaryLabel: { color: "#0b0b0c" },
});
