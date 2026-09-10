/**
 * Environments screen — all connection settings live here (t3code
 * `SettingsEnvironmentsRouteScreen` counterpart). The onboarding
 * `ConnectScreen` stays lean; managing servers happens here.
 */
import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Check, Plus, Server as ServerIcon, X } from "lucide-react-native";
import { theme } from "../theme";
import {
  checkHealth,
  newServerId,
  parseServerUrl,
  redeemPairingUrl,
  type ServerEntry,
} from "../lib/client";

export function EnvironmentsScreen({
  servers,
  activeId,
  connError,
  onSelect,
  onForget,
  onAdded,
}: {
  servers: ServerEntry[];
  activeId: string | null;
  connError: string | null;
  onSelect: (s: ServerEntry) => void;
  onForget: (id: string) => void;
  onAdded: (s: ServerEntry) => void;
}) {
  const [mode, setMode] = useState<"pairing" | "manual">("pairing");
  const [pairingUrl, setPairingUrl] = useState("");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const shownError = localError ?? connError;

  async function add(entry: ServerEntry) {
    setWorking(true);
    setLocalError(null);
    try {
      parseServerUrl(entry.baseUrl);
      await checkHealth(entry.baseUrl);
      onAdded(entry);
      setLabel("");
      setBaseUrl("");
      setToken("");
      setPairingUrl("");
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function onPair() {
    if (!pairingUrl.trim()) {
      setLocalError("Paste the pairing URL from your server");
      return;
    }
    setWorking(true);
    setLocalError(null);
    try {
      const entry = await redeemPairingUrl(pairingUrl.trim(), label.trim() || undefined);
      await checkHealth(entry.baseUrl);
      onAdded(entry);
      setLabel("");
      setPairingUrl("");
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Environments</Text>
      <Text style={styles.sub}>
        Servers you connect to. The active environment feeds Home, Files, Terminal, Scripts, and
        Services.
      </Text>

      {servers.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            No environments yet. On your machine run{"\n"}
            <Text style={styles.mono}>home-server start --tailscale</Text>
            {"\n"}then paste the pairing URL below.
          </Text>
        </View>
      ) : (
        <View style={styles.list}>
          {servers.map((s) => {
            const active = s.id === activeId;
            return (
              <View key={s.id} style={[styles.row, active && styles.rowActive]}>
                <Pressable style={styles.rowMain} onPress={() => onSelect(s)}>
                  <ServerIcon size={20} color={theme.colors.foreground} strokeWidth={1.8} />
                  <View style={styles.rowMeta}>
                    <Text style={styles.rowLabel}>{s.label}</Text>
                    <Text style={styles.rowUrl} numberOfLines={1}>
                      {s.baseUrl}
                    </Text>
                  </View>
                  {active ? <Check size={16} color={theme.colors.dotOnline} /> : null}
                </Pressable>
                <Pressable onPress={() => onForget(s.id)} hitSlop={10} style={styles.forget}>
                  <X size={16} color={theme.colors.muted} />
                </Pressable>
              </View>
            );
          })}
        </View>
      )}

      <View style={styles.addHead}>
        <Plus size={15} color={theme.colors.secondary} />
        <Text style={styles.addTitle}>Add environment</Text>
      </View>

      <View style={styles.seg}>
        {(["pairing", "manual"] as const).map((m) => (
          <Pressable key={m} onPress={() => setMode(m)} style={[styles.segBtn, mode === m && styles.segActive]}>
            <Text style={[styles.segLabel, mode === m && styles.segLabelActive]}>
              {m === "pairing" ? "Pairing URL" : "Manual"}
            </Text>
          </Pressable>
        ))}
      </View>

      {mode === "pairing" ? (
        <>
          <TextInput
            style={styles.input}
            placeholder="Label (optional, e.g. Aether-PC)"
            placeholderTextColor={theme.colors.muted}
            value={label}
            onChangeText={setLabel}
          />
          <TextInput
            style={styles.input}
            placeholder="http://100.x.y.z:7070/pair?token=pair_…"
            placeholderTextColor={theme.colors.muted}
            value={pairingUrl}
            onChangeText={setPairingUrl}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable style={styles.primary} onPress={onPair} disabled={working}>
            {working ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryLabel}>Pair & add</Text>}
          </Pressable>
        </>
      ) : (
        <>
          <TextInput
            style={styles.input}
            placeholder="Label (e.g. home LAN)"
            placeholderTextColor={theme.colors.muted}
            value={label}
            onChangeText={setLabel}
          />
          <TextInput
            style={styles.input}
            placeholder="http://100.x.y.z:7070  or  https://aether.tail….ts.net"
            placeholderTextColor={theme.colors.muted}
            value={baseUrl}
            onChangeText={setBaseUrl}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            placeholder="hs_… token (home-server token)"
            placeholderTextColor={theme.colors.muted}
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <Pressable
            style={styles.primary}
            onPress={() => {
              if (!baseUrl.trim() || !token.trim()) {
                setLocalError("Enter both the server URL and token");
                return;
              }
              void add({ id: newServerId(), label: label.trim() || baseUrl.trim(), baseUrl: baseUrl.trim(), token: token.trim() });
            }}
            disabled={working}
          >
            {working ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryLabel}>Add environment</Text>}
          </Pressable>
        </>
      )}

      {shownError ? <Text style={styles.error}>{shownError}</Text> : null}
      <Text style={styles.hint}>
        Tip: save both your LAN address and Tailscale IP (100.x) or MagicDNS name as separate
        environments, then tap to switch.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.screen },
  content: { padding: 16, paddingBottom: 32 },
  title: { color: theme.colors.foreground, fontSize: 26, fontFamily: theme.font.bold },
  sub: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular, marginTop: 4, lineHeight: 19 },
  mono: { fontFamily: theme.font.medium, color: theme.colors.foreground },
  empty: { backgroundColor: theme.colors.card, borderRadius: theme.radius.card, padding: 18, marginTop: 14 },
  emptyText: { color: theme.colors.secondary, fontSize: 14, fontFamily: theme.font.regular, lineHeight: 22 },
  list: { gap: 8, marginTop: 14 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.card,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  rowActive: { borderColor: "rgba(48,209,88,0.45)" },
  rowMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
  rowMeta: { flex: 1 },
  rowLabel: { color: theme.colors.foreground, fontSize: 15, fontFamily: theme.font.bold },
  rowUrl: { color: theme.colors.secondary, fontSize: 12, fontFamily: theme.font.regular, marginTop: 2 },
  forget: { padding: 6 },
  addHead: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 20 },
  addTitle: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.medium },
  seg: { flexDirection: "row", backgroundColor: theme.colors.card, borderRadius: 12, padding: 4, marginTop: 12 },
  segBtn: { flex: 1, paddingVertical: 10, alignItems: "center", borderRadius: 8 },
  segActive: { backgroundColor: theme.colors.cardAlt },
  segLabel: { color: theme.colors.muted, fontFamily: theme.font.medium, fontSize: 14 },
  segLabelActive: { color: theme.colors.foreground },
  input: {
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 12,
    color: theme.colors.foreground,
    fontFamily: theme.font.regular,
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 13,
    marginTop: 12,
  },
  primary: { backgroundColor: "#f5f5f5", borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 14 },
  primaryLabel: { color: "#0b0b0c", fontFamily: theme.font.bold, fontSize: 15 },
  error: { color: theme.colors.danger, fontFamily: theme.font.regular, fontSize: 13, marginTop: 12 },
  hint: { color: theme.colors.muted, fontFamily: theme.font.regular, fontSize: 12, marginTop: 16, lineHeight: 18 },
});
