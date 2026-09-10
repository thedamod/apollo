import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { theme } from "../theme";
import { Card } from "./Card";
import { Sparkline } from "./Sparkline";

export function StatTile({
  icon: Icon,
  iconColor = theme.colors.foreground,
  label,
  value,
  sub,
  color,
  history,
  onPress,
}: {
  icon: LucideIcon;
  iconColor?: string;
  label: string;
  value: string;
  sub?: string;
  color: string;
  history: number[];
  onPress?: () => void;
}) {
  return (
    <Card style={styles.tile} onPress={onPress}>
      <View style={styles.row}>
        <View style={styles.iconWrap}>
          <Icon size={24} color={iconColor} strokeWidth={1.8} />
        </View>
        <View style={styles.meta}>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.value}>{value}</Text>
        </View>
      </View>
      {sub ? <Text style={styles.sub}>{sub}</Text> : null}
      <View style={styles.spark}>
        <Sparkline values={history} color={color} width={150} height={26} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  // flat stat block, not a card: no rounded box, no raised fill —
  // matches the flattened home rows (hairline divider only)
  tile: {
    flex: 1,
    minWidth: 0,
    backgroundColor: "transparent",
    borderWidth: 0,
    borderRadius: 0,
    paddingHorizontal: 0,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  row: { flexDirection: "row", alignItems: "flex-start" },
  iconWrap: { marginRight: 10, marginTop: 3 },
  meta: { flex: 1 },
  label: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular },
  value: { color: theme.colors.foreground, fontSize: 24, fontFamily: theme.font.bold, marginTop: 2 },
  sub: { color: theme.colors.secondary, fontSize: 12, fontFamily: theme.font.regular, marginTop: 6 },
  spark: { marginTop: 6, alignItems: "flex-start" },
});
