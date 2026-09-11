import React, { useState } from "react";
import { Modal, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import Slider from "@react-native-community/slider";
import { Picker } from "@react-native-picker/picker";
import ColorPicker, { HueSlider, Panel1, Preview } from "reanimated-color-picker";
import { ChevronDown, FolderOpen, Minus, Plus } from "lucide-react-native";
import { theme } from "../../theme";
import type { ParamValues, ScriptParam } from "./params";
import { serializeParamValue } from "./params";

/**
 * Runtime controls generated from a parameter schema.
 * Dark/minimal styling matched to the app theme throughout.
 */
export function ParamFields({
  params,
  values,
  onChange,
  errors,
}: {
  params: ScriptParam[];
  values: ParamValues;
  onChange: (values: ParamValues) => void;
  errors?: Record<string, string>;
}) {
  function set(key: string, v: string | number | boolean) {
    onChange({ ...values, [key]: v });
  }
  return (
    <View style={{ gap: 12 }}>
      {params.map((p) => (
        <ParamField key={p.key} param={p} value={values[p.key]} error={errors?.[p.key]} onChange={(v) => set(p.key, v)} />
      ))}
    </View>
  );
}

function Label({ param, right }: { param: ScriptParam; right?: string }) {
  return (
    <View style={styles.labelRow}>
      <Text style={styles.label}>{param.label}</Text>
      {right ? <Text style={styles.value}>{right}</Text> : null}
    </View>
  );
}

function Hint({ text }: { text?: string }) {
  if (!text) return null;
  return <Text style={styles.hint}>{text}</Text>;
}

function Err({ text }: { text?: string }) {
  if (!text) return null;
  return <Text style={styles.error}>{text}</Text>;
}

function ParamField({
  param,
  value,
  error,
  onChange,
}: {
  param: ScriptParam;
  value: string | number | boolean | undefined;
  error?: string;
  onChange: (v: string | number | boolean) => void;
}) {
  switch (param.type) {
    case "slider": {
      const min = param.min ?? 0;
      const max = param.max ?? 100;
      const step = param.step ?? 1;
      const num = typeof value === "number" ? value : Number(value ?? min);
      const shown = `${Number.isFinite(num) ? num : min}${param.unit ? ` ${param.unit}` : ""}`;
      return (
        <View>
          <Label param={param} right={shown} />
          <Slider
            value={Number.isFinite(num) ? num : min}
            minimumValue={min}
            maximumValue={max}
            step={step}
            onValueChange={(v) => onChange(Math.round(v / step) * step)}
            minimumTrackTintColor={theme.colors.cpu}
            maximumTrackTintColor={theme.colors.cardAlt}
            thumbTintColor={theme.colors.foreground}
            style={styles.slider}
          />
          <Hint text={param.hint} />
          <Err text={error} />
        </View>
      );
    }
    case "number": {
      const step = param.step ?? 1;
      const num = typeof value === "number" ? value : Number(value ?? param.min ?? 0);
      const bump = (dir: 1 | -1) => {
        const base = Number.isFinite(num) ? num : (param.min ?? 0);
        let next = base + dir * step;
        if (param.min !== undefined) next = Math.max(param.min, next);
        if (param.max !== undefined) next = Math.min(param.max, next);
        onChange(next);
      };
      return (
        <View>
          <Label param={param} />
          <View style={styles.numberRow}>
            <Pressable onPress={() => bump(-1)} style={styles.stepBtn} hitSlop={8}>
              <Minus size={15} color={theme.colors.foreground} />
            </Pressable>
            <TextInput
              value={Number.isFinite(num) ? String(num) : ""}
              onChangeText={(t) => {
                if (t.trim() === "") return onChange("");
                const n = Number(t);
                if (Number.isFinite(n)) onChange(n);
              }}
              keyboardType="numeric"
              placeholderTextColor={theme.colors.tertiary}
              placeholder={param.placeholder ?? String(param.min ?? "")}
              style={[styles.input, { flex: 1, textAlign: "center" }]}
            />
            <Pressable onPress={() => bump(1)} style={styles.stepBtn} hitSlop={8}>
              <Plus size={15} color={theme.colors.foreground} />
            </Pressable>
          </View>
          <Hint text={[param.unit ? `Unit: ${param.unit}` : null, param.hint].filter(Boolean).join(" — ")} />
          <Err text={error} />
        </View>
      );
    }
    case "toggle": {
      const on = value === true || value === "true" || value === 1 || value === "1";
      return (
        <View>
          <Pressable onPress={() => onChange(!on)} style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>{param.label}</Text>
              {param.hint ? <Text style={styles.hint}>{param.hint}</Text> : null}
            </View>
            <Switch value={on} onValueChange={onChange} trackColor={{ true: theme.colors.cpu }} />
          </Pressable>
          <Err text={error} />
        </View>
      );
    }
    case "select": {
      const opts = param.options ?? [];
      const current = opts.find((o) => o.value === serializeParamValue(value)) ?? opts[0];
      return (
        <SelectField param={param} value={serializeParamValue(value)} error={error} onChange={onChange} currentLabel={current?.label} />
      );
    }
    case "color": {
      const hex = /^#[0-9a-fA-F]{6}$/.test(String(value ?? "")) ? String(value) : "#ffffff";
      return <ColorField param={param} value={hex} error={error} onChange={onChange} />;
    }
    case "file": {
      return (
        <View>
          <Label param={param} />
          <View style={styles.fileRow}>
            <FolderOpen size={15} color={theme.colors.muted} />
            <TextInput
              value={String(value ?? "")}
              onChangeText={onChange}
              placeholder={param.placeholder ?? "/path/on/server"}
              placeholderTextColor={theme.colors.tertiary}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { flex: 1, borderWidth: 0, backgroundColor: "transparent", paddingVertical: 0 }]}
            />
          </View>
          <Hint text={param.hint ?? "Path on the server, not this phone."} />
          <Err text={error} />
        </View>
      );
    }
    case "text":
    default: {
      return (
        <View>
          <Label param={param} />
          <TextInput
            value={String(value ?? "")}
            onChangeText={onChange}
            placeholder={param.placeholder}
            placeholderTextColor={theme.colors.tertiary}
            autoCapitalize="sentences"
            style={styles.input}
          />
          <Hint text={param.hint} />
          <Err text={error} />
        </View>
      );
    }
  }
}

