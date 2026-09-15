import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Plus } from "lucide-react-native";
import { theme } from "../../theme";
import type { RpcClient } from "../../lib/client";
import { EnvEditor, Segmented, Sheet, TextField, ToggleRow, WizardNav, slugify } from "../../components/Form";
import { SCRIPT_TEMPLATES } from "./scriptTemplates";
import type { ParamValues, ScriptParam } from "./params";
import { defaultParamValues, referencedParamKeys } from "./params";
import { ParamFields } from "./ParamFields";
import { ParamEditor, ParamRow } from "./ParamEditor";

const STEPS = ["Basic", "Command", "Parameters", "Schedule", "Advanced"];

type Mode = "manual" | "scheduled" | "both";
type Freq = "daily" | "weekly" | "hourly" | "quarter" | "custom";

const FREQ_CALENDAR: Record<Exclude<Freq, "custom">, string> = {
  daily: "daily",
  weekly: "weekly",
  hourly: "hourly",
  quarter: "*:0/15",
};

/** Progressive creation: Basic → Execution → Schedule → Advanced. */
export function ScriptCreateSheet({
  visible,
  client,
  onClose,
  onCreated,
}: {
  visible: boolean;
  client: RpcClient | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [step, setStep] = useState(0);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [runUser, setRunUser] = useState("");
  const [env, setEnv] = useState<Record<string, string>>({});
  const [params, setParams] = useState<ScriptParam[]>([]);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [previewOverrides, setPreviewOverrides] = useState<ParamValues>({});
  const [mode, setMode] = useState<Mode>("both");
  const [freq, setFreq] = useState<Freq>("daily");
  const [customCal, setCustomCal] = useState("");
  const [persistent, setPersistent] = useState(true);
  const [timeoutMin, setTimeoutMin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStep(0);
    setTemplateId(null);
    setName("");
    setDescription("");
    setCommand("");
    setCwd("");
    setRunUser("");
    setEnv({});
    setParams([]);
    setEditing(null);
    setPreviewOverrides({});
    setMode("both");
    setFreq("daily");
    setCustomCal("");
    setPersistent(true);
    setTimeoutMin("");
    setBusy(false);
    setError(null);
  }

  function applyTemplate(id: string | null) {
    setTemplateId(id);
    const t = SCRIPT_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    setName(t.name);
    setDescription(t.description);
    setCommand(t.command);
    setCwd(t.cwd ?? "");
    setMode(t.runMode);
    setParams(t.params ?? []);
    setPreviewOverrides({});
    if (t.onCalendar) {
      const hit = (Object.entries(FREQ_CALENDAR) as Array<[Freq, string]>).find(([, v]) => v === t.onCalendar);
      if (hit) setFreq(hit[0]);
      else {
        setFreq("custom");
        setCustomCal(t.onCalendar);
      }
    }
    if (t.persistent !== undefined) setPersistent(t.persistent);
  }

  const onCalendar = freq === "custom" ? customCal.trim() : FREQ_CALENDAR[freq];
  // step order: Basic(0) → Command(1) → Parameters(2) → Schedule(3) → Advanced(4)
  const canNext =
    step === 0 ? name.trim().length > 0 : step === 1 ? command.trim().length > 0 : step === 3 ? mode === "manual" || onCalendar.length > 0 : true;

  function updateParams(next: ScriptParam[]) {
    setParams(next);
    setPreviewOverrides({});
  }

  const previewValues: ParamValues = { ...defaultParamValues(params), ...previewOverrides };
  const missingKeys = referencedParamKeys(command).filter((k) => !params.some((p) => p.key === k));

  async function submit() {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      const envClean = Object.keys(env).length > 0 ? env : undefined;
      const timeoutMs = timeoutMin.trim() ? Math.max(1, Math.round(Number(timeoutMin) * 60_000)) : undefined;
      await client.call("scripts.upsert", {
        id: slugify(name, `scr_${Date.now().toString(36)}`),
        name: name.trim(),
        description: description.trim() || undefined,
        command: command.trim(),
        cwd: cwd.trim() || undefined,
        env: envClean,
        runUser: runUser.trim() || undefined,
        runMode: mode,
        // params travel along once the server increment lands (zod strips until then)
        params: params.length > 0 ? params : undefined,
        schedule:
          mode === "manual" ? { enabled: false } : { enabled: true, onCalendar, persistent },
        timeoutMs,
      });
      reset();
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={visible} title="New script" stepLabel={`Step ${step + 1} of ${STEPS.length} — ${STEPS[step]}`} onClose={onClose}>
      {step === 0 ? (
        <>
          <View>
            <Text style={styles.label}>Start from a template</Text>
            <View style={styles.chips}>
              <Pressable onPress={() => applyTemplate(null)} style={[styles.chip, templateId === null && styles.chipActive]}>
                <Text style={styles.chipLabel}>Blank</Text>
              </Pressable>
              {SCRIPT_TEMPLATES.map((t) => (
                <Pressable key={t.id} onPress={() => applyTemplate(t.id)} style={[styles.chip, templateId === t.id && styles.chipActive]}>
                  <Text style={styles.chipLabel}>{t.name}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <TextField label="Name" value={name} onChange={setName} placeholder="Nightly backup" autoCapitalize="words" />
          <TextField label="Description" value={description} onChange={setDescription} placeholder="What does it do?" autoCapitalize="sentences" />
        </>
      ) : null}
      {step === 1 ? (
        <>
          <TextField
            label="Command"
            value={command}
            onChange={setCommand}
            placeholder="curl http://nodemcu/cm?brightness={{brightness}}"
            hint="Runs in a shell on the server. Use {{name}} for parameters."
            multiline
          />
          {missingKeys.length > 0 ? (
            <Text style={styles.warn}>
              Referenced but not defined: {missingKeys.map((k) => `{{${k}}}`).join(", ")} — add them under Parameters.
            </Text>
          ) : null}
          <TextField label="Working directory" value={cwd} onChange={setCwd} placeholder="/home/apollo (optional)" />
          <TextField
            label="Run as user"
            value={runUser}
            onChange={setRunUser}
            placeholder="server user (default)"
            hint="Needs sudo permission for that user, or the run fails."
          />
          <EnvEditor value={env} onChange={setEnv} />
        </>
      ) : null}
      {step === 2 ? (
        <>
          <View>
            <Text style={styles.label}>Inputs — these become the Run screen</Text>
            <View style={{ gap: 6 }}>
              {params.map((p, i) => (
                <ParamRow
                  key={p.key}
                  param={p}
                  onEdit={() => setEditing(i)}
                  onDelete={() => updateParams(params.filter((_, j) => j !== i))}
                />
              ))}
              {params.length === 0 && editing === null ? (
                <Text style={styles.muted}>No inputs yet — the script runs as-is.</Text>
              ) : null}
            </View>
            {editing === null ? (
              <Pressable onPress={() => setEditing("new")} style={styles.addBtn}>
                <Plus size={14} color={theme.colors.foreground} />
                <Text style={styles.addLabel}>Add input</Text>
              </Pressable>
            ) : null}
          </View>
          {editing !== null ? (
            <ParamEditor
              initial={typeof editing === "number" ? params[editing] : null}
              takenKeys={params.filter((_, j) => j !== editing).map((p) => p.key)}
              onCancel={() => setEditing(null)}
              onSave={(p) => {
                if (typeof editing === "number") updateParams(params.map((x, j) => (j === editing ? p : x)));
                else updateParams([...params, p]);
                setEditing(null);
              }}
            />
          ) : null}
          {params.length > 0 ? (
            <View>
              <Text style={styles.label}>Preview</Text>
              <View style={styles.preview}>
                <ParamFields params={params} values={previewValues} onChange={(v) => setPreviewOverrides(v)} />
              </View>
            </View>
          ) : null}
        </>
      ) : null}
      {step === 3 ? (
        <>
          <Segmented<Mode>
            label="When should it run?"
            value={mode}
            onChange={setMode}
            options={[
              { value: "manual", label: "By hand", desc: "Only from the Run button." },
              { value: "scheduled", label: "On a schedule", desc: "Runs automatically (timer underneath)." },
              { value: "both", label: "Both", desc: "Scheduled, and runnable by hand any time." },
            ]}
          />
          {mode !== "manual" ? (
            <>
              <Segmented<Freq>
                label="How often?"
                value={freq}
                onChange={setFreq}
                options={[
                  { value: "daily", label: "Daily" },
                  { value: "weekly", label: "Weekly" },
                  { value: "hourly", label: "Hourly" },
                  { value: "quarter", label: "Every 15 min" },
                  { value: "custom", label: "Custom…" },
                ]}
              />
              {freq === "custom" ? (
                <TextField label="Schedule" value={customCal} onChange={setCustomCal} placeholder="e.g. Mon *-*-* 02:00" />
              ) : null}
              <ToggleRow label="Catch up if missed" hint="Run once after downtime or sleep." value={persistent} onChange={setPersistent} />
            </>
          ) : null}
        </>
      ) : null}
      {step === 4 ? (
        <>
          <TextField
            label="Timeout (minutes)"
            value={timeoutMin}
            onChange={setTimeoutMin}
            placeholder="none"
            hint="Stop the run if it takes longer than this."
            keyboardType="numeric"
          />
        </>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <WizardNav
        step={step}
        total={STEPS.length}
        busy={busy}
        canNext={canNext}
        onBack={() => setStep((s) => Math.max(0, s - 1))}
        onNext={() => (step === STEPS.length - 1 ? void submit() : setStep((s) => s + 1))}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  label: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.medium, marginBottom: 6 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { backgroundColor: theme.colors.cardAlt, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border },
  chipActive: { borderColor: theme.colors.cpu },
  chipLabel: { color: theme.colors.foreground, fontSize: 13, fontFamily: theme.font.medium },
  error: { color: theme.colors.danger, fontFamily: theme.font.regular, fontSize: 13 },
  warn: { color: theme.colors.link, fontFamily: theme.font.regular, fontSize: 13 },
  muted: { color: theme.colors.muted, fontFamily: theme.font.regular, fontSize: 13 },
  addBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.colors.cardAlt, borderRadius: 999, paddingVertical: 10, marginTop: 8 },
  addLabel: { color: theme.colors.foreground, fontFamily: theme.font.medium, fontSize: 13 },
  preview: { backgroundColor: theme.colors.screen, borderRadius: 14, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border },
});
