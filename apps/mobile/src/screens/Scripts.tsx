import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Play, Plus } from "lucide-react-native";
import { theme } from "../theme";
import type { RpcClient } from "../lib/client";
import { Card } from "../components/Card";
import { ScriptCreateSheet } from "../features/scripts/ScriptCreateSheet";
import { Placeholder } from "./Files";

interface ScriptDef {
  id: string;
  name: string;
  command: string;
  cwd?: string;
  runMode?: string;
}

/** Short-lived scripts over `scripts.*` RPC. */
export function ScriptsScreen({ client }: { client: RpcClient | null }) {
  const [scripts, setScripts] = useState<ScriptDef[]>([]);
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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
        const p = payload as { type?: string; content?: string; chunk?: string };
        if (typeof p.content === "string") setOutput((o) => (o + p.content).slice(-4000));
        else if (typeof p.chunk === "string") setOutput((o) => (o + p.chunk).slice(-4000));
      }
    });
    client.subscribe("scripts.subscribe", {});
    return off;
  }, [client]);

  if (!client) return <Placeholder label="Connect to run scripts" />;

  async function run(id: string) {
    if (!client) return;
    setOutput("");
    setError(null);
    try {
      const r = (await client.call("scripts.run", { id })) as { runId?: string };
      if (r?.runId) {
        const logs = (await client.call("scripts.logs", { runId: r.runId })) as { content?: string };
        if (logs?.content) setOutput(logs.content.slice(-4000));
      }
      const list = (await client.call("scripts.list", {})) as ScriptDef[];
      if (Array.isArray(list)) setScripts(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

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
          <Card key={s.id}>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{s.name}</Text>
                <Text style={styles.cmd} numberOfLines={2}>
                  {s.command}
                </Text>
              </View>
              {s.runMode !== "scheduled" ? (
                <Pressable style={styles.run} onPress={() => run(s.id)}>
                  <Play size={13} color={theme.colors.foreground} />
                  <Text style={styles.runLabel}>Run</Text>
                </Pressable>
              ) : null}
            </View>
          </Card>
        ))}
        {scripts.length === 0 && !busy ? <Text style={styles.empty}>No scripts yet — tap + to create one.</Text> : null}
        {output ? (
          <Card>
            <TextInput value={output} multiline editable={false} style={styles.log} />
          </Card>
        ) : null}
      </ScrollView>
      <ScriptCreateSheet visible={creating} client={client} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); reload(); }} />
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
  run: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.colors.cardAlt, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  runLabel: { color: theme.colors.foreground, fontFamily: theme.font.medium, fontSize: 13 },
  log: { color: theme.colors.foreground, fontFamily: theme.font.regular, fontSize: 12, minHeight: 120 },
  error: { color: theme.colors.danger, fontFamily: theme.font.regular, marginTop: 8 },
  empty: { color: theme.colors.muted, fontFamily: theme.font.regular, marginTop: 16 },
});
