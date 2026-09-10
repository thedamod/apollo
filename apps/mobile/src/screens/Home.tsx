import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  ArrowDown,
  ChevronRight,
  Cpu,
  Clock,
  FileTerminal,
  FolderPlus,
  ArrowUp,
  HardDrive,
  Laptop,
  MemoryStick,
} from "lucide-react-native";
import { theme } from "../theme";
import { formatBytes, formatUptimeShort, greetingFor } from "../lib/format";
import { Card } from "../components/Card";
import { StatTile } from "../components/StatTile";
import { type ActivityItem } from "../components/ActivityList";

export interface HomeData {
  serverName: string;
  osLabel: string;
  uptimeSeconds: number;
  cpuPercent: number | null;
  ramPercent: number;
  ramUsedLabel?: string;
  diskPercent: number;
  diskLabel: string;
  tailscaleIp: string;
  connected: boolean;
  cpuHistory: number[];
  ramHistory: number[];
  diskHistory: number[];
  uptimeHistory: number[];
  activity: ActivityItem[];
}

export const DEMO_HOME: HomeData = {
  serverName: "Aether-PC",
  osLabel: "Windows 11",
  uptimeSeconds: 2 * 86400 + 4 * 3600,
  cpuPercent: 12,
  ramPercent: 38,
  diskPercent: 62,
  diskLabel: "418 GB / 931 GB",
  tailscaleIp: "100.64.12.34",
  connected: true,
  cpuHistory: [8, 9, 8, 11, 9, 10, 12, 16, 12, 11, 9, 10],
  ramHistory: [30, 32, 31, 33, 32, 35, 38, 36, 35, 34, 35, 36],
  diskHistory: [58, 59, 59, 60, 61, 62, 61, 62, 61, 62, 61, 62],
  uptimeHistory: [1, 2, 3, 5, 8, 12, 18, 26, 36, 48, 52, 52],
  activity: [
    { id: "1", icon: ArrowUp, iconColor: "#34c759", action: "Uploaded", target: "notes.pdf", when: "2m ago" },
    { id: "2", icon: ArrowDown, iconColor: "#0a84ff", action: "Downloaded", target: "project.zip", when: "12m ago" },
    { id: "3", icon: FolderPlus, iconColor: "#0a84ff", action: "Created folder", target: "/projects", when: "1h ago" },
    { id: "4", icon: FileTerminal, iconColor: "#8e8e93", action: "Ran script", target: "backup.sh", when: "3h ago" },
  ],
};

export function statsToHome(s: {
  hostname?: string;
  platform?: string;
  uptimeSeconds?: number;
  cpu?: { usagePercent?: number | null };
  memory?: { usagePercent?: number };
  disks?: Array<{ usagePercent?: number; usedBytes?: number; totalBytes?: number }>;
}): Partial<HomeData> {
  const d = s.disks?.[0];
  return {
    serverName: s.hostname ?? "server",
    osLabel: s.platform ?? "",
    uptimeSeconds: s.uptimeSeconds ?? 0,
    cpuPercent: s.cpu?.usagePercent ?? null,
    ramPercent: s.memory?.usagePercent ?? 0,
    diskPercent: d?.usagePercent ?? 0,
    diskLabel:
      d && d.totalBytes ? `${formatBytes(d.usedBytes ?? 0)} / ${formatBytes(d.totalBytes)}` : "",
  };
}

export function HomeScreen({
  data,
  userName = "Aether",
  onViewDetails,
}: {
  data: HomeData;
  hostLabel: string;
  userName?: string;
  onViewDetails?: () => void;
}) {
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.header}>
        <View style={styles.hello}>
          <Text style={styles.greet}>{greetingFor()},</Text>
          <Text style={styles.name}>{userName}</Text>
        </View>
      </View>

      <Card style={styles.serverCard}>
        <View style={styles.serverRow}>
          <View style={styles.serverIconWrap}>
            <Laptop size={30} color={theme.colors.foreground} strokeWidth={1.6} />
          </View>
          <View style={styles.serverMeta}>
            <Text style={styles.serverName}>{data.serverName}</Text>
            <Text style={styles.serverSub}>
              {data.osLabel}
              {data.osLabel ? "  •  " : ""}
              {formatUptimeShort(data.uptimeSeconds)} uptime
            </Text>
          </View>
          <Pressable onPress={onViewDetails} style={styles.detailsBtn}>
            <Text style={styles.detailsLabel}>View Details</Text>
            <ChevronRight size={15} color={theme.colors.foreground} />
          </Pressable>
        </View>
      </Card>

      <View style={styles.grid}>
        <StatTile
          icon={Cpu}
          label="CPU"
          value={data.cpuPercent == null ? "—" : `${Math.round(data.cpuPercent)}%`}
          color={theme.colors.cpu}
          history={data.cpuHistory}
        />
        <StatTile
          icon={MemoryStick}
          iconColor={theme.colors.ram}
          label="RAM"
          value={`${Math.round(data.ramPercent)}%`}
          color={theme.colors.ram}
          history={data.ramHistory}
        />
      </View>
      <View style={styles.grid}>
        <StatTile
          icon={HardDrive}
          label="Disk"
          value={`${Math.round(data.diskPercent)}%`}
          sub={data.diskLabel}
          color={theme.colors.disk}
          history={data.diskHistory}
        />
        <StatTile
          icon={Clock}
          label="Uptime"
          value={formatUptimeShort(data.uptimeSeconds)}
          color={theme.colors.uptime}
          history={data.uptimeHistory}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.screen },
  content: { padding: 16, paddingBottom: 24, gap: 12 },
  header: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  hello: { flex: 1 },
  greet: { color: theme.colors.secondary, fontSize: 22, fontFamily: theme.font.regular },
  name: { color: theme.colors.foreground, fontSize: 44, fontFamily: theme.font.bold, marginTop: -4 },
  serverCard: {
    backgroundColor: "transparent",
    borderWidth: 0,
    borderRadius: 0,
    paddingHorizontal: 0,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  serverRow: { flexDirection: "row", alignItems: "center" },
  serverIconWrap: { marginRight: 12 },
  serverMeta: { flex: 1 },
  serverName: { color: theme.colors.foreground, fontSize: 20, fontFamily: theme.font.bold },
  serverSub: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular, marginTop: 2 },
  detailsBtn: {
    flexDirection: "row",
    alignItems: "center",
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 2,
  },
  detailsLabel: { color: theme.colors.foreground, fontSize: 13, fontFamily: theme.font.medium },
  grid: { flexDirection: "row", gap: 12 },
});
