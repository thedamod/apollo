import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { LogOut } from "lucide-react-native";
import { theme } from "../theme";
import type { RpcClient } from "../lib/client";
import { Card } from "../components/Card";
import { Placeholder } from "./Files";

/** Bare-bones terminal over `terminal.open/write/attach`. Full pty grid (like
 *  t3code's native terminal) is out of scope for the bootstrap — this sends
 *  commands and streams output text. */
export function TerminalScreen({ client }: { client: RpcClient | null }) {
  const [sessionId] = useState("mobile");
  const [terminalId] = useState("term-1");
  const [opened, setOpened] = useState(false);
  const [input, setInput] = useState("");
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!client) return <Placeholder label="Connect to open a terminal" />;

  async function open() {
    setError(null);
    try {
      await client!.call("terminal.open", { sessionId, terminalId, cwd: "", cols: 80, rows: 24 });
      const off = client!.onEvent((channel, payload) => {
        if (channel === `terminal:${sessionId}:${terminalId}`) {
          const p = payload as { data?: string; chunk?: string } | string;
          const chunk = typeof p === "string" ? p : (p.data ?? p.chunk ?? "");
          if (chunk) setLog((l) => (l + chunk).slice(-8000));
        }
      });
      void off;
      client!.subscribe("terminal.attach", { sessionId, terminalId });
      setOpened(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function send() {
    if (!input.trim()) return;
    setError(null);
    try {
      await client!.call("terminal.write", { sessionId, terminalId, data: `${input}\r` });
      setInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Terminal</Text>
      {!opened ? (
        <Pressable style={styles.primary} onPress={open}>
          <Text style={styles.primaryLabel}>Open shell</Text>
        </Pressable>
      ) : (
        <>
          <ScrollView style={styles.term} contentContainerStyle={{ padding: 12 }}>
            <Text style={styles.termText}>{log || "(connected — type a command below)"}</Text>
          </ScrollView>
          <View style={styles.composer}>
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={setInput}
              placeholder="$ echo hello"
              placeholderTextColor={theme.colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={send}
              returnKeyType="send"
            />
            <Pressable style={styles.send} onPress={send}>
              <Text style={styles.sendLabel}>Send</Text>
            </Pressable>
          </View>
        </>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function SettingsScreen({
  baseUrl,
  tunnel,
  serverInfo,
  onDisconnect,
}: {
  baseUrl: string;
  tunnel: { provider?: string; status?: string; publicUrl?: string | null } | null;
  serverInfo: { name?: string; version?: string; uptimeSeconds?: number; port?: number } | null;
  onDisconnect: () => void;
}) {
  return (
    <ScrollView style={styles.root} contentContainerStyle={{ gap: 8, paddingBottom: 24 }}>
      <Text style={styles.title}>Settings</Text>
      <Card>
        <Text style={styles.kv}>Server</Text>
        <Text style={styles.val}>{baseUrl}</Text>
        {serverInfo ? (
          <Text style={styles.valDim}>
            {serverInfo.name ?? "home-server"} v{serverInfo.version ?? "?"} • up{" "}
            {serverInfo.uptimeSeconds ?? 0}s
          </Text>
        ) : null}
      </Card>
      <Card>
        <Text style={styles.kv}>Tunnel ({tunnel?.provider ?? "…"})</Text>
        <Text style={styles.val}>{tunnel?.status ?? "unknown"}</Text>
        {tunnel?.publicUrl ? <Text style={styles.valDim}>{tunnel.publicUrl}</Text> : null}
        <Text style={styles.hint}>
          Enabled on the server with `home-server start --tailscale` (tailscale serve → port 443).
        </Text>
      </Card>
      <Pressable style={styles.danger} onPress={onDisconnect}>
        <LogOut size={15} color={theme.colors.danger} />
        <Text style={styles.dangerLabel}>Switch server</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.screen, padding: 16 },
  title: { color: theme.colors.foreground, fontSize: 26, fontFamily: theme.font.bold, marginBottom: 12 },
  primary: { backgroundColor: "#f5f5f5", borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 16 },
  primaryLabel: { color: "#0b0b0c", fontFamily: theme.font.bold, fontSize: 15 },
  term: { backgroundColor: "#000", borderRadius: 12, marginTop: 12, maxHeight: 420 },
  termText: { color: "#d4d4d4", fontFamily: "monospace", fontSize: 12 },
  composer: { flexDirection: "row", gap: 8, marginTop: 12 },
  input: {
    flex: 1,
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 12,
    color: theme.colors.foreground,
    fontFamily: "monospace",
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  send: { backgroundColor: "#f5f5f5", borderRadius: 12, paddingHorizontal: 18, justifyContent: "center" },
  sendLabel: { color: "#0b0b0c", fontFamily: theme.font.bold },
  error: { color: theme.colors.danger, fontFamily: theme.font.regular, marginTop: 8 },
  kv: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular },
  val: { color: theme.colors.foreground, fontSize: 15, fontFamily: theme.font.medium, marginTop: 4 },
  valDim: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular, marginTop: 4 },
  hint: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular, marginTop: 8 },
  danger: { flexDirection: "row", gap: 8, justifyContent: "center", alignItems: "center", borderColor: "rgba(255,69,58,0.4)", borderWidth: 1, borderRadius: 12, paddingVertical: 13, marginTop: 8 },
  dangerLabel: { color: theme.colors.danger, fontFamily: theme.font.medium, fontSize: 14 },
});
