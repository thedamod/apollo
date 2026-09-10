import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StatusBar, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import * as Font from "expo-font";
import { DMSans_400Regular, DMSans_500Medium, DMSans_700Bold } from "@expo-google-fonts/dm-sans";
import { theme } from "./src/theme";
import {
  RpcClient,
  classifyError,
  loadCatalog,
  saveCatalog,
  parseServerUrl,
  type ServerCatalog,
  type ServerEntry,
} from "./src/lib/client";
import { TabBar, type TabKey } from "./src/components/TabBar";
import { ConnectScreen } from "./src/screens/Connect";
import { DEMO_HOME, HomeScreen, statsToHome, type HomeData } from "./src/screens/Home";
import { FilesScreen } from "./src/screens/Files";
import { ScriptsScreen } from "./src/screens/Scripts";
import { ServicesScreen } from "./src/screens/Services";
import { SettingsScreen, TerminalScreen } from "./src/screens/TerminalSettings";

const HISTORY_LEN = 24;
// t3code-style supervisor backoff: 1s, 2s, 4s … capped at 30s
const backoffDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 30_000);

function pushHist(arr: number[], v: number): number[] {
  const next = [...arr, v].slice(-HISTORY_LEN);
  return next.length > 1 ? next : [v, v];
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  );
}

