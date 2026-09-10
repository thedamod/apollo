import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { theme } from "../theme";
import { Card } from "./Card";

export interface ActivityItem {
  id: string;
  icon: LucideIcon;
  iconColor: string;
  action: string;
  target: string;
  when: string;
}

export function ActivityList({ items }: { items: ActivityItem[] }) {
  return (
    <Card style={styles.list}>
      {items.map((a, i) => {
        const Icon = a.icon;
        return (
          <View key={a.id} style={[styles.row, i < items.length - 1 && styles.divider]}>
            <View style={styles.iconWrap}>
              <Icon size={19} color={a.iconColor} strokeWidth={2} />
            </View>
            <Text style={styles.action}>{a.action} </Text>
            <Text style={styles.target} numberOfLines={1}>
              {a.target}
            </Text>
            <Text style={styles.when}>{a.when}</Text>
          </View>
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  list: { paddingVertical: 4, paddingHorizontal: 16 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 12 },
  divider: { borderBottomColor: theme.colors.borderSubtle, borderBottomWidth: StyleSheet.hairlineWidth },
  iconWrap: { width: 30, alignItems: "flex-start", justifyContent: "center" },
  action: { color: theme.colors.secondary, fontSize: 14, fontFamily: theme.font.regular },
  target: { color: theme.colors.foreground, fontSize: 14, fontFamily: theme.font.medium, flex: 1, marginLeft: 6 },
  when: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular, marginLeft: 8 },
});
