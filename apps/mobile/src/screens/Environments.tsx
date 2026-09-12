/**
 * Environments — 1:1 replica of t3code mobile `ConnectionsRouteScreen` +
 * `ConnectionEnvironmentRow` + `ConnectionsNewRouteScreen` card.
 *
 * Visual spec sourced from:
 *  - context/t3code/apps/mobile/src/features/connection/ConnectionsRouteScreen.tsx
 *  - context/t3code/apps/mobile/src/features/connection/ConnectionEnvironmentRow.tsx
 *  - context/t3code/apps/mobile/src/features/connection/ConnectionStatusDot.tsx
 *  - context/t3code/apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx
 *  - context/t3code/packages/client-runtime/src/connection/presentation.ts
 *  - context/t3code/apps/mobile/global.css (dark tokens)
 */
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Check, ChevronDown, RefreshCw, Trash2 } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theme } from "../theme";
import { checkHealth, newServerId, parseServerUrl, redeemPairingUrl, type ServerEntry } from "../lib/client";
import { ConnectionStatusDot, type ConnectionStatusDotState } from "../features/connection/ConnectionStatusDot";

// ── presentation helpers (mirrors @t3tools/client-runtime/connection) ─────────
function connectionStatusText(args: { phase: ConnectionStatusDotState; error: string | null }): string {
  switch (args.phase) {
    case "available":
      return "Available";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return args.error ? `Failed to connect. Reconnecting… Reason: ${args.error}` : "Reconnecting…";
    case "connected":
      return "Connected";
    case "error":
      return args.error ? `Connection failed. Reason: ${args.error}` : "Connection failed";
  }
}

function phaseForServer(s: ServerEntry, activeId: string | null, live: boolean, connecting: boolean, connError: string | null): ConnectionStatusDotState {
  if (s.id !== activeId) return "available";
  if (connecting) return "connecting";
  if (connError) return "error";
  if (live) return "connected";
  return "offline";
}

