import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import type { RpcClient } from "../lib/client";
import { Card } from "../components/Card";
import { Placeholder } from "./Files";

interface Service {
  id: string;
  name?: string;
  status?: string;
  state?: string;
  port?: number;
}

/** Supervised daemons (e.g. Jellyfin) over `services.*` RPC. */
export function ServicesScreen({ client }: { client: RpcClient | null }) {
  const [services, setServices] = useState<Service[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(c: RpcClient) {
    try {
      const list = (await c.call("services.list", {})) as Service[];
      if (Array.isArray(list)) setServices(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (!client) return;
    setBusy(true);
    refresh(client).finally(() => setBusy(false));
    const off = client.onEvent((channel, payload) => {
      if (channel === "services") {
        const p = payload as { type?: string; services?: Service[]; service?: Service };
        if (Array.isArray(p.services)) setServices(p.services);
        else if (p.service) {
          setServices((prev) => {
            const i = prev.findIndex((s) => s.id === p.service!.id);
            if (i === -1) return [...prev, p.service!];
            const next = [...prev];
            next[i] = { ...next[i], ...p.service };
            return next;
          });
        } else refresh(client);
      }
    });
    client.subscribe("services.subscribe", {});
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  if (!client) return <Placeholder label="Connect to manage services" />;

  async function act(id: string, action: "services.start" | "services.stop" | "services.restart") {
    try {
      await client!.call(action, { id });
      await refresh(client!);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Services</Text>
      {busy ? <ActivityIndicator color={theme.colors.foreground} style={{ marginTop: 16 }} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView contentContainerStyle={{ gap: 8, paddingVertical: 12 }}>
        {services.map((s) => {
          const state = (s.status ?? s.state ?? "unknown").toLowerCase();
          const running = state.includes("run") || state.includes("healthy") || state.includes("up");
          return (
            <Card key={s.id}>
              <View style={styles.row}>
                <View style={[styles.dot, { backgroundColor: running ? theme.colors.dotOnline : theme.colors.muted }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{s.name ?? s.id}</Text>
                  <Text style={styles.sub}>
                    {s.id}
                    {s.port ? `  •  :${s.port}` : ""}  •  {state}
                  </Text>
                </View>
                <Pressable style={styles.btn} onPress={() => act(s.id, running ? "services.stop" : "services.start")}>
                  <Text style={styles.btnLabel}>{running ? "Stop" : "Start"}</Text>
                </Pressable>
              </View>
            </Card>
          );
        })}
        {services.length === 0 && !busy ? (
          <Text style={styles.empty}>No services yet. Create one (e.g. Jellyfin) from a desktop client or the API.</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.screen, padding: 16 },
  title: { color: theme.colors.foreground, fontSize: 26, fontFamily: theme.font.bold },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { color: theme.colors.foreground, fontSize: 16, fontFamily: theme.font.bold },
  sub: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular, marginTop: 2 },
  btn: { backgroundColor: theme.colors.cardAlt, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  btnLabel: { color: theme.colors.foreground, fontFamily: theme.font.medium, fontSize: 13 },
  error: { color: theme.colors.danger, fontFamily: theme.font.regular, marginTop: 8 },
  empty: { color: theme.colors.muted, fontFamily: theme.font.regular, marginTop: 16 },
});