function SelectField({
  param,
  value,
  currentLabel,
  error,
  onChange,
}: {
  param: ScriptParam;
  value: string;
  currentLabel?: string;
  error?: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <View>
      <Text style={styles.label}>{param.label}</Text>
      <Pressable onPress={() => { setDraft(value); setOpen(true); }} style={styles.selectRow}>
        <Text style={styles.selectValue}>{currentLabel ?? value ?? "Select…"}</Text>
        <ChevronDown size={15} color={theme.colors.muted} />
      </Pressable>
      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <View style={styles.modalOverlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setOpen(false)} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{param.label}</Text>
            <Picker selectedValue={draft} onValueChange={setDraft} style={styles.picker} itemStyle={styles.pickerItem}>
              {(param.options ?? []).map((o) => (
                <Picker.Item key={o.value} label={o.label} value={o.value} color={theme.colors.foreground} />
              ))}
            </Picker>
            <View style={styles.modalNav}>
              <Pressable onPress={() => setOpen(false)} style={styles.navBtn}>
                <Text style={styles.navLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => { onChange(draft); setOpen(false); }}
                style={[styles.navBtn, styles.navPrimary]}
              >
                <Text style={[styles.navLabel, styles.navPrimaryLabel]}>Done</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <Hint text={param.hint} />
      <Err text={error} />
    </View>
  );
}

function ColorField({
  param,
  value,
  error,
  onChange,
}: {
  param: ScriptParam;
  value: string;
  error?: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <View>
      <Text style={styles.label}>{param.label}</Text>
      <Pressable onPress={() => { setDraft(value); setOpen(true); }} style={styles.selectRow}>
        <View style={[styles.swatch, { backgroundColor: value }]} />
        <Text style={styles.selectValue}>{value}</Text>
      </Pressable>
      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <View style={styles.modalOverlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setOpen(false)} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{param.label}</Text>
            <ColorPicker
              value={draft}
              onCompleteJS={({ hex }) => setDraft(hex)}
              style={{ gap: 12, width: "100%" }}
            >
              <Preview style={{ height: 44, borderRadius: 12 }} />
              <Panel1 style={{ height: 160, borderRadius: 12 }} />
              <HueSlider style={{ height: 28, borderRadius: 14 }} />
            </ColorPicker>
            <View style={styles.modalNav}>
              <Pressable onPress={() => setOpen(false)} style={styles.navBtn}>
                <Text style={styles.navLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => { onChange(draft); setOpen(false); }}
                style={[styles.navBtn, styles.navPrimary]}
              >
                <Text style={[styles.navLabel, styles.navPrimaryLabel]}>Done</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <Hint text={param.hint} />
      <Err text={error} />
    </View>
  );
}

const styles = StyleSheet.create({
  labelRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 },
  label: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.medium, marginBottom: 6 },
  value: { color: theme.colors.foreground, fontSize: 13, fontFamily: theme.font.bold },
  hint: { color: theme.colors.tertiary, fontSize: 12, fontFamily: theme.font.regular, marginTop: 4 },
  error: { color: theme.colors.danger, fontSize: 12, fontFamily: theme.font.regular, marginTop: 4 },
  slider: { height: 36 },
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
  numberRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  stepBtn: { backgroundColor: theme.colors.cardAlt, borderRadius: 999, width: 36, height: 36, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border },
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
  toggleLabel: { color: theme.colors.foreground, fontSize: 14, fontFamily: theme.font.medium },
  selectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.colors.cardAlt,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  selectValue: { flex: 1, color: theme.colors.foreground, fontSize: 15, fontFamily: theme.font.regular },
  swatch: { width: 22, height: 22, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.colors.cardAlt,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modalCard: { backgroundColor: theme.colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, paddingBottom: 28, gap: 12 },
  modalTitle: { color: theme.colors.foreground, fontSize: 16, fontFamily: theme.font.bold },
  picker: { backgroundColor: theme.colors.cardAlt, borderRadius: 12 },
  pickerItem: { color: theme.colors.foreground },
  modalNav: { flexDirection: "row", gap: 8 },
  navBtn: { flex: 1, backgroundColor: theme.colors.cardAlt, borderRadius: 999, paddingVertical: 11, alignItems: "center" },
  navPrimary: { backgroundColor: theme.colors.foreground },
  navLabel: { color: theme.colors.foreground, fontFamily: theme.font.medium, fontSize: 14 },
  navPrimaryLabel: { color: "#0b0b0c" },
});
