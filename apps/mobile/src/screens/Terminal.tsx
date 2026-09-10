/**
 * Terminal screen — t3code `ThreadTerminalRouteScreen` ported 1:1 to this app.
 *
 * Same behavior, adapted to this stack (sessionId scoping, RpcClient, no
 * native Ghostty view — `TerminalSurface` is the text fallback t3code uses
 * when the native view is unavailable):
 *  - attach with cached grid size, `restartIfNotRunning` respawn
 *  - stale-reopen when the stream replays a dead session
 *  - running → exited transition falls back to the previous live session
 *  - toolbar: esc / ctrl-or-cmd+alt modifiers / tab / clear / arrows / ~ | / -
 *  - Ctrl modifier mapping (`a` → 0x01, `[` → ESC, …)
 *  - font-size stepper writing back to appearance prefs
 *  - buffer replay key so font-size changes don't flash stale grids
 *  - terminal tabs with server labels + status dots, new/close/restart/clear
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Plus, RotateCcw, Trash2, X } from "lucide-react-native";
import { DEFAULT_TERMINAL_ID } from "../lib/terminalProtocol";
import { theme } from "../theme";
import type { RpcClient } from "../lib/client";
import { useAppearancePreferences } from "../features/appearance/AppearanceContext";
import { TerminalSurface } from "../features/terminal/TerminalSurface";
import { getMobileTerminalTheme } from "../features/terminal/terminalTheme";
import {
  getTerminalBufferReplayKey,
  getTerminalSurfaceReplayBuffer,
  TERMINAL_BUFFER_REPLAY_STABILITY_DELAY_MS,
} from "../features/terminal/terminalBufferReplay";
import {
  basename,
  buildTerminalMenuSessions,
  getTerminalStatusLabel,
  nextOpenTerminalId,
  previousLiveTerminalId,
  resolveTerminalSessionLabel,
  type TerminalMenuSession,
} from "../features/terminal/terminalMenu";
import {
  cacheTerminalGridSize,
  getCachedTerminalGridSize,
} from "../features/terminal/terminalUiState";
import {
  useAttachedTerminalSession,
  useKnownTerminalSessions,
} from "../features/terminal/useTerminalSession";

const SESSION_ID = "mobile";
const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;

type PendingModifier = "ctrl" | "meta";

interface TerminalToolbarAction {
  readonly kind: "send" | "clear" | "modifier";
  readonly key: string;
  readonly label: string;
  readonly data?: string;
  readonly modifier?: PendingModifier;
}

function applyCtrlModifier(input: string): string {
  const firstCharacter = input[0];
  if (!firstCharacter) {
    return input;
  }

  const lowerCharacter = firstCharacter.toLowerCase();
  if (lowerCharacter >= "a" && lowerCharacter <= "z") {
    return String.fromCharCode(lowerCharacter.charCodeAt(0) - 96);
  }

  if (firstCharacter === "@") return "\u0000";
  if (firstCharacter === "[") return "\u001b";
  if (firstCharacter === "\\") return "\u001c";
  if (firstCharacter === "]") return "\u001d";
  if (firstCharacter === "^") return "\u001e";
  if (firstCharacter === "_") return "\u001f";
  if (firstCharacter === "?") return "\u007f";

  return input;
}

const TOOLBAR_ACTIONS: ReadonlyArray<TerminalToolbarAction> = [
  { kind: "send", key: "esc", label: "esc", data: "\u001b" },
  { kind: "modifier", key: "ctrl", label: "ctrl", modifier: "ctrl" },
  { kind: "modifier", key: "alt", label: "alt", modifier: "meta" },
  { kind: "send", key: "tab", label: "tab", data: "\t" },
  { kind: "clear", key: "clear", label: "clear" },
  { kind: "send", key: "up", label: "↑", data: "\u001b[A" },
  { kind: "send", key: "down", label: "↓", data: "\u001b[B" },
  { kind: "send", key: "left", label: "←", data: "\u001b[D" },
  { kind: "send", key: "right", label: "→", data: "\u001b[C" },
  { kind: "send", key: "tilde", label: "~", data: "~" },
  { kind: "send", key: "pipe", label: "|", data: "|" },
  { kind: "send", key: "slash", label: "/", data: "/" },
  { kind: "send", key: "dash", label: "-", data: "-" },
];

export function TerminalScreen({ client }: { client: RpcClient | null }) {
  const {
    isReady: hasResolvedFontPreference,
    appearance,
    themeAppearance,
    preferences,
    setTerminalFontSize,
  } = useAppearancePreferences();
  const fontSize = appearance.terminalFontSize;
  const terminalTheme = getMobileTerminalTheme(preferences.themeMode, themeAppearance);

  const [terminalId, setTerminalId] = useState(DEFAULT_TERMINAL_ID);
  const [lastGridSize, setLastGridSize] = useState(() =>
    getCachedTerminalGridSize({ sessionId: SESSION_ID, terminalId: DEFAULT_TERMINAL_ID }) ?? {
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
    },
  );
  const [pendingModifier, setPendingModifier] = useState<PendingModifier | null>(null);
  const [keyboardFocusRequest, setKeyboardFocusRequest] = useState(0);
  const [readyBufferReplayKey, setReadyBufferReplayKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bufferReplayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningTerminalKeyRef = useRef<string | null>(null);
  const reopenedStaleTerminalKeyRef = useRef<string | null>(null);
  const lastBufferReplayKeyRef = useRef<string | null>(null);

  const knownSessions = useKnownTerminalSessions({ client, sessionId: SESSION_ID });

  useEffect(() => {
    setLastGridSize(
      getCachedTerminalGridSize({ sessionId: SESSION_ID, terminalId }) ?? {
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
      },
    );
    setPendingModifier(null);
    reopenedStaleTerminalKeyRef.current = null;
  }, [terminalId]);

  const terminalAttachInput = useMemo(
    () =>
      client && hasResolvedFontPreference
        ? {
            sessionId: SESSION_ID,
            terminalId,
            cwd: "",
            cols: lastGridSize.cols,
            rows: lastGridSize.rows,
            restartIfNotRunning: true,
          }
        : null,
    [client, hasResolvedFontPreference, lastGridSize.cols, lastGridSize.rows, terminalId],
  );

  // `cwd: ""` would violate the contract — the server opens with the home
  // directory when `restartIfNotRunning` fires, so only cols/rows ride along.
  const attachInput = useMemo(
    () =>
      terminalAttachInput
        ? {
            sessionId: terminalAttachInput.sessionId,
            terminalId: terminalAttachInput.terminalId,
            cwd: knownSessions.find((s) => s.terminalId === terminalId)?.summary?.cwd ?? "",
            cols: terminalAttachInput.cols,
            rows: terminalAttachInput.rows,
            restartIfNotRunning: true,
          }
        : null,
    [knownSessions, terminalAttachInput, terminalId],
  );

  const terminal = useAttachedTerminalSession({
    client,
    sessionId: SESSION_ID,
    terminal: attachInput,
  });

  const terminalKey = `${SESSION_ID}:${terminalId}`;
  const bufferReplayKey = useMemo(
    () => getTerminalBufferReplayKey({ terminalKey, fontSize }),
    [fontSize, terminalKey],
  );
  if (lastBufferReplayKeyRef.current === null) {
    lastBufferReplayKeyRef.current = bufferReplayKey;
  }
  const terminalSurfaceBuffer = getTerminalSurfaceReplayBuffer({
    buffer: terminal.buffer,
    replayKey: bufferReplayKey,
    readyReplayKey: readyBufferReplayKey,
  });
  const isRunning = terminal.status === "running" || terminal.status === "starting";

  const terminalMenuSessions = useMemo<ReadonlyArray<TerminalMenuSession>>(
    () =>
      buildTerminalMenuSessions({
        knownSessions,
        workspaceRoot: null,
        currentSession: {
          terminalId,
          cwd: terminal.summary?.cwd ?? null,
          status: terminal.status,
          hasRunningSubprocess: terminal.hasRunningSubprocess,
          displayLabel: resolveTerminalSessionLabel(terminalId, terminal.summary),
          updatedAt: terminal.updatedAt,
        },
      }),
    [
      knownSessions,
      terminal.hasRunningSubprocess,
      terminal.status,
      terminal.summary,
      terminal.updatedAt,
      terminalId,
    ],
  );

  const cwd = terminal.summary?.cwd ?? null;

  // Track running → exited transitions observed on this screen so typing
  // `exit` falls back to the previous live session (t3code web drawer parity).
  useEffect(() => {
    if (terminalAttachInput === null) {
      runningTerminalKeyRef.current = null;
      return;
    }
    if (isRunning) {
      runningTerminalKeyRef.current = terminalKey;
      return;
    }
    if (
      runningTerminalKeyRef.current === terminalKey &&
      (terminal.status === "exited" || terminal.status === "closed")
    ) {
      runningTerminalKeyRef.current = null;
      const fallbackTerminalId = previousLiveTerminalId({
        sessions: terminalMenuSessions,
        exitedTerminalId: terminalId,
      });
      if (fallbackTerminalId !== null) {
        setTerminalId(fallbackTerminalId);
      }
    }
  }, [isRunning, terminal.status, terminalAttachInput, terminalKey, terminalId, terminalMenuSessions]);

  // Stale-reopen: the attach stream replays a dead snapshot without respawn —
  // issue an explicit open so the session comes back (t3code parity).
  useEffect(() => {
    if (isRunning || !client || !terminalAttachInput) {
      if (isRunning) reopenedStaleTerminalKeyRef.current = null;
      return;
    }
    if (
      (terminal.status !== "closed" && terminal.status !== "exited") ||
      terminal.version === 0 ||
      runningTerminalKeyRef.current === terminalKey ||
      reopenedStaleTerminalKeyRef.current === terminalKey
    ) {
      return;
    }
    reopenedStaleTerminalKeyRef.current = terminalKey;
    if (!cwd) {
      // No known cwd yet — attach with `restartIfNotRunning` already covers
      // the respawn (server opens with the home directory).
      reopenedStaleTerminalKeyRef.current = null;
      return;
    }
    client
      .call("terminal.open", {
        sessionId: SESSION_ID,
        terminalId,
        cwd,
        cols: terminalAttachInput.cols,
        rows: terminalAttachInput.rows,
      })
      .catch((e) => {
        reopenedStaleTerminalKeyRef.current = null;
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [client, cwd, isRunning, terminal.status, terminal.version, terminalAttachInput, terminalId, terminalKey]);

  // Buffer replay stability (font-size transitions).
  useEffect(() => {
    if (lastBufferReplayKeyRef.current === bufferReplayKey) return;
    lastBufferReplayKeyRef.current = bufferReplayKey;
    if (bufferReplayTimerRef.current !== null) {
      clearTimeout(bufferReplayTimerRef.current);
      bufferReplayTimerRef.current = null;
    }
    setReadyBufferReplayKey(null);
  }, [bufferReplayKey]);

  useEffect(
    () => () => {
      if (bufferReplayTimerRef.current !== null) clearTimeout(bufferReplayTimerRef.current);
    },
    [],
  );

  const writeInput = useCallback(
    (data: string) => {
      if (!client || !isRunning) return;
      client.call("terminal.write", { sessionId: SESSION_ID, terminalId, data }).catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      });
    },
    [client, isRunning, terminalId],
  );

  const handleInput = useCallback(
    (data: string) => {
      if (data.length === 0) return;
      setError(null);
      if (pendingModifier === "ctrl") {
        setPendingModifier(null);
        writeInput(applyCtrlModifier(data));
      } else if (pendingModifier === "meta") {
        setPendingModifier(null);
        writeInput(`\u001b${data}`);
      } else {
        writeInput(data);
      }
    },
    [pendingModifier, writeInput],
  );

  const scheduleBufferReplayReady = useCallback(() => {
    if (bufferReplayTimerRef.current !== null) clearTimeout(bufferReplayTimerRef.current);
    const replayKey = bufferReplayKey;
    bufferReplayTimerRef.current = setTimeout(() => {
      bufferReplayTimerRef.current = null;
      setReadyBufferReplayKey(replayKey);
    }, TERMINAL_BUFFER_REPLAY_STABILITY_DELAY_MS);
  }, [bufferReplayKey]);

  const handleResize = useCallback(
    (size: { readonly cols: number; readonly rows: number }) => {
      cacheTerminalGridSize({ sessionId: SESSION_ID, terminalId }, size);
      if (readyBufferReplayKey !== bufferReplayKey) {
        scheduleBufferReplayReady();
      }
      if (size.cols === lastGridSize.cols && size.rows === lastGridSize.rows) return;
      setLastGridSize(size);
      if (!client || !isRunning) return;
      client
        .call("terminal.resize", { sessionId: SESSION_ID, terminalId, cols: size.cols, rows: size.rows })
        .catch(() => {});
    },
    [bufferReplayKey, client, isRunning, lastGridSize.cols, lastGridSize.rows, readyBufferReplayKey, scheduleBufferReplayReady, terminalId],
  );

  const handleToolbarAction = useCallback(
    (action: TerminalToolbarAction) => {
      if (action.kind === "clear") {
        if (!client) return;
        client.call("terminal.clear", { sessionId: SESSION_ID, terminalId }).catch((e) => {
          setError(e instanceof Error ? e.message : String(e));
        });
        return;
      }
      if (action.kind === "modifier" && action.modifier) {
        setPendingModifier((prev) => (prev === action.modifier ? null : action.modifier!));
        return;
      }
      if (action.kind === "send" && action.data) {
        handleInput(action.data);
      }
    },
    [client, handleInput, terminalId],
  );

  const openNewTerminal = useCallback(() => {
    const nextId = nextOpenTerminalId({
      listedTerminalIds: terminalMenuSessions.map((s) => s.terminalId),
      activeRouteTerminalId: terminalId,
    });
    setTerminalId(nextId);
    setKeyboardFocusRequest((n) => n + 1);
  }, [terminalId, terminalMenuSessions]);

  const closeCurrentTerminal = useCallback(() => {
    if (!client) return;
    const fallbackTerminalId = previousLiveTerminalId({
      sessions: terminalMenuSessions,
      exitedTerminalId: terminalId,
    });
    client
      .call("terminal.close", { sessionId: SESSION_ID, terminalId })
      .then(() => {
        setTerminalId(fallbackTerminalId ?? DEFAULT_TERMINAL_ID);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, terminalId, terminalMenuSessions]);

  const restartCurrentTerminal = useCallback(() => {
    if (!client) return;
    if (!cwd) {
      setError("No working directory known yet — wait for the shell to attach.");
      return;
    }
    client
      .call("terminal.restart", {
        sessionId: SESSION_ID,
        terminalId,
        cwd,
        cols: lastGridSize.cols,
        rows: lastGridSize.rows,
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, cwd, lastGridSize.cols, lastGridSize.rows, terminalId]);

  if (!client) {
    return (
      <View style={styles.root}>
        <Text style={styles.title}>Terminal</Text>
        <Text style={styles.dim}>Connect to open a terminal.</Text>
      </View>
    );
  }

  const statusLabel = getTerminalStatusLabel({
    status: terminal.status,
    hasRunningSubprocess: terminal.hasRunningSubprocess,
  });

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.title}>Terminal</Text>
          <View style={styles.headerActions}>
            <Pressable
              style={styles.iconBtn}
              accessibilityLabel="Decrease terminal font size"
              onPress={() => {
                const next = Math.max(6, Math.round((fontSize - 0.5) * 2) / 2);
                setTerminalFontSize(next);
              }}
            >
              <Text style={styles.iconBtnLabel}>A−</Text>
            </Pressable>
            <Text style={styles.fontSizeLabel}>{fontSize.toFixed(1)}</Text>
            <Pressable
              style={styles.iconBtn}
              accessibilityLabel="Increase terminal font size"
              onPress={() => {
                const next = Math.min(14, Math.round((fontSize + 0.5) * 2) / 2);
                setTerminalFontSize(next);
              }}
            >
              <Text style={styles.iconBtnLabel}>A+</Text>
            </Pressable>
            <Pressable style={styles.iconBtn} accessibilityLabel="Restart terminal" onPress={restartCurrentTerminal}>
              <RotateCcw size={15} color={theme.colors.foreground} />
            </Pressable>
            <Pressable style={styles.iconBtn} accessibilityLabel="Close terminal" onPress={closeCurrentTerminal}>
              <Trash2 size={15} color={theme.colors.foreground} />
            </Pressable>
          </View>
        </View>
        <Text style={styles.subtitle} numberOfLines={1}>
          {cwd ? basename(cwd) ?? cwd : "…"} • {statusLabel}
          {terminal.hasRunningSubprocess ? " • Task running" : ""}
        </Text>
        {terminal.error ? <Text style={styles.error}>{terminal.error}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      <ScrollView
        horizontal
        style={styles.tabs}
        contentContainerStyle={styles.tabsContent}
        showsHorizontalScrollIndicator={false}
      >
        {terminalMenuSessions.map((session) => {
          const active = session.terminalId === terminalId;
          const dot =
            session.status === "running"
              ? session.hasRunningSubprocess
                ? "#ff9f0a"
                : "#30d158"
              : session.status === "starting"
                ? "#0a84ff"
                : session.status === "error"
                  ? "#ff453a"
                  : theme.colors.muted;
          return (
            <Pressable
              key={session.terminalId}
              style={[styles.tab, active && styles.tabActive]}
              onPress={() => setTerminalId(session.terminalId)}
            >
              <View style={[styles.dot, { backgroundColor: dot }]} />
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]} numberOfLines={1}>
                {session.displayLabel}
              </Text>
            </Pressable>
          );
        })}
        <Pressable style={styles.newTab} accessibilityLabel="Open another shell" onPress={openNewTerminal}>
          <Plus size={15} color={theme.colors.secondary} />
        </Pressable>
      </ScrollView>

      <View style={styles.surfaceWrap}>
        <TerminalSurface
          terminalKey={terminalKey}
          buffer={terminalSurfaceBuffer}
          fontSize={fontSize}
          isRunning={isRunning}
          keyboardFocusRequest={keyboardFocusRequest}
          theme={terminalTheme}
          onInput={handleInput}
          onResize={handleResize}
        />
      </View>

      <View style={styles.toolbar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.toolbarContent}>
          {TOOLBAR_ACTIONS.map((action) => {
            const selected =
              action.kind === "modifier" && pendingModifier === action.modifier;
            return (
              <Pressable
                key={action.key}
                style={[styles.toolBtn, selected && styles.toolBtnSelected]}
                onPress={() => handleToolbarAction(action)}
              >
                <Text style={[styles.toolLabel, selected && styles.toolLabelSelected]}>
                  {action.label}
                </Text>
              </Pressable>
            );
          })}
          <Pressable
            style={styles.toolBtn}
            onPress={() => setKeyboardFocusRequest((n) => n + 1)}
          >
            <Text style={styles.toolLabel}>⌨</Text>
          </Pressable>
        </ScrollView>
      </View>

      {pendingModifier ? (
        <Pressable style={styles.modifierBanner} onPress={() => setPendingModifier(null)}>
          <X size={12} color={theme.colors.secondary} />
          <Text style={styles.modifierText}>
            {pendingModifier === "ctrl" ? "ctrl" : "alt"} held — next key is modified
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.screen, padding: 16, gap: 10 },
  header: { gap: 4 },
  headerTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { color: theme.colors.foreground, fontSize: 26, fontFamily: theme.font.bold },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  iconBtn: {
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 10,
    minWidth: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  iconBtnLabel: { color: theme.colors.foreground, fontFamily: theme.font.bold, fontSize: 13 },
  fontSizeLabel: { color: theme.colors.secondary, fontFamily: "monospace", fontSize: 12, minWidth: 30, textAlign: "center" },
  subtitle: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular },
  error: { color: theme.colors.danger, fontFamily: theme.font.regular, fontSize: 12 },
  tabs: { maxHeight: 40, flexGrow: 0 },
  tabsContent: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 2 },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    maxWidth: 180,
  },
  tabActive: { borderColor: "rgba(255,255,255,0.22)" },
  tabLabel: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.medium },
  tabLabelActive: { color: theme.colors.foreground },
  dot: { width: 7, height: 7, borderRadius: 99 },
  newTab: {
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 999,
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  surfaceWrap: { flex: 1, minHeight: 280 },
  toolbar: { backgroundColor: theme.colors.card, borderRadius: 12, borderColor: theme.colors.border, borderWidth: 1 },
  toolbarContent: { flexDirection: "row", alignItems: "center", gap: 4, padding: 6 },
  toolBtn: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: "transparent" },
  toolBtnSelected: { backgroundColor: theme.colors.cardAlt, borderColor: "rgba(255,255,255,0.18)", borderWidth: 1 },
  toolLabel: { color: theme.colors.secondary, fontFamily: "monospace", fontSize: 13 },
  toolLabelSelected: { color: theme.colors.foreground },
  modifierBanner: { flexDirection: "row", alignItems: "center", gap: 6, justifyContent: "center", paddingVertical: 4 },
  modifierText: { color: theme.colors.secondary, fontSize: 12, fontFamily: theme.font.regular },
  dim: { color: theme.colors.secondary, fontFamily: theme.font.regular, fontSize: 14 },
});
