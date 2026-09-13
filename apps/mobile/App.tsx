import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Keyboard, StatusBar, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
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
import { AppearanceProvider } from "./src/features/appearance/AppearanceContext";
import { TabBar, type TabKey } from "./src/components/TabBar";
import { ConnectScreen } from "./src/screens/Connect";
import { DEMO_HOME, HomeScreen, statsToHome, type HomeData } from "./src/screens/Home";
import { FilesScreen } from "./src/screens/Files";
import { ScriptsScreen } from "./src/screens/Scripts";
import { ServicesScreen } from "./src/screens/Services";
import { TerminalScreen } from "./src/screens/Terminal";
import { AppearanceSettingsScreen } from "./src/screens/AppearanceSettings";
import { EnvironmentsScreen } from "./src/screens/Environments";
import { SettingsBackHeader, SettingsScreen, type SettingsRoute } from "./src/screens/Settings";
import { handleBackPress, pushBackHandler } from "./src/lib/backPress";

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
      <AppearanceProvider>
        <AppInner />
      </AppearanceProvider>
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
  const [settingsRoute, setSettingsRoute] = useState<SettingsRoute>("main");
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [home, setHome] = useState<HomeData>(DEMO_HOME);
  const [live, setLive] = useState(false);
  const [tunnel, setTunnel] = useState<{ provider?: string; status?: string; publicUrl?: string | null } | null>(null);
  const [serverInfo, setServerInfo] = useState<{ name?: string; version?: string; uptimeSeconds?: number; port?: number } | null>(null);
  const clientRef = useRef<RpcClient | null>(null);
  const desiredRef = useRef<ServerEntry | null>(null);
  const backoffRef = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // System back (hardware key + Android edge-swipe gesture) navigation:
  // sheets/modals sit on top of this fallback via pushBackHandler.
  const tabRef = useRef<TabKey>(tab);
  tabRef.current = tab;
  const settingsRouteRef = useRef<SettingsRoute>(settingsRoute);
  settingsRouteRef.current = settingsRoute;
  const tabHistoryRef = useRef<TabKey[]>(["home"]);

  const navigateTab = useCallback((t: TabKey) => {
    if (t !== "settings") setSettingsRoute("main");
    setTab(t);
    const hist = tabHistoryRef.current;
    if (hist[hist.length - 1] !== t) {
      tabHistoryRef.current = [...hist, t].slice(-20);
    }
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => handleBackPress());
    return () => sub.remove();
  }, []);

  useEffect(() => {
    // Fallback = bottom of the stack: settings sub-screen → previous tab → OS default (exit).
    return pushBackHandler(() => {
      if (keyboardOpenRef.current) {
        Keyboard.dismiss();
        return true;
      }
      if (tabRef.current === "settings" && settingsRouteRef.current !== "main") {
        setSettingsRoute("main");
        return true;
      }
      const hist = tabHistoryRef.current;
      if (hist.length > 1) {
        hist.pop();
        const prev = hist[hist.length - 1];
        if (prev !== "settings") setSettingsRoute("main");
        setTab(prev);
        return true;
      }
      return false;
    });
  }, []);

  useEffect(() => {
    Font.loadAsync({ "DMSans-Regular": DMSans_400Regular, "DMSans-Medium": DMSans_500Medium, "DMSans-Bold": DMSans_700Bold })
      .catch(() => {})
      .finally(() => setFontsReady(true));
    loadCatalog().then(setCatalog);
  }, []);

  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);

  // T3Code equivalent of useKeyboardState() + KeyboardStickyView offset 0.
  // The accessory must sit flush above the keyboard in EITHER window mode:
  // adjustPan (Expo Go — layout keeps full height, keyboard overlays, so we
  // must lift by the full keyboard height) or adjustResize (dev build — the
  // OS already shrinks the layout, so lifting again would double-count and
  // float the row). lift = keyboard height minus the OS shrink, measured at
  // the outer window level so tab-bar visibility never pollutes it. The tab
  // bar hides while typing so no dock height sits between row and keyboard.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [windowShrink, setWindowShrink] = useState(0);
  const keyboardOpenRef = useRef(false);
  const windowBaseRef = useRef(0);
  useEffect(() => {
    const onShow = (e: { endCoordinates?: { height?: number } }) => {
      keyboardOpenRef.current = true;
      setKeyboardOpen(true);
      setKeyboardHeight(e?.endCoordinates?.height ?? 0);
    };
    const onHide = () => {
      keyboardOpenRef.current = false;
      setKeyboardOpen(false);
      setWindowShrink(0);
    };
    const showWill = Keyboard.addListener("keyboardWillShow", onShow);
    const showDid = Keyboard.addListener("keyboardDidShow", onShow);
    const hideWill = Keyboard.addListener("keyboardWillHide", onHide);
    const hideDid = Keyboard.addListener("keyboardDidHide", onHide);
    return () => {
      showWill.remove();
      showDid.remove();
      hideWill.remove();
      hideDid.remove();
    };
  }, []);

  // Outer-window height: unaffected by tab-bar visibility or safe-area inner
  // padding, so base-minus-current isolates exactly the OS resize shrink.
  const handleWindowLayout = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (!keyboardOpenRef.current) {
      windowBaseRef.current = h;
      setWindowShrink(0);
      return;
    }
    setWindowShrink(Math.max(0, windowBaseRef.current - h));
  }, []);

  // Pan (Expo Go): shrink 0 → full-height lift. Resize (dev build): the OS
  // already made room → lift collapses toward 0. Either way the row lands
  // flush, matching T3Code's KeyboardStickyView offset 0.
  const keyboardLift = keyboardOpen ? Math.max(0, keyboardHeight - windowShrink) : 0;
  // While the keyboard covers the gesture bar the bottom inset would add a
  // dead strip under the row — drop it on the terminal route only.
  const safeEdges: Array<"top" | "right" | "bottom" | "left"> =
    tab === "terminal" && keyboardOpen ? ["top", "right", "left"] : ["top", "right", "bottom", "left"];

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
    tabHistoryRef.current = ["home"];
    setTab("home");
    setSettingsRoute("main");
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

  const renderSettings = () => {
    if (settingsRoute === "appearance") {
      return (
        <View style={styles.body}>
          <SettingsBackHeader title="Appearance" onBack={() => setSettingsRoute("main")} />
          <AppearanceSettingsScreen />
        </View>
      );
    }
    if (settingsRoute === "environments") {
      return (
        <View style={styles.body}>
          <SettingsBackHeader title="Environments" onBack={() => setSettingsRoute("main")} />
          <EnvironmentsScreen
            servers={catalog.servers}
            activeId={active.id}
            connError={connError}
            connecting={connecting}
            live={live}
            onSelect={(s) => void connectTo(s)}
            onForget={forgetServer}
            onAdded={addedServer}
          />
        </View>
      );
    }
    return (
      <SettingsScreen
        route={settingsRoute}
        onNavigate={setSettingsRoute}
        baseUrl={active.baseUrl}
        environmentCount={catalog.servers.length}
        tunnel={tunnel}
        serverInfo={serverInfo}
        onDisconnect={switchServer}
      />
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={safeEdges} onLayout={handleWindowLayout}>
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
          <HomeScreen data={{ ...home, tailscaleIp }} hostLabel={hostLabel} onViewDetails={() => navigateTab("settings")} />
        ) : tab === "files" ? (
          <FilesScreen client={client} />
        ) : tab === "terminal" ? (
          <TerminalScreen client={client} serverLabel={active.label} keyboardLift={keyboardLift} />
        ) : tab === "scripts" ? (
          <ScriptsScreen client={client} />
        ) : tab === "services" ? (
          <ServicesScreen client={client} />
        ) : (
          renderSettings()
        )}
      </View>
      {keyboardOpen ? null : (
        <TabBar active={tab} onChange={navigateTab} />
      )}
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
