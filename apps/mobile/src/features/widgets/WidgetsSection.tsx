import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Play, Zap } from "lucide-react-native";
import { theme } from "../../theme";
import type { RpcClient } from "../../lib/client";
import type { ParamValues } from "../scripts/params";

export interface HomeWidget {
  id: string;
  name: string;
  scriptId: string;
  params?: ParamValues;
}

interface ScriptDef {
  id: string;
  name: string;
}

/** The connected server predates the widgets RPC — hide, don't error. */
function isUnknownMethodError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /unknown method/i.test(msg);
}

/**
 * Home-tab widgets — one-tap script shortcuts with preset parameter values
 * (e.g. "Dim lights" runs Room Lighting with `{ brightness: 50 }`).
 * Long-press a tile to remove it. Create widgets from any script's Run sheet.
 */
export function WidgetsSection({ client }: { client: RpcClient | null }) {
  const [widgets, setWidgets] = useState<HomeWidget[]>([]);
  const [scriptNames, setScriptNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const runIdRef = useRef<string | null>(null);
  runIdRef.current = runId;

  const reload = useCallback(async () => {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      const [list, scripts] = await Promise.all([
        client.call<HomeWidget[]>("widgets.list", {}),
        client.call<ScriptDef[]>("scripts.list", {}).catch(() => [] as ScriptDef[]),
      ]);
      setWidgets(Array.isArray(list) ? list : []);
      const names: Record<string, string> = {};
      if (Array.isArray(scripts)) for (const s of scripts) names[s.id] = s.name;
      setScriptNames(names);
      setUnsupported(false);
    } catch (e) {
      if (isUnknownMethodError(e)) {
        // server predates widgets — hide the section until the daemon is updated
        setUnsupported(true);
        setError(null);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // clear the running spinner when our run finishes
  useEffect(() => {
    if (!client) return;
    return client.onEvent((channel, payload) => {
      if (channel !== "scripts") return;
      const p = payload as { type?: string; run?: { runId?: string }; runId?: string; message?: string };
      const finishedId = p.run?.runId ?? p.runId;
      if ((p.type === "finished" || p.type === "error") && finishedId && finishedId === runIdRef.current) {
        setRunningId(null);
        setRunId(null);
      }
    });
  }, [client]);

  if (!client || unsupported) return null;

  async function runWidget(w: HomeWidget) {
    if (runningId) return;
    setError(null);
    setRunningId(w.id);
    try {
      const r = (await client!.call("scripts.run", {
        id: w.scriptId,
        ...(w.params && Object.keys(w.params).length > 0 ? { params: w.params } : {}),
      })) as { runId?: string };
      if (r?.runId) {
        setRunId(r.runId);
      } else {
        // no run tracking back — release the spinner
        setRunningId(null);
      }
    } catch (e) {
      setRunningId(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function confirmRemove(w: HomeWidget) {
    Alert.alert("Remove widget?", `"${w.name}" will be removed from Home. The script stays untouched.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          client!
            .call("widgets.delete", { id: w.id })
            .then(() => reload())
            .catch((e) => setError(e instanceof Error ? e.message : String(e)));
        },
      },
    ]);
  }

  if (!busy && widgets.length === 0 && !error) return null;

  return (
    <View style={styles.root}>
      <Text style={styles.heading}>Shortcuts</Text>
      {busy && widgets.length === 0 ? <ActivityIndicator color={theme.colors.foreground} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.grid}>
        {widgets.map((w) => {
          const running = runningId === w.id;
          const target = scriptNames[w.scriptId] ?? w.scriptId;
          return (
            <Pressable
              key={w.id}
              onPress={() => void runWidget(w)}
              onLongPress={() => confirmRemove(w)}
              disabled={running}
              style={[styles.tile, running && styles.tileRunning]}
            >
              <View style={styles.tileIcon}>
                {running ? (
                  <ActivityIndicator size="small" color={theme.colors.foreground} />
                ) : (
                  <Zap size={18} color={theme.colors.foreground} strokeWidth={1.8} />
                )}
              </View>
              <Text style={styles.tileName} numberOfLines={2}>
                {w.name}
              </Text>
              <View style={styles.tileSubRow}>
                <Play size={10} color={theme.colors.muted} />
                <Text style={styles.tileSub} numberOfLines={1}>
                  {target}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      {widgets.length > 0 ? <Text style={styles.hint}>Tap to run · long-press to remove</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 10 },
  heading: { color: theme.colors.foreground, fontSize: 17, fontFamily: theme.font.bold },
  error: { color: theme.colors.danger, fontFamily: theme.font.regular, fontSize: 13 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  tile: {
    flexBasis: "48%",
    flexGrow: 1,
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.card,
    padding: 14,
    gap: 6,
    minHeight: 108,
    justifyContent: "center",
  },
  tileRunning: { opacity: 0.7 },
  tileIcon: { marginBottom: 2 },
  tileName: { color: theme.colors.foreground, fontSize: 15, fontFamily: theme.font.bold },
  tileSubRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  tileSub: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular, flexShrink: 1 },
  hint: { color: theme.colors.tertiary, fontSize: 12, fontFamily: theme.font.regular },
});
