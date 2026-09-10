/**
 * Settings — structured sections (t3code `SettingsRouteScreen` counterpart):
 * Configuration → Environments, Appearance, Server, Tunnel, App.
 * Connection management moved out of onboarding into Environments.
 */
import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ChevronLeft, ChevronRight, LogOut } from "lucide-react-native";
import appJson from "../../app.json";
import { theme } from "../theme";
import { Card } from "../components/Card";

export type SettingsRoute = "main" | "appearance" | "environments";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.group}>{children}</View>
    </View>
  );
}

function NavRow({
  label,
  value,
  onPress,
}: {
  label: string;
  value?: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.navRow} onPress={onPress}>
      <Text style={styles.navLabel}>{label}</Text>
      <View style={styles.navRight}>
        {value ? <Text style={styles.navValue}>{value}</Text> : null}
        <ChevronRight size={16} color={theme.colors.chevron} />
      </View>
    </Pressable>
  );
}

export function SettingsScreen({
  route,
  onNavigate,
  baseUrl,
  environmentCount,
  tunnel,
  serverInfo,
  onDisconnect,
}: {
  route: SettingsRoute;
  onNavigate: (r: SettingsRoute) => void;
  baseUrl: string;
  environmentCount: number;
  tunnel: { provider?: string; status?: string; publicUrl?: string | null } | null;
  serverInfo: { name?: string; version?: string; uptimeSeconds?: number; port?: number } | null;
  onDisconnect: () => void;
}) {
  void route;
  const appVersion = (appJson as { expo?: { version?: string } }).expo?.version ?? "0.1.0";

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settings</Text>

      <Section title="Configuration">
        <NavRow
          label="Environments"
          value={`${environmentCount}`}
          onPress={() => onNavigate("environments")}
        />
      </Section>

      <Section title="Appearance">
        <NavRow label="Appearance" value="Theme · Text · Terminal · Code" onPress={() => onNavigate("appearance")} />
      </Section>

      <Section title="Server">
        <Card>
          <Text style={styles.kv}>Connected to</Text>
          <Text style={styles.val} numberOfLines={1}>
            {baseUrl}
          </Text>
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
      </Section>

      <Section title="App">
        <Card>
          <Text style={styles.kv}>Version</Text>
          <Text style={styles.val}>{appVersion}</Text>
        </Card>
      </Section>

      <Pressable style={styles.danger} onPress={onDisconnect}>
        <LogOut size={15} color={theme.colors.danger} />
        <Text style={styles.dangerLabel}>Switch server</Text>
      </Pressable>
    </ScrollView>
  );
}

export function SettingsBackHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={styles.backHeader}>
      <Pressable onPress={onBack} hitSlop={12} style={styles.backBtn}>
        <ChevronLeft size={20} color={theme.colors.foreground} />
        <Text style={styles.backLabel}>Settings</Text>
      </Pressable>
      <Text style={styles.backTitle}>{title}</Text>
      <View style={styles.backSpacer} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.screen },
  content: { padding: 16, paddingBottom: 32, gap: 20 },
  title: { color: theme.colors.foreground, fontSize: 26, fontFamily: theme.font.bold },
  section: { gap: 8 },
  sectionTitle: {
    color: theme.colors.secondary,
    fontSize: 13,
    fontFamily: theme.font.medium,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    paddingHorizontal: 4,
  },
  group: { backgroundColor: theme.colors.card, borderRadius: theme.radius.card, overflow: "hidden" },
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  navLabel: { color: theme.colors.foreground, fontSize: 15, fontFamily: theme.font.medium },
  navRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  navValue: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular },
  kv: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular },
  val: { color: theme.colors.foreground, fontSize: 15, fontFamily: theme.font.medium, marginTop: 4 },
  valDim: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular, marginTop: 4 },
  hint: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular, marginTop: 8 },
  danger: {
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    alignItems: "center",
    borderColor: "rgba(255,69,58,0.4)",
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 13,
  },
  dangerLabel: { color: theme.colors.danger, fontFamily: theme.font.medium, fontSize: 14 },
  backHeader: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 8 },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 2, padding: 8 },
  backLabel: { color: theme.colors.foreground, fontSize: 14, fontFamily: theme.font.medium },
  backTitle: { flex: 1, textAlign: "center", color: theme.colors.secondary, fontSize: 14, fontFamily: theme.font.medium },
  backSpacer: { width: 90 },
});
