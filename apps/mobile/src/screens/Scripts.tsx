import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Plus } from "lucide-react-native";
import { theme } from "../theme";
import type { RpcClient } from "../lib/client";
import { Card } from "../components/Card";
import { ScriptCreateSheet } from "../features/scripts/ScriptCreateSheet";
import { ScriptRunSheet, type RunnableScript } from "../features/scripts/ScriptRunSheet";
import type { ScriptParam } from "../features/scripts/params";
import { Placeholder } from "./Files";

interface ScriptDef {
  id: string;
  name: string;
  command: string;
  description?: string;
  icon?: string;
  cwd?: string;
  runMode?: string;
  params?: ScriptParam[];
}

/** Short-lived scripts over `scripts.*` RPC. */
export function ScriptsScreen({ client }: { client: RpcClient | null }) {
  const [scripts, setScripts] = useState<ScriptDef[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState<RunnableScript | null>(null);

  function reload() {
    if (!client) return;
    client
      .call<ScriptDef[]>("scripts.list", {})
      .then((list) => setScripts(Array.isArray(list) ? list : []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(() => {
    if (!client) return;
    setBusy(true);
    client
      .call<ScriptDef[]>("scripts.list", {})
      .then((list) => setScripts(Array.isArray(list) ? list : []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
    const off = client.onEvent((channel, payload) => {
      if (channel === "scripts") {
        const p = payload as { type?: string };
        // list refreshes on finish so cards stay fresh; live output lives in the run sheet
        if (p.type === "finished") reload();
      }
    });
    client.subscribe("scripts.subscribe", {});
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  if (!client) return <Placeholder label="Connect to run scripts" />;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Scripts</Text>
        <Pressable onPress={() => setCreating(true)} style={styles.add} hitSlop={8}>
          <Plus size={18} color={theme.colors.foreground} />
        </Pressable>
      </View>
      {busy ? <ActivityIndicator color={theme.colors.foreground} style={{ marginTop: 16 }} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView contentContainerStyle={{ gap: 8, paddingVertical: 12 }}>
        {scripts.map((s) => (
          <Card key={s.id} onPress={() => setRunning({ id: s.id, name: s.name, description: s.description, icon: s.icon, command: s.command, params: s.params })}>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>
                  {s.icon ? `${s.icon} ` : ""}{s.name}
                </Text>
                <Text style={styles.cmd} numberOfLines={2}>
                  {s.description || s.command}
                </Text>
                {(s.params?.length ?? 0) > 0 ? (
                  <Text style={styles.inputs}>{s.params!.length} input{s.params!.length === 1 ? "" : "s"}</Text>
                ) : null}
              </View>
              <Text style={styles.chev}>›</Text>
            </View>
          </Card>
        ))}
        {scripts.length === 0 && !busy ? <Text style={styles.empty}>No scripts yet — tap + to create one.</Text> : null}
      </ScrollView>
      <ScriptCreateSheet visible={creating} client={client} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); reload(); }} />
      <ScriptRunSheet script={running} client={client} onClose={() => { setRunning(null); reload(); }} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.screen, padding: 16 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { color: theme.colors.foreground, fontSize: 26, fontFamily: theme.font.bold },
  add: { backgroundColor: theme.colors.cardAlt, borderRadius: 999, padding: 9 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  name: { color: theme.colors.foreground, fontSize: 16, fontFamily: theme.font.bold },
  cmd: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular, marginTop: 4 },
  inputs: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.medium, marginTop: 4 },
  chev: { color: theme.colors.chevron, fontSize: 22, fontFamily: theme.font.regular },
  error: { color: theme.colors.danger, fontFamily: theme.font.regular, marginTop: 8 },
  empty: { color: theme.colors.muted, fontFamily: theme.font.regular, marginTop: 16 },
});
