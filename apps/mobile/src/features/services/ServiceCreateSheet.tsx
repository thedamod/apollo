import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../../theme";
import type { RpcClient } from "../../lib/client";
import { EnvEditor, Segmented, Sheet, TextField, ToggleRow, WizardNav, slugify } from "../../components/Form";

type Kind = "systemd" | "docker" | "custom";
type Health = "auto" | "process" | "port" | "http";

interface UnitRow {
  unit: string;
  description?: string;
  activeState?: string;
  subState?: string;
  managedId?: string | null;
}
interface ContainerRow {
  name: string;
  image: string;
  state?: string;
  status?: string;
  running: boolean;
  managedId?: string | null;
}

function prettyUnit(unit: string): string {
  const base = unit.replace(/\.service$/, "").replace(/[-_]+/g, " ").trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : unit;
}

/** Progressive creation: Type → Pick → Basic → Execution → Advanced. */
export function ServiceCreateSheet({
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
  const [phase, setPhase] = useState(0);
  const [kind, setKind] = useState<Kind>("systemd");
  const [query, setQuery] = useState("");
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [containers, setContainers] = useState<ContainerRow[]>([]);
  const [pickBusy, setPickBusy] = useState(false);
  const [pickedUnit, setPickedUnit] = useState<UnitRow | null>(null);
  const [pickedContainer, setPickedContainer] = useState<ContainerRow | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [env, setEnv] = useState<Record<string, string>>({});
  const [startOnBoot, setStartOnBoot] = useState(true);
  const [startNow, setStartNow] = useState(true);
  const [autoRestart, setAutoRestart] = useState(true);
  const [maxRestarts, setMaxRestarts] = useState(5);
  const [port, setPort] = useState("");
  const [health, setHealth] = useState<Health>("auto");
  const [healthTarget, setHealthTarget] = useState("");
  const [restartDelaySec, setRestartDelaySec] = useState("");
  const [systemdUnit, setSystemdUnit] = useState("");
  const [dockerImage, setDockerImage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phases = kind === "custom" ? ["Type", "Basic", "Execution", "Advanced"] : ["Type", "Pick", "Basic", "Execution", "Advanced"];
  const current = phases[phase] ?? "Type";

  function reset() {
    setPhase(0);
    setKind("systemd");
    setQuery("");
    setUnits([]);
    setContainers([]);
    setPickedUnit(null);
    setPickedContainer(null);
    setName("");
    setDescription("");
    setCommand("");
    setCwd("");
    setEnv({});
    setStartOnBoot(true);
    setStartNow(true);
    setAutoRestart(true);
    setMaxRestarts(5);
    setPort("");
    setHealth("auto");
    setHealthTarget("");
    setRestartDelaySec("");
    setSystemdUnit("");
    setDockerImage("");
    setBusy(false);
    setError(null);
  }

  // load candidates when entering the Pick phase (debounced search)
  useEffect(() => {
    if (!visible || !client || current !== "Pick") return;
    setPickBusy(true);
    const t = setTimeout(async () => {
      try {
        if (kind === "systemd") {
          const list = (await client.call("services.discover", { userFacingOnly: false, query: query || undefined, limit: 50 })) as UnitRow[];
          setUnits(Array.isArray(list) ? list : []);
        } else {
          const list = (await client.call("services.dockerList", { query: query || undefined, limit: 50 })) as ContainerRow[];
          setContainers(Array.isArray(list) ? list : []);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPickBusy(false);
      }
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, client, current, kind, query]);

  function pickUnit(u: UnitRow) {
    setPickedUnit(u);
    setSystemdUnit(u.unit);
    if (!name.trim()) setName(prettyUnit(u.unit));
    if (u.description && !description.trim()) setDescription(u.description);
  }
  function pickContainer(c: ContainerRow) {
    setPickedContainer(c);
    setDockerImage(c.image);
    if (!name.trim()) setName(c.name);
  }

  const canNext =
    current === "Type"
      ? true
      : current === "Pick"
        ? kind === "systemd"
          ? pickedUnit !== null
          : pickedContainer !== null
        : current === "Basic"
          ? name.trim().length > 0 && (kind !== "custom" || command.trim().length > 0)
          : true;

  async function submit() {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      const portNum = port.trim() ? Number(port.trim()) : undefined;
      const delayMs = restartDelaySec.trim() ? Math.max(500, Math.round(Number(restartDelaySec) * 1000)) : undefined;
      const healthCheck =
        health === "auto"
          ? undefined
          : health === "process"
            ? { type: "process" as const }
            : { type: health, target: healthTarget.trim() || (portNum ? (health === "http" ? `http://127.0.0.1:${portNum}/` : String(portNum)) : undefined) };
      const base = {
        id: slugify(name, `svc_${Date.now().toString(36)}`),
        name: name.trim(),
        description: description.trim() || undefined,
        env: Object.keys(env).length > 0 ? env : undefined,
        port: portNum,
        autoRestart,
        maxRestarts: autoRestart ? maxRestarts : 0,
        restartDelayMs: delayMs,
        enabled: startOnBoot,
        healthCheck,
      };
      if (kind === "systemd") {
        const unit = (systemdUnit.trim() || pickedUnit?.unit) ?? "";
        await client.call("services.create", { ...base, type: "systemd", systemdUnit: unit, command: unit });
      } else if (kind === "docker") {
        const container = pickedContainer?.name ?? "";
        const image = dockerImage.trim() || pickedContainer?.image || "";
        await client.call("services.create", {
          ...base,
          type: "docker",
          dockerContainer: container,
          dockerImage: image || undefined,
          command: image || container,
        });
      } else {
        await client.call("services.create", { ...base, type: "shell", command: command.trim(), cwd: cwd.trim() || undefined });
      }
      if (startNow) {
        try {
          await client.call("services.start", { id: base.id });
        } catch (e) {
          setError(`Created, but start failed: ${e instanceof Error ? e.message : String(e)}`);
          setBusy(false);
          return;
        }
      }
      reset();
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={visible} title="New service" stepLabel={`Step ${phase + 1} of ${phases.length} — ${current}`} onClose={onClose}>
      {current === "Type" ? (
        <Segmented<Kind>
          label="What do you want to run?"
          value={kind}
          onChange={setKind}
          options={[
            { value: "systemd", label: "System service", desc: "Already installed (Jellyfin, Samba, …)." },
            { value: "docker", label: "Docker container", desc: "An existing container on this machine." },
            { value: "custom", label: "Custom command", desc: "Anything you could run in a terminal." },
          ]}
        />
      ) : null}
      {current === "Pick" ? (
        <>
          <TextField label={kind === "systemd" ? "Search services" : "Search containers"} value={query} onChange={setQuery} placeholder="type to filter…" />
          {pickBusy ? <ActivityIndicator color={theme.colors.foreground} /> : null}
          <View style={{ gap: 6 }}>
            {(kind === "systemd" ? units : []).map((u) => (
              <PickRow
                key={u.unit}
                active={pickedUnit?.unit === u.unit}
                title={prettyUnit(u.unit)}
                sub={[u.unit, u.activeState && u.subState ? `${u.activeState}/${u.subState}` : u.activeState].filter(Boolean).join("  •  ")}
                badge={u.managedId ? "added" : null}
                onPress={() => pickUnit(u)}
              />
            ))}
            {(kind === "docker" ? containers : []).map((c) => (
              <PickRow
                key={c.name}
                active={pickedContainer?.name === c.name}
                title={c.name}
                sub={[c.image, c.status || c.state].filter(Boolean).join("  •  ")}
                badge={c.managedId ? "added" : c.running ? "running" : null}
                onPress={() => pickContainer(c)}
              />
            ))}
            {!pickBusy && (kind === "systemd" ? units.length === 0 : containers.length === 0) ? (
              <Text style={styles.empty}>{kind === "docker" ? "No containers found — is Docker installed?" : "No matching services found."}</Text>
            ) : null}
          </View>
        </>
      ) : null}
      {current === "Basic" ? (
        <>
          <TextField label="Name" value={name} onChange={setName} placeholder="Jellyfin" autoCapitalize="words" />
          <TextField label="Description" value={description} onChange={setDescription} placeholder="Media server (optional)" autoCapitalize="sentences" />
          {kind === "custom" ? (
            <TextField label="Command" value={command} onChange={setCommand} placeholder="python3 -m http.server 8000" hint="Runs in a shell on the server." multiline />
          ) : null}
        </>
      ) : null}
      {current === "Execution" ? (
        <>
          <ToggleRow label="Start on boot" hint={kind === "systemd" ? "Uses the system service manager." : "Starts when the server starts."} value={startOnBoot} onChange={setStartOnBoot} />
          <ToggleRow label="Start right away" value={startNow} onChange={setStartNow} />
          <ToggleRow label="Restart if it crashes" value={autoRestart} onChange={setAutoRestart} />
          {autoRestart ? (
            <View>
              <Text style={styles.label}>Restart attempts</Text>
              <View style={styles.stepper}>
                <Pressable onPress={() => setMaxRestarts((v) => Math.max(0, v - 1))} style={styles.stepBtn}>
                  <Text style={styles.stepBtnLabel}>−</Text>
                </Pressable>
                <Text style={styles.stepVal}>{maxRestarts}</Text>
                <Pressable onPress={() => setMaxRestarts((v) => Math.min(20, v + 1))} style={styles.stepBtn}>
                  <Text style={styles.stepBtnLabel}>+</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </>
      ) : null}
      {current === "Advanced" ? (
        <>
          <TextField label="Port" value={port} onChange={setPort} placeholder="e.g. 8096 (optional)" hint="Shows a link on the service card." keyboardType="numeric" />
          <Segmented<Health>
            label="Health check"
            value={health}
            onChange={setHealth}
            options={[
              { value: "auto", label: "Automatic", desc: "Port when set, process otherwise." },
              { value: "process", label: "Process", desc: "Up while the process runs." },
              { value: "port", label: "Port", desc: "Something answers on the port." },
              { value: "http", label: "Web address", desc: "A URL returns OK." },
            ]}
          />
          {health === "port" || health === "http" ? (
            <TextField label={health === "http" ? "URL" : "Port"} value={healthTarget} onChange={setHealthTarget} placeholder={health === "http" ? "http://127.0.0.1:8096/health" : "8096"} />
          ) : null}
          {kind === "systemd" ? (
            <TextField label="Service name" value={systemdUnit} onChange={setSystemdUnit} hint="Rarely needs changing." />
          ) : null}
          {kind === "docker" ? (
            <TextField label="Image" value={dockerImage} onChange={setDockerImage} hint="Used if the container doesn't exist yet." />
          ) : null}
          {kind === "custom" ? (
            <>
              <TextField label="Working directory" value={cwd} onChange={setCwd} placeholder="/home/apollo (optional)" />
              <EnvEditor value={env} onChange={setEnv} />
            </>
          ) : null}
          <TextField label="Restart delay (seconds)" value={restartDelaySec} onChange={setRestartDelaySec} placeholder="3" keyboardType="numeric" />
        </>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <WizardNav
        step={phase}
        total={phases.length}
        busy={busy}
        canNext={canNext}
        onBack={() => setPhase((s) => Math.max(0, s - 1))}
        onNext={() => (phase === phases.length - 1 ? void submit() : setPhase((s) => s + 1))}
      />
    </Sheet>
  );
}

function PickRow({
  active,
  title,
  sub,
  badge,
  onPress,
}: {
  active: boolean;
  title: string;
  sub?: string;
  badge?: string | null;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.row, active ? styles.rowActive : null]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{title}</Text>
        {sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
      </View>
      {badge ? <Text style={styles.badge}>{badge}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.medium, marginBottom: 6 },
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
  rowActive: { borderColor: theme.colors.cpu },
  rowTitle: { color: theme.colors.foreground, fontSize: 14, fontFamily: theme.font.medium },
  rowSub: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular, marginTop: 1 },
  badge: { color: theme.colors.cpu, fontSize: 11, fontFamily: theme.font.medium },
  empty: { color: theme.colors.muted, fontFamily: theme.font.regular, fontSize: 13 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 12 },
  stepBtn: { backgroundColor: theme.colors.cardAlt, borderRadius: 999, width: 36, height: 36, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border },
  stepBtnLabel: { color: theme.colors.foreground, fontSize: 18, fontFamily: theme.font.medium },
  stepVal: { color: theme.colors.foreground, fontSize: 16, fontFamily: theme.font.bold, minWidth: 28, textAlign: "center" },
  error: { color: theme.colors.danger, fontFamily: theme.font.regular, fontSize: 13 },
});