// ── row ───────────────────────────────────────────────────────────────────────
function EnvironmentRow(props: {
  server: ServerEntry;
  active: boolean;
  phase: ConnectionStatusDotState;
  statusText: string;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (s: ServerEntry) => void;
  onForget: (id: string) => void;
  onUpdate: (s: ServerEntry) => void;
  connecting: boolean;
}) {
  const { server, phase, statusText, expanded, onToggle } = props;
  const hasFailure = phase === "error" || phase === "reconnecting";
  const isRetrying = phase === "connecting" || phase === "reconnecting";
  const [draftLabel, setDraftLabel] = useState(server.label);
  const [draftUrl, setDraftUrl] = useState(server.baseUrl);
  const [saving, setSaving] = useState(false);

  // keep drafts in sync when server prop changes (e.g. after save)
  React.useEffect(() => setDraftLabel(server.label), [server.label]);
  React.useEffect(() => setDraftUrl(server.baseUrl), [server.baseUrl]);

  const handleSave = useCallback(async () => {
    const label = draftLabel.trim() || server.label;
    const baseUrl = draftUrl.trim();
    if (!baseUrl) {
      Alert.alert("Could not update environment", "Enter a URL");
      return;
    }
    setSaving(true);
    try {
      const parsed = parseServerUrl(baseUrl);
      await checkHealth(parsed.baseUrl);
      props.onUpdate({ ...server, label, baseUrl: parsed.baseUrl });
      onToggle();
    } catch (e) {
      Alert.alert("Could not update environment", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [draftLabel, draftUrl, server, props, onToggle]);

  const handleRemove = useCallback(() => {
    Alert.alert(`Remove environment?`, `Disconnect and forget ${server.label}?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => props.onForget(server.id) },
    ]);
  }, [server, props]);

  return (
    <View style={styles.rowRoot}>
      <Pressable style={styles.rowPress} onPress={onToggle}>
        <ConnectionStatusDot state={phase} pulse={isRetrying} size={8} />
        <View style={styles.rowCenter}>
          <Text style={styles.rowLabel} numberOfLines={1}>
            {server.label}
          </Text>
          <Text style={styles.rowUrl} numberOfLines={1}>
            {server.baseUrl}
          </Text>
          {statusText ? (
            <Text
              style={[styles.rowStatus, hasFailure && styles.rowStatusError]}
              numberOfLines={expanded ? undefined : 1}
              selectable={expanded}
            >
              {statusText}
            </Text>
          ) : null}
        </View>
        <View style={[styles.chevronWrap, expanded && styles.chevronWrapOpen]}>
          <ChevronDown size={12} color={theme.colors.chevron} />
        </View>
      </Pressable>

      {expanded ? (
        <View style={styles.expanded}>
          <View style={styles.fieldGap}>
            <Text style={styles.fieldLabel}>Label</Text>
            <TextInput
              style={styles.input}
              value={draftLabel}
              onChangeText={setDraftLabel}
              placeholder="My MacBook"
              placeholderTextColor={theme.colors.muted}
              autoCapitalize="words"
              autoCorrect={false}
            />
          </View>
          <View style={styles.fieldGap}>
            <Text style={styles.fieldLabel}>URL</Text>
            <TextInput
              style={styles.input}
              value={draftUrl}
              onChangeText={setDraftUrl}
              placeholder="192.168.1.100:8080"
              placeholderTextColor={theme.colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>

          <View style={styles.actions}>
            <Pressable style={styles.btnPrimary} onPress={handleSave} disabled={saving}>
              {saving ? (
                <ActivityIndicator color="#0a0a0a" size="small" />
              ) : (
                <>
                  <Check size={13} color="#0a0a0a" strokeWidth={2.2} />
                  <Text style={styles.btnPrimaryLabel}>Save</Text>
                </>
              )}
            </Pressable>
            <Pressable style={styles.btnIcon} onPress={() => props.onSelect(server)}>
              <RefreshCw size={14} color={theme.colors.muted} />
            </Pressable>
            <Pressable style={styles.btnDanger} onPress={handleRemove}>
              <Trash2 size={14} color="#fca5a5" />
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

// ── screen ────────────────────────────────────────────────────────────────────
export function EnvironmentsScreen({
  servers,
  activeId,
  connError,
  connecting: connectingProp,
  live = false,
  onSelect,
  onForget,
  onAdded,
}: {
  servers: ServerEntry[];
  activeId: string | null;
  connError: string | null;
  connecting?: boolean;
  live?: boolean;
  onSelect: (s: ServerEntry) => void;
  onForget: (id: string) => void;
  onAdded: (s: ServerEntry) => void;
}) {
  const insets = useSafeAreaInsets();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"pairing" | "manual">("pairing");
  const [pairingUrl, setPairingUrl] = useState("");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const shownError = localError ?? connError;
  const hasEnvironments = servers.length > 0;
  const connecting = connectingProp ?? false;

  const handleToggle = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

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

  const handleUpdate = useCallback(
    (updated: ServerEntry) => {
      // Reuse onAdded — App.tsx upserts by id
      onAdded(updated);
    },
    [onAdded],
  );

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: Math.max(insets.bottom, 18) + 18 },
      ]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {hasEnvironments ? (
        <View style={styles.card}>
          {servers.map((s, index) => {
            const phase = phaseForServer(s, activeId, live, connecting, connError);
            const statusText = connectionStatusText({ phase, error: activeId === s.id ? connError : null });
            return (
              <View key={s.id} style={[index !== 0 && styles.cardDivider]}>
                <EnvironmentRow
                  server={s}
                  active={s.id === activeId}
                  phase={phase}
                  statusText={statusText}
                  expanded={expandedId === s.id}
                  onToggle={() => handleToggle(s.id)}
                  onSelect={onSelect}
                  onForget={onForget}
                  onUpdate={handleUpdate}
                  connecting={connecting}
                />
              </View>
            );
          })}
        </View>
      ) : (
        <View style={styles.emptyCard}>
          <View style={styles.emptyIconWrap}>
            {/* t3code uses SymbolView point.3.connected.trianglepath.dotted */}
            <RefreshCw size={20} color={theme.colors.muted} strokeWidth={1.7} />
          </View>
          <Text style={styles.emptyText}>No environments connected yet.{"\n"}Tap + to add one.</Text>
        </View>
      )}

      {/* Add environment — replica of ConnectionsNewRouteScreen card */}
      <View style={[styles.addCard, hasEnvironments && styles.addCardSpaced]}>
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
            <View style={styles.fieldGap}>
              <Text style={styles.fieldLabel}>Label</Text>
              <TextInput
                style={styles.input}
                placeholder="Label (optional, e.g. Aether-PC)"
                placeholderTextColor={theme.colors.muted}
                value={label}
                onChangeText={setLabel}
                autoCapitalize="words"
                autoCorrect={false}
              />
            </View>
            <View style={styles.fieldGap}>
              <Text style={styles.fieldLabel}>Pairing URL</Text>
              <TextInput
                style={styles.input}
                placeholder="http://192.168.1.10:7070/pair#token=…"
                placeholderTextColor={theme.colors.muted}
                value={pairingUrl}
                onChangeText={setPairingUrl}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <Pressable style={[styles.primaryBtn, working && styles.primaryBtnDisabled]} onPress={onPair} disabled={working}>
              {working ? <ActivityIndicator color="#0a0a0a" /> : <Text style={styles.primaryBtnLabel}>Pair & add</Text>}
            </Pressable>
          </>
        ) : (
          <>
            <View style={styles.fieldGap}>
              <Text style={styles.fieldLabel}>Label</Text>
              <TextInput
                style={styles.input}
                placeholder="Label (e.g. home LAN)"
                placeholderTextColor={theme.colors.muted}
                value={label}
                onChangeText={setLabel}
                autoCapitalize="words"
                autoCorrect={false}
              />
            </View>
            <View style={styles.fieldGap}>
              <Text style={styles.fieldLabel}>URL</Text>
              <TextInput
                style={styles.input}
                placeholder="http://100.x.y.z:7070  or  https://aether.tail….ts.net"
                placeholderTextColor={theme.colors.muted}
                value={baseUrl}
                onChangeText={setBaseUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            </View>
            <View style={styles.fieldGap}>
              <Text style={styles.fieldLabel}>Token</Text>
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
            </View>
            <Pressable
              style={[styles.primaryBtn, working && styles.primaryBtnDisabled]}
              onPress={() => {
                if (!baseUrl.trim() || !token.trim()) {
                  setLocalError("Enter both the server URL and token");
                  return;
                }
                void add({ id: newServerId(), label: label.trim() || baseUrl.trim(), baseUrl: baseUrl.trim(), token: token.trim() });
              }}
              disabled={working}
            >
              {working ? <ActivityIndicator color="#0a0a0a" /> : <Text style={styles.primaryBtnLabel}>Add environment</Text>}
            </Pressable>
          </>
        )}

        {shownError ? <Text style={styles.error}>{shownError}</Text> : null}
      </View>

      <Text style={styles.hint}>
        Tip: save both your LAN address and Tailscale IP (100.x) or MagicDNS name as separate environments, then tap a
        row to expand and reconnect.
      </Text>
    </ScrollView>
  );
}

// ── styles — exact t3code dark tokens ───────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.screen },
  content: { paddingHorizontal: 20, paddingTop: 16 },
  card: {
    overflow: "hidden",
    borderRadius: 24,
    backgroundColor: theme.colors.card,
  },
  cardDivider: { borderTopWidth: 1, borderTopColor: theme.colors.border },
  // empty — t3code ConnectionsRouteScreen empty
  emptyCard: {
    alignItems: "center",
    gap: 12,
    borderRadius: 24,
    backgroundColor: theme.colors.card,
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  emptyIconWrap: {
    height: 48,
    width: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  emptyText: { color: theme.colors.muted, fontSize: 14, fontFamily: theme.font.regular, lineHeight: 19, textAlign: "center" },
  // row — ConnectionEnvironmentRow
  rowRoot: { backgroundColor: theme.colors.card },
  rowPress: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  rowCenter: { flex: 1, gap: 2 },
  rowLabel: { color: theme.colors.foreground, fontSize: 16, fontFamily: theme.font.bold, lineHeight: 19 },
  rowUrl: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular },
  rowStatus: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular, lineHeight: 16 },
  rowStatusError: { color: "#fca5a5" },
  chevronWrap: { padding: 2 },
  chevronWrapOpen: { transform: [{ rotate: "180deg" }] },
  expanded: { gap: 12, paddingHorizontal: 16, paddingBottom: 16 },
  fieldGap: { gap: 6 },
  fieldLabel: {
    color: theme.colors.muted,
    fontSize: 11,
    fontFamily: theme.font.bold,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  input: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    backgroundColor: "#141414",
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: theme.colors.foreground,
    fontFamily: theme.font.regular,
    fontSize: 16,
  },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 4 },
  btnPrimary: {
    flex: 1,
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 14,
    backgroundColor: "#f5f5f5",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  btnPrimaryLabel: { color: "#0a0a0a", fontFamily: theme.font.bold, fontSize: 12, letterSpacing: 0.8, textTransform: "uppercase" },
  btnIcon: {
    height: 42,
    width: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    backgroundColor: "#141414",
  },
  btnDanger: {
    height: 42,
    width: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(248,113,113,0.18)",
    backgroundColor: "rgba(239,68,68,0.14)",
  },
  // add card — ConnectionsNewRouteScreen
  addCard: {
    gap: 16,
    borderRadius: 24,
    backgroundColor: theme.colors.card,
    padding: 16,
  },
  addCardSpaced: { marginTop: 20 },
  seg: { flexDirection: "row", backgroundColor: theme.colors.card, borderRadius: 12, padding: 4, borderWidth: 1, borderColor: theme.colors.border },
  segBtn: { flex: 1, paddingVertical: 10, alignItems: "center", borderRadius: 8 },
  segActive: { backgroundColor: theme.colors.cardAlt },
  segLabel: { color: theme.colors.muted, fontFamily: theme.font.medium, fontSize: 14 },
  segLabelActive: { color: theme.colors.foreground },
  primaryBtn: {
    backgroundColor: "#f5f5f5",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  primaryBtnDisabled: { opacity: 0.6 },
  primaryBtnLabel: { color: "#0a0a0a", fontFamily: theme.font.bold, fontSize: 15 },
  error: { color: "#fca5a5", fontFamily: theme.font.regular, fontSize: 13 },
  hint: { color: theme.colors.muted, fontFamily: theme.font.regular, fontSize: 12, marginTop: 16, lineHeight: 18, paddingHorizontal: 4 },
});
