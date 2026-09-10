import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ChevronRight, CornerUpLeft, FileText, Folder } from "lucide-react-native";
import { theme } from "../theme";
import type { RpcClient } from "../lib/client";
import { Card } from "../components/Card";

interface Entry {
  name: string;
  fullPath: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
}

/** Minimal file browser over `filesystem.browse`. */
export function FilesScreen({ client }: { client: RpcClient | null }) {
  const [path, setPath] = useState<string>("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(
    async (p: string) => {
      if (!client) return;
      setBusy(true);
      setError(null);
      try {
        const res = (await client.call("filesystem.browse", { path: p })) as {
          parentPath: string;
          entries: Entry[];
        };
        setPath(res.parentPath);
        setEntries(res.entries);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  useEffect(() => {
    browse("");
  }, [browse]);

  if (!client) return <Placeholder label="Connect to browse files" />;

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Files</Text>
      <Text style={styles.path} numberOfLines={1}>
        {path || "…"}
      </Text>
      {busy && entries.length === 0 ? (
        <ActivityIndicator color={theme.colors.foreground} style={{ marginTop: 24 }} />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 24 }}>
          {path !== "/" && path !== "" ? (
            <Pressable onPress={() => browse(parentOf(path))}>
              <Card>
                <View style={styles.row}>
                  <View style={styles.iconWrap}>
                    <CornerUpLeft size={19} color={theme.colors.secondary} />
                  </View>
                  <Text style={styles.rowLabel}>Parent folder</Text>
                </View>
              </Card>
            </Pressable>
          ) : null}
          {entries.map((e) => (
            <Pressable key={e.fullPath} onPress={() => e.isDirectory && browse(e.fullPath)}>
              <Card>
                <View style={styles.row}>
                  <View style={styles.iconWrap}>
                    {e.isDirectory ? (
                      <Folder size={19} color={theme.colors.link} />
                    ) : (
                      <FileText size={19} color={theme.colors.secondary} />
                    )}
                  </View>
                  <Text style={styles.rowLabel} numberOfLines={1}>
                    {e.name}
                  </Text>
                  {e.isFile ? (
                    <Text style={styles.size}>{humanSize(e.size)}</Text>
                  ) : (
                    <ChevronRight size={18} color={theme.colors.chevron} />
                  )}
                </View>
              </Card>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function parentOf(p: string): string {
  const parts = p.replace(/\/$/, "").split("/");
  parts.pop();
  const out = parts.join("/") || "/";
  return out;
}

function humanSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function Placeholder({ label }: { label: string }) {
  return (
    <View style={styles.root}>
      <Text style={styles.empty}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.screen, padding: 16 },
  title: { color: theme.colors.foreground, fontSize: 26, fontFamily: theme.font.bold },
  path: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular, marginVertical: 8 },
  row: { flexDirection: "row", alignItems: "center" },
  iconWrap: { marginRight: 10, justifyContent: "center" },
  rowLabel: { color: theme.colors.foreground, fontSize: 15, fontFamily: theme.font.regular, flex: 1 },
  size: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular },
  error: { color: theme.colors.danger, fontFamily: theme.font.regular, marginTop: 16 },
  empty: { color: theme.colors.muted, fontFamily: theme.font.regular, fontSize: 14, textAlign: "center", marginTop: 48 },
});
