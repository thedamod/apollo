import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Play } from "lucide-react-native";
import { theme } from "../../theme";
import type { RpcClient } from "../../lib/client";
import { Sheet } from "../../components/Form";
import { ParamFields } from "./ParamFields";
import type { ParamValues, ScriptParam } from "./params";
import { defaultParamValues, serializeParamValue, validateParamValues } from "./params";

export interface RunnableScript {
  id: string;
  name: string;
  description?: string;
  command: string;
  params?: ScriptParam[];
}

interface RunRow {
  runId: string;
  status: string;
  exitCode?: number | null;
  startedAt: string;
  finishedAt?: string | null;
}

function durationMs(r: { startedAt: string; finishedAt?: string | null }): number | null {
  if (!r.finishedAt) return null;
  const ms = new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Run screen generated from the parameter schema + live output + history. */
export function ScriptRunSheet({
  script,
  client,
  onClose,
}: {
  script: RunnableScript | null;
  client: RpcClient | null;
  onClose: () => void;
}) {
  const [values, setValues] = useState<ParamValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<"idle" | "running" | "success" | "error">("idle");
  const [output, setOutput] = useState("");
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [finishedAt, setFinishedAt] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [history, setHistory] = useState<RunRow[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const runIdRef = useRef<string | null>(null);
  const logScrollRef = useRef<ScrollView | null>(null);

  const params = script?.params ?? [];

  // reset per script
  useEffect(() => {
    setValues(defaultParamValues(params));
    setErrors({});
    setPhase("idle");
    setOutput("");
    setStartedAt(null);
    setFinishedAt(null);
    setRunError(null);
    runIdRef.current = null;
    if (script && client) {
      setHistoryBusy(true);
      client
        .call<RunRow[]>("scripts.runs", { scriptId: script.id, limit: 10 })
        .then((list) => setHistory(Array.isArray(list) ? list : []))
        .catch(() => {})
        .finally(() => setHistoryBusy(false));
    } else {
      setHistory([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script?.id]);

  // live output for the active run
  useEffect(() => {
    if (!client) return;
    return client.onEvent((channel, payload) => {
      if (channel !== "scripts") return;
      const p = payload as { type?: string; runId?: string; data?: string; content?: string; chunk?: string; run?: RunRow; message?: string };
      if (p.runId && p.runId !== runIdRef.current) return;
      const text = p.data ?? p.content ?? p.chunk;
      if (p.type === "output" && typeof text === "string") {
        setOutput((o) => (o + text).slice(-6000));
      } else if (p.type === "finished" && p.run) {
        setPhase(p.run.status === "success" ? "success" : "error");
        setFinishedAt(p.run.finishedAt ?? new Date().toISOString());
        runIdRef.current = null;
        reloadHistory();
      } else if (p.type === "error") {
        setPhase("error");
        setRunError(p.message ?? "Run failed");
        setFinishedAt(new Date().toISOString());
        runIdRef.current = null;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, script?.id]);

  function reloadHistory() {
    if (!script || !client) return;
    client
      .call<RunRow[]>("scripts.runs", { scriptId: script.id, limit: 10 })
      .then((list) => setHistory(Array.isArray(list) ? list : []))
      .catch(() => {});
  }

  async function run() {
    if (!script || !client) return;
    const errs = validateParamValues(params, values);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setPhase("running");
    setOutput("");
    setRunError(null);
    setStartedAt(new Date().toISOString());
    setFinishedAt(null);
    try {
      const serialized: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) serialized[k] = serializeParamValue(v);
      const r = (await client.call("scripts.run", {
        id: script.id,
        // params travel along once the server increment lands
        params: serialized,
      })) as { runId?: string };
      if (r?.runId) runIdRef.current = r.runId;
      else {
        // no runId back — poll the latest run once
        const logs = (await client.call("scripts.logs", { runId: r?.runId ?? "" }).catch(() => null)) as { content?: string } | null;
        if (logs?.content) setOutput(logs.content.slice(-6000));
      }
    } catch (e) {
      setPhase("error");
      setRunError(e instanceof Error ? e.message : String(e));
      setFinishedAt(new Date().toISOString());
    }
  }

  async function viewLogs(runId: string) {
    if (!client) return;
    try {
      const logs = (await client.call("scripts.logs", { runId })) as { content?: string };
      setOutput((logs?.content ?? "").slice(-6000));
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    }
  }

  const dur = startedAt ? formatDuration(durationMs({ startedAt, finishedAt })) : "";

  return (
    <Sheet
      visible={script !== null}
      title={script ? script.name : ""}
      stepLabel={script?.description || undefined}
      onClose={onClose}
    >
      {params.length > 0 ? (
        <ParamFields params={params} values={values} onChange={setValues} errors={errors} />
      ) : (
        <Text style={styles.muted}>No inputs — runs as-is.</Text>
      )}
      <Pressable onPress={() => void run()} disabled={phase === "running"} style={[styles.runBtn, phase === "running" && { opacity: 0.6 }]}>
        {phase === "running" ? (
          <ActivityIndicator color="#0b0b0c" size="small" />
        ) : (
          <Play size={14} color="#0b0b0c" />
        )}
        <Text style={styles.runLabel}>{phase === "running" ? "Running…" : "Run"}</Text>
      </Pressable>
      {phase !== "idle" ? (
        <View style={styles.statusRow}>
          <View style={[styles.dot, phase === "running" ? styles.dotRun : phase === "success" ? styles.dotOk : styles.dotErr]} />
          <Text style={styles.status}>
            {phase === "running" ? "Running…" : phase === "success" ? `Done${dur ? ` in ${dur}` : ""}` : `Failed${dur ? ` after ${dur}` : ""}`}
          </Text>
        </View>
      ) : null}
      {runError ? <Text style={styles.error}>{runError}</Text> : null}
      {output ? (
        <View>
          <Text style={styles.section}>Output</Text>
          {/* Inner scroll window: the outer Sheet already scrolls, so the log
              gets its own capped viewport (nestedScrollEnabled for Android)
              and tails new output while a run streams. */}
          <ScrollView
            ref={logScrollRef}
            style={styles.logBox}
            nestedScrollEnabled
            showsVerticalScrollIndicator
            onContentSizeChange={() => logScrollRef.current?.scrollToEnd({ animated: false })}
          >
            <Text selectable style={styles.logText}>
              {output}
            </Text>
          </ScrollView>
        </View>
      ) : null}
      <View>
        <Text style={styles.section}>History</Text>
        {historyBusy ? <ActivityIndicator color={theme.colors.foreground} /> : null}
        {!historyBusy && history.length === 0 ? <Text style={styles.muted}>No runs yet.</Text> : null}
        <View style={{ gap: 6 }}>
          {history.map((h) => (
            <Pressable key={h.runId} onPress={() => void viewLogs(h.runId)} style={styles.histRow}>
              <View style={[styles.dot, h.status === "success" ? styles.dotOk : h.status === "running" ? styles.dotRun : styles.dotErr]} />
              <Text style={styles.histText}>
                {new Date(h.startedAt).toLocaleString()}
                {h.exitCode !== null && h.exitCode !== undefined ? ` · exit ${h.exitCode}` : ""}
                {formatDuration(durationMs(h)) ? ` · ${formatDuration(durationMs(h))}` : ""}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  muted: { color: theme.colors.muted, fontFamily: theme.font.regular, fontSize: 13 },
  runBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: theme.colors.foreground, borderRadius: 999, paddingVertical: 12, marginTop: 2 },
  runLabel: { color: "#0b0b0c", fontFamily: theme.font.bold, fontSize: 15 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: theme.colors.muted },
  dotRun: { backgroundColor: theme.colors.link },
  dotOk: { backgroundColor: theme.colors.dotOnline },
  dotErr: { backgroundColor: theme.colors.danger },
  status: { color: theme.colors.foreground, fontSize: 14, fontFamily: theme.font.medium },
  error: { color: theme.colors.danger, fontFamily: theme.font.regular, fontSize: 13 },
  section: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.medium, marginBottom: 6 },
  logBox: {
    backgroundColor: theme.colors.cardAlt,
    borderRadius: 12,
    padding: 10,
    minHeight: 120,
    maxHeight: 320,
  },
  logText: { color: theme.colors.foreground, fontFamily: theme.font.regular, fontSize: 12 },
  histRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: theme.colors.cardAlt, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9 },
  histText: { color: theme.colors.secondary, fontSize: 12, fontFamily: theme.font.regular },
});
