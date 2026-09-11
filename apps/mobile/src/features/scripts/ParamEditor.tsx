import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Trash2 } from "lucide-react-native";
import { theme } from "../../theme";
import { Segmented, TextField, ToggleRow } from "../../components/Form";
import type { ScriptParam, ScriptParamType } from "./params";
import { PARAM_TYPES, isValidParamKey } from "./params";

function slugKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^[^a-z_]+/, "")
    .replace(/_+/g, "_")
    .slice(0, 32);
}

const NUMERIC: ScriptParamType[] = ["slider", "number"];

/** Add / edit a single parameter definition. */
export function ParamEditor({
  initial,
  takenKeys,
  onSave,
  onCancel,
}: {
  initial: ScriptParam | null;
  takenKeys: string[];
  onSave: (p: ScriptParam) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<ScriptParamType>(initial?.type ?? "slider");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [key, setKey] = useState(initial?.key ?? "");
  const [keyTouched, setKeyTouched] = useState(!!initial);
  const [def, setDef] = useState(
    initial?.defaultValue !== undefined ? String(initial.defaultValue) : "",
  );
  const [min, setMin] = useState(initial?.min !== undefined ? String(initial.min) : "");
  const [max, setMax] = useState(initial?.max !== undefined ? String(initial.max) : "");
  const [step, setStep] = useState(initial?.step !== undefined ? String(initial.step) : "");
  const [unit, setUnit] = useState(initial?.unit ?? "");
  const [required, setRequired] = useState(initial?.required ?? false);
  const [optionsText, setOptionsText] = useState(
    (initial?.options ?? []).map((o) => (o.label === o.value ? o.value : `${o.value} | ${o.label}`)).join("\n"),
  );
  const [hint, setHint] = useState(initial?.hint ?? "");
  const [error, setError] = useState<string | null>(null);

  function onLabelChange(v: string) {
    setLabel(v);
    if (!keyTouched) setKey(slugKey(v));
  }

  function save() {
    const k = key.trim();
    if (!label.trim()) return setError("Give it a label.");
    if (!isValidParamKey(k)) return setError("Key must be like brightness (letters, digits, _).");
    if (takenKeys.includes(k)) return setError(`Key “${k}” is already used.`);
    const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
    const parsed: ScriptParam = {
      key: k,
      type,
      label: label.trim(),
      required,
      hint: hint.trim() || undefined,
    };
    if (NUMERIC.includes(type)) {
      const nmin = num(min);
      const nmax = num(max);
      if (min.trim() && !Number.isFinite(nmin)) return setError("Min must be a number.");
      if (max.trim() && !Number.isFinite(nmax)) return setError("Max must be a number.");
      if (nmin !== undefined) parsed.min = nmin;
      if (nmax !== undefined) parsed.max = nmax;
      const nstep = num(step);
      if (step.trim() && (!Number.isFinite(nstep) || nstep! <= 0)) return setError("Step must be positive.");
      if (nstep !== undefined) parsed.step = nstep;
      if (unit.trim()) parsed.unit = unit.trim();
      if (def.trim()) {
        const d = Number(def);
        if (!Number.isFinite(d)) return setError("Default must be a number.");
        parsed.defaultValue = d;
      }
    } else if (type === "toggle") {
      parsed.defaultValue = def.trim() === "true" || def.trim() === "1";
    } else if (type === "select") {
      const opts = optionsText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [v, ...rest] = l.split("|");
          const value = v.trim();
          const lbl = rest.join("|").trim() || value;
          return { value, label: lbl };
        })
        .filter((o) => o.value);
      if (opts.length === 0) return setError("Add at least one option.");
      parsed.options = opts;
      if (def.trim()) {
        if (!opts.some((o) => o.value === def.trim())) return setError("Default must be one of the options.");
        parsed.defaultValue = def.trim();
      }
    } else {
      if (def.trim()) parsed.defaultValue = def.trim();
      if (type === "color" && def.trim() && !/^#[0-9a-fA-F]{6}$/.test(def.trim()))
        return setError("Color default must be #rrggbb.");
    }
    onSave(parsed);
  }

  return (
    <View style={styles.box}>
      <Segmented<ScriptParamType>
        label="Control type"
        value={type}
        onChange={setType}
        options={PARAM_TYPES.map((t) => ({ value: t.value, label: t.label, desc: t.desc }))}
      />
      <TextField label="Label" value={label} onChange={onLabelChange} placeholder="Brightness" autoCapitalize="words" />
      <TextField
        label="Variable key"
        value={key}
        onChange={(v) => { setKey(v); setKeyTouched(true); }}
        placeholder="brightness"
        hint="Use it in the command as {{brightness}}."
      />
      {type === "select" ? (
        <TextField
          label="Options"
          value={optionsText}
          onChange={setOptionsText}
          placeholder={"warm\ncold | Cool white"}
          hint="One per line — value, or value | Label."
          multiline
        />
      ) : null}
      {NUMERIC.includes(type) ? (
        <>
          <View style={styles.numGrid}>
            <View style={{ flex: 1 }}>
              <TextField label="Min" value={min} onChange={setMin} placeholder="0" keyboardType="numeric" />
            </View>
            <View style={{ flex: 1 }}>
              <TextField label="Max" value={max} onChange={setMax} placeholder="100" keyboardType="numeric" />
            </View>
            <View style={{ flex: 1 }}>
              <TextField label="Step" value={step} onChange={setStep} placeholder="1" keyboardType="numeric" />
            </View>
          </View>
          <TextField label="Unit" value={unit} onChange={setUnit} placeholder="%, °C, min…" />
        </>
      ) : null}
      <TextField
        label="Default"
        value={def}
        onChange={setDef}
        placeholder={type === "toggle" ? "false" : type === "color" ? "#ffffff" : "optional"}
        hint={type === "toggle" ? "true or false" : undefined}
      />
      <ToggleRow label="Required" hint="Must be filled before running." value={required} onChange={setRequired} />
      <TextField label="Hint" value={hint} onChange={setHint} placeholder="Shown under the control (optional)" autoCapitalize="sentences" />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.nav}>
        <Pressable onPress={onCancel} style={styles.navBtn}>
          <Text style={styles.navLabel}>Cancel</Text>
        </Pressable>
        <Pressable onPress={save} style={[styles.navBtn, styles.navPrimary]}>
          <Text style={[styles.navLabel, styles.navPrimaryLabel]}>{initial ? "Save" : "Add"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function ParamRow({
  param,
  onEdit,
  onDelete,
}: {
  param: ScriptParam;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const typeLabel = PARAM_TYPES.find((t) => t.value === param.type)?.label ?? param.type;
  return (
    <Pressable onPress={onEdit} style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{param.label}</Text>
        <Text style={styles.rowSub}>
          {typeLabel} · {`{{${param.key}}}`}
          {param.required ? " · required" : ""}
        </Text>
      </View>
      <Pressable onPress={onDelete} style={styles.del} hitSlop={10}>
        <Trash2 size={15} color={theme.colors.danger} />
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { gap: 14, backgroundColor: theme.colors.cardAlt, borderRadius: 14, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border },
  numGrid: { flexDirection: "row", gap: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.colors.cardAlt,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rowTitle: { color: theme.colors.foreground, fontSize: 14, fontFamily: theme.font.medium },
  rowSub: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular, marginTop: 1 },
  del: { padding: 6 },
  error: { color: theme.colors.danger, fontFamily: theme.font.regular, fontSize: 13 },
  nav: { flexDirection: "row", gap: 8 },
  navBtn: { flex: 1, backgroundColor: theme.colors.card, borderRadius: 999, paddingVertical: 10, alignItems: "center" },
  navPrimary: { backgroundColor: theme.colors.foreground },
  navLabel: { color: theme.colors.foreground, fontFamily: theme.font.medium, fontSize: 14 },
  navPrimaryLabel: { color: "#0b0b0c" },
});