function AppInner() {
  const [fontsReady, setFontsReady] = useState(false);
  const [catalog, setCatalog] = useState<ServerCatalog>({ servers: [], activeId: null });
  const [active, setActive] = useState<ServerEntry | null>(null);
  const [client, setClient] = useState<RpcClient | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [tab, setTab] = useState<TabKey>("home");
  const [home, setHome] = useState<HomeData>(DEMO_HOME);
  const [live, setLive] = useState(false);
  const [tunnel, setTunnel] = useState<{ provider?: string; status?: string; publicUrl?: string | null } | null>(null);
  const [serverInfo, setServerInfo] = useState<{ name?: string; version?: string; uptimeSeconds?: number; port?: number } | null>(null);
  const clientRef = useRef<RpcClient | null>(null);
  const desiredRef = useRef<ServerEntry | null>(null);
  const backoffRef = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    Font.loadAsync({ "DMSans-Regular": DMSans_400Regular, "DMSans-Medium": DMSans_500Medium, "DMSans-Bold": DMSans_700Bold })
      .catch(() => {})
      .finally(() => setFontsReady(true));
    loadCatalog().then(setCatalog);
  }, []);

  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);

  const persistCatalog = useCallback(async (c: ServerCatalog) => {
    setCatalog(c);
    await saveCatalog(c);
  }, []);

  const scheduleRetry = useCallback(() => {
    if (!desiredRef.current) return;
    const attempt = backoffRef.current++;
    setReconnectAttempt(attempt + 1);
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => {
      const target = desiredRef.current;
      if (target) void connectTo(target, { silent: true });
    }, backoffDelay(attempt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectTo = useCallback(
    async (entry: ServerEntry, opts: { silent?: boolean } = {}) => {
      desiredRef.current = entry;
      if (!opts.silent) {
        setConnecting(true);
        setConnError(null);
      }
      try {
        // drop the previous socket (expected close — no retry storm)
        clientRef.current?.close();
        const c = new RpcClient(entry);
        await c.connect();
        clientRef.current = c;
        backoffRef.current = 0;
        setReconnectAttempt(0);

        // unexpected drop (network change, sleep, server restart) -> backoff retry
        c.onClose((expected) => {
          if (expected || desiredRef.current?.id !== entry.id) return;
          setLive(false);
          setHome((h) => ({ ...h, connected: false }));
          scheduleRetry();
        });

        // live stats stream (server pushes every 2s after subscribe)
        c.onEvent((channel, payload) => {
          if (channel === "system") {
            const s = payload as {
              hostname?: string; platform?: string; uptimeSeconds?: number;
              cpu?: { usagePercent?: number | null }; memory?: { usagePercent?: number };
              disks?: Array<{ usagePercent?: number; usedBytes?: number; totalBytes?: number }>;
            };
            setHome((h) => {
              const patch = statsToHome(s);
              const cpu = s.cpu?.usagePercent ?? h.cpuPercent ?? 0;
              const ram = s.memory?.usagePercent ?? h.ramPercent;
              const disk = s.disks?.[0]?.usagePercent ?? h.diskPercent;
              return {
                ...h,
                ...patch,
                connected: true,
                cpuHistory: pushHist(h.cpuHistory, cpu),
                ramHistory: pushHist(h.ramHistory, ram),
                diskHistory: pushHist(h.diskHistory, disk),
                uptimeHistory: pushHist(h.uptimeHistory, s.uptimeSeconds ?? 0),
              };
            });
            setLive(true);
          }
        });
        c.subscribe("system.statsSubscribe", {});

        // one-shot: stats, server info, tunnel (tailscale status)
        try {
          const stats = (await c.call("system.stats", {})) as Parameters<typeof statsToHome>[0];
          setHome((h) => ({ ...h, ...statsToHome(stats), connected: true }));
        } catch {}
        try {
          const info = (await c.call("server.getInfo", {})) as { name?: string; version?: string; uptimeSeconds?: number; port?: number };
          setServerInfo(info);
          if (info.name) setHome((h) => ({ ...h, serverName: info.name! }));
        } catch {}
        try {
          const t = (await c.call("tunnel.get", {})) as { provider?: string; status?: string; publicUrl?: string | null };
          setTunnel(t);
        } catch {}

        setClient(c);
        setActive(entry);
        setConnError(null);
      } catch (e) {
        const err = classifyError(e);
        setConnError(err.message);
        // transient (network/timeout) -> keep retrying; blocked (auth) -> stop, user must fix
        if (err.kind === "transient" && desiredRef.current?.id === entry.id) {
          scheduleRetry();
        }
      } finally {
        setConnecting(false);
      }
    },
    [scheduleRetry],
  );

  // auto-connect on launch when a saved server is marked active
  const autoTried = useRef(false);
  useEffect(() => {
    if (!fontsReady || autoTried.current) return;
    const entry = catalog.servers.find((s) => s.id === catalog.activeId) ?? null;
    if (entry) {
      autoTried.current = true;
      void connectTo(entry);
    }
  }, [fontsReady, catalog, connectTo]);

  /** Back to the server list (keeps saved servers — t3code keeps the catalog). */
  const switchServer = useCallback(() => {
    desiredRef.current = null;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    backoffRef.current = 0;
    setReconnectAttempt(0);
    clientRef.current?.close();
    clientRef.current = null;
    setClient(null);
    setActive(null);
    setLive(false);
    setTab("home");
  }, []);

  const forgetServer = useCallback(
    (id: string) => {
      const servers = catalog.servers.filter((s) => s.id !== id);
      const activeId = catalog.activeId === id ? null : catalog.activeId;
      void persistCatalog({ servers, activeId });
    },
    [catalog, persistCatalog],
  );

  const addedServer = useCallback(
    (entry: ServerEntry) => {
      const servers = catalog.servers.some((s) => s.id === entry.id)
        ? catalog.servers.map((s) => (s.id === entry.id ? entry : s))
        : [...catalog.servers, entry];
      void persistCatalog({ servers, activeId: entry.id });
      void connectTo(entry);
    },
    [catalog, persistCatalog, connectTo],
  );

  const hostLabel = useMemo(() => {
    if (!active) return "";
    try {
      return parseServerUrl(active.baseUrl).host;
    } catch {
      return active.baseUrl;
    }
  }, [active]);

  const tailscaleIp = useMemo(() => {
    // prefer the tailnet address: tunnel publicUrl host, else the connected host, else demo
    const fromTunnel = (() => {
      if (!tunnel?.publicUrl) return "";
      try {
        return new URL(tunnel.publicUrl).hostname;
      } catch {
        return "";
      }
    })();
    return fromTunnel || hostLabel || DEMO_HOME.tailscaleIp;
  }, [tunnel, hostLabel]);

  if (!fontsReady) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={theme.colors.foreground} />
      </View>
    );
  }

  if (!active || !client) {
    return (
      // edges: keep content clear of the status bar / notch / gesture bar
      // (RN's built-in SafeAreaView is iOS-only — this one works on Android too).
      <SafeAreaView style={styles.safe} edges={["top", "right", "bottom", "left"]}>
        <StatusBar barStyle="light-content" />
        {connecting ? (
          <View style={styles.loading}>
            <ActivityIndicator color={theme.colors.foreground} />
            <Text style={styles.loadingLabel}>Connecting…</Text>
          </View>
        ) : (
          <ConnectScreen
            servers={catalog.servers}
            busy={false}
            error={connError}
            onSelect={(s) => void connectTo(s)}
            onForget={forgetServer}
            onAdded={addedServer}
          />
        )}
      </SafeAreaView>
    );
  }

  const reconnecting = reconnectAttempt > 0 && !live;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "right", "bottom", "left"]}>
      <StatusBar barStyle="light-content" />
      <View style={styles.body}>
        {reconnecting ? (
          <View style={styles.liveBanner}>
            <Text style={styles.liveText}>
              Reconnecting… (attempt {reconnectAttempt}){connError ? ` — ${connError}` : ""}
            </Text>
          </View>
        ) : !live ? (
          <View style={styles.liveBanner}>
            <Text style={styles.liveText}>Connecting live stats… (showing last known)</Text>
          </View>
        ) : null}
        {tab === "home" ? (
          <HomeScreen data={{ ...home, tailscaleIp }} hostLabel={hostLabel} onViewDetails={() => setTab("settings")} />
        ) : tab === "files" ? (
          <FilesScreen client={client} />
        ) : tab === "terminal" ? (
          <TerminalScreen client={client} />
        ) : tab === "scripts" ? (
          <ScriptsScreen client={client} />
        ) : tab === "services" ? (
          <ServicesScreen client={client} />
        ) : (
          <SettingsScreen
            baseUrl={active.baseUrl}
            tunnel={tunnel}
            serverInfo={serverInfo}
            onDisconnect={switchServer}
          />
        )}
      </View>
      <TabBar active={tab} onChange={setTab} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.screen },
  body: { flex: 1 },
  loading: { flex: 1, backgroundColor: theme.colors.screen, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingLabel: { color: theme.colors.secondary, fontFamily: theme.font.regular },
  liveBanner: { backgroundColor: theme.colors.card, paddingVertical: 6 },
  liveText: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular, textAlign: "center" },
});
