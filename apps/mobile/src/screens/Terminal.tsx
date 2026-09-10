/**
 * Terminal screen — t3code `ThreadTerminalRouteScreen` ported to this app.
 *
 * Layout mirrors t3code mobile 1:1: compact header with a terminal icon that
 * opens a session popup beneath it (status, text size, terminal list, open
 * new, restart, close), a VT grid surface (tap to focus = open keyboard),
 * and a keyboard accessory row (`esc CTRL ALT tab CLEAR` + dismiss) that is
 * only visible while the keyboard is open — plus a floating keyboard button
 * when it is closed.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Keyboard as KeyboardIcon,
  Plus,
  RotateCcw,
  SquareTerminal,
  Trash2,
} from "lucide-react-native";
import { DEFAULT_TERMINAL_ID } from "../lib/terminalProtocol";
import { theme } from "../theme";
import type { RpcClient } from "../lib/client";
import { useAppearancePreferences } from "../features/appearance/AppearanceContext";
import { TerminalSurface } from "../features/terminal/TerminalSurface";
import { getMobileTerminalTheme } from "../features/terminal/terminalTheme";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  normalizeTerminalFontSize,
} from "../features/terminal/terminalPreferences";
import {
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
import { VtParser } from "../features/terminal/vtParser";
import {
  useAttachedTerminalSession,
  useKnownTerminalSessions,
} from "../features/terminal/useTerminalSession";

const SESSION_ID = "mobile";
const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
/** Sentinel keeps the hidden field non-empty so soft-keyboard backspace deletes. */
const FIELD_SENTINEL = " ";

type PendingModifier = "ctrl" | "meta";

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

export function TerminalScreen({ client, serverLabel }: { client: RpcClient | null; serverLabel: string }) {
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [textSizeOpen, setTextSizeOpen] = useState(false);
  const [pendingModifier, setPendingModifier] = useState<PendingModifier | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [inputFocused, setInputFocused] = useState(false);
  const [renderVersion, setRenderVersion] = useState(0);
  const [field, setField] = useState(FIELD_SENTINEL);
  const [error, setError] = useState<string | null>(null);
  const [lastGridSize, setLastGridSize] = useState(() =>
    getCachedTerminalGridSize({ sessionId: SESSION_ID, terminalId: DEFAULT_TERMINAL_ID }) ?? {
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
    },
  );

  const inputRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);
  const pinnedRef = useRef(true);
  const parserRef = useRef<{ key: string; parser: VtParser; fed: number } | null>(null);
  // Stable fallback so the memoized surface never sees a new parser identity.
  const fallbackParserRef = useRef<VtParser | null>(null);
  if (!fallbackParserRef.current) {
    fallbackParserRef.current = new VtParser(DEFAULT_TERMINAL_COLS);
  }
  const runningTerminalKeyRef = useRef<string | null>(null);
  const reopenedStaleTerminalKeyRef = useRef<string | null>(null);

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

  // Keyboard visibility drives the accessory row vs the floating button.
  // Belt and suspenders: will+did events (some IMEs only send one pair) plus
  // the input's own focus state, so the controls can never vanish entirely.
  useEffect(() => {
    const onShow = (e: { endCoordinates: { height: number } }) => {
      setKeyboardVisible(true);
      setKeyboardHeight(e.endCoordinates.height);
    };
    const onHide = () => {
      setKeyboardVisible(false);
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

  // Visible when the keyboard is up — or, as a fallback, whenever the input
  // holds focus (covers IMEs that report no height / floating keyboards).
  const controlsOpen = keyboardVisible || inputFocused;

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
  const isRunning = terminal.status === "running" || terminal.status === "starting";

  // Feed PTY output incrementally into the VT grid. Snapshots/clears replace
  // the buffer (it shrinks) — those reset the parser and replay from scratch.
  useEffect(() => {
    let entry = parserRef.current;
    if (!entry || entry.key !== terminalKey) {
      entry = { key: terminalKey, parser: new VtParser(lastGridSize.cols), fed: 0 };
      parserRef.current = entry;
    }
    entry.parser.setCols(lastGridSize.cols);
    if (terminal.buffer.length < entry.fed) {
      entry.parser.feedSnapshot(terminal.buffer);
    } else if (terminal.buffer.length > entry.fed) {
      entry.parser.feed(terminal.buffer.slice(entry.fed));
    } else {
      return;
    }
    entry.fed = terminal.buffer.length;
    setRenderVersion((v) => v + 1);
  }, [lastGridSize.cols, terminal.buffer, terminal.version, terminalKey]);

  const parser = parserRef.current?.parser ?? fallbackParserRef.current!;

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
  const statusLabel = getTerminalStatusLabel({
    status: terminal.status,
    hasRunningSubprocess: terminal.hasRunningSubprocess,
  });

  // Running → exited observed here: fall through to the previous live
  // session instead of stranding the user on a dead shell.
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

  // Stale-reopen: the attach stream replays a dead snapshot without respawn.
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

  const focusKeyboard = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // Autofocus once on mount, like t3code's native surface.
  useEffect(() => {
    const timer = setTimeout(focusKeyboard, 400);
    return () => clearTimeout(timer);
  }, [focusKeyboard]);

  const writeInput = useCallback(
    (data: string) => {
      if (!client || !isRunning || data.length === 0) return;
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

  /** Soft-keyboard typing arrives through the hidden field. */
  const handleFieldChange = useCallback(
    (next: string) => {
      if (!isRunning) {
        if (next !== FIELD_SENTINEL) setField(FIELD_SENTINEL);
        return;
      }
      if (next.startsWith(FIELD_SENTINEL)) {
        // Trailing newlines belong to the return key (onSubmitEditing sends
        // them) — never double-send.
        const added = next.slice(FIELD_SENTINEL.length).replace(/[\r\n]+$/, "");
        if (added) {
          handleInput(added.replace(/\r\n?/g, "\r").replace(/\n/g, "\r"));
        }
      } else if (next === "") {
        handleInput("\u007f"); // backspace on the sentinel
      } else {
        handleInput(next);
      }
      if (next !== FIELD_SENTINEL) setField(FIELD_SENTINEL);
    },
    [handleInput, isRunning],
  );

  /** Hardware-keyboard special keys (soft keyboards rarely emit these). */
  const handleKeyPress = useCallback(
    ({ nativeEvent }: { nativeEvent: { key: string } }) => {
      const map: Record<string, string> = {
        Escape: "\u001b",
        ArrowUp: "\u001b[A",
        ArrowDown: "\u001b[B",
        ArrowLeft: "\u001b[D",
        ArrowRight: "\u001b[C",
      };
      const data = map[nativeEvent.key];
      if (data) handleInput(data);
    },
    [handleInput],
  );

  const handleResize = useCallback(
    (size: { readonly cols: number; readonly rows: number }) => {
      cacheTerminalGridSize({ sessionId: SESSION_ID, terminalId }, size);
      if (size.cols === lastGridSize.cols && size.rows === lastGridSize.rows) return;
      setLastGridSize(size);
      if (!client || !isRunning) return;
      client
        .call("terminal.resize", { sessionId: SESSION_ID, terminalId, cols: size.cols, rows: size.rows })
        .catch(() => {});
    },
    [client, isRunning, lastGridSize.cols, lastGridSize.rows, terminalId],
  );

  const openNewTerminal = useCallback(() => {
    const nextId = nextOpenTerminalId({
      listedTerminalIds: terminalMenuSessions.map((s) => s.terminalId),
      activeRouteTerminalId: terminalId,
    });
    setMenuOpen(false);
    setTerminalId(nextId);
    focusKeyboard();
  }, [focusKeyboard, terminalId, terminalMenuSessions]);

  const closeCurrentTerminal = useCallback(() => {
    if (!client) return;
    const fallbackTerminalId = previousLiveTerminalId({
      sessions: terminalMenuSessions,
      exitedTerminalId: terminalId,
    });
    client
      .call("terminal.close", { sessionId: SESSION_ID, terminalId })
      .then(() => {
        setMenuOpen(false);
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
      .then(() => setMenuOpen(false))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, cwd, lastGridSize.cols, lastGridSize.rows, terminalId]);

  const stepFontSize = useCallback(
    (direction: -1 | 1) => {
      const next = normalizeTerminalFontSize(
        Math.round((fontSize + direction * 0.5) * 2) / 2,
      );
      setTerminalFontSize(Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, next)));
    },
    [fontSize, setTerminalFontSize],
  );

  if (!client) {
    return (
      <View style={styles.root}>
        <Text style={styles.title}>Terminal</Text>
        <Text style={styles.dim}>Connect to open a terminal.</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.headerWrap}>
        <View style={styles.headerRow}>
          <View style={styles.headerTitle}>
            <Text style={styles.title}>Terminal</Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {serverLabel}
            </Text>
          </View>
          <Pressable
            style={styles.iconBtn}
            accessibilityLabel="Terminal menu"
            onPress={() => setMenuOpen((v) => !v)}
          >
            <SquareTerminal size={20} color={theme.colors.foreground} />
          </Pressable>
        </View>

        {menuOpen ? (
          <View style={styles.popup}>
            <Text style={styles.popupStatus}>{statusLabel}</Text>
            <View style={styles.popupDivider} />
            <Pressable style={styles.popupRow} onPress={() => setTextSizeOpen((v) => !v)}>
              <Text style={styles.popupLabel}>Text size</Text>
              {textSizeOpen ? (
                <ChevronDown size={16} color={theme.colors.secondary} />
              ) : (
                <ChevronRight size={16} color={theme.colors.secondary} />
              )}
            </Pressable>
            {textSizeOpen ? (
              <View style={styles.stepperRow}>
                <Pressable
                  style={styles.stepBtn}
                  accessibilityLabel="Decrease terminal font size"
                  onPress={() => stepFontSize(-1)}
                >
                  <Text style={styles.stepLabel}>−</Text>
                </Pressable>
                <Text style={styles.stepValue}>{fontSize.toFixed(1)}</Text>
                <Pressable
                  style={styles.stepBtn}
                  accessibilityLabel="Increase terminal font size"
                  onPress={() => stepFontSize(1)}
                >
                  <Text style={styles.stepLabel}>+</Text>
                </Pressable>
              </View>
            ) : null}
            <View style={styles.popupDivider} />
            {terminalMenuSessions.map((session) => (
              <Pressable
                key={session.terminalId}
                style={styles.popupRow}
                onPress={() => {
                  setMenuOpen(false);
                  setTerminalId(session.terminalId);
                  focusKeyboard();
                }}
              >
                <View style={styles.popupRowText}>
                  <Text style={styles.popupLabel}>{session.displayLabel}</Text>
                  <Text style={styles.popupSub} numberOfLines={1}>
                    {getTerminalStatusLabel(session)} · {serverLabel}
                  </Text>
                </View>
                {session.terminalId === terminalId ? (
                  <Check size={18} color={theme.colors.foreground} />
                ) : null}
              </Pressable>
            ))}
            <View style={styles.popupDivider} />
            <Pressable style={styles.popupRow} onPress={openNewTerminal}>
              <View style={styles.popupRowText}>
                <Text style={styles.popupLabel}>Open new terminal</Text>
                <Text style={styles.popupSub} numberOfLines={2}>
                  Start another shell in {serverLabel}
                </Text>
              </View>
              <Plus size={18} color={theme.colors.secondary} />
            </Pressable>
            <View style={styles.popupDivider} />
            <Pressable style={styles.popupRow} onPress={restartCurrentTerminal}>
              <View style={styles.popupRowText}>
                <Text style={styles.popupLabel}>Restart terminal</Text>
              </View>
              <RotateCcw size={16} color={theme.colors.secondary} />
            </Pressable>
            <Pressable style={styles.popupRow} onPress={closeCurrentTerminal}>
              <View style={styles.popupRowText}>
                <Text style={styles.popupLabel}>Close terminal</Text>
              </View>
              <Trash2 size={16} color={theme.colors.secondary} />
            </Pressable>
          </View>
        ) : null}
      </View>

      {terminal.error ? <Text style={styles.error}>{terminal.error}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {menuOpen ? (
        <Pressable
          style={styles.backdrop}
          accessibilityLabel="Close terminal menu"
          onPress={() => setMenuOpen(false)}
        />
      ) : null}

      <Pressable
        style={styles.surfaceWrap}
        onPress={focusKeyboard}
        disabled={!isRunning}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.surfaceScroll}
          contentContainerStyle={styles.surfaceContent}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            pinnedRef.current =
              contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
          }}
          onContentSizeChange={() => {
            if (pinnedRef.current) scrollRef.current?.scrollToEnd({ animated: false });
          }}
        >
          <TerminalSurface
            terminalKey={terminalKey}
            parser={parser}
            version={renderVersion}
            fontSize={fontSize}
            isRunning={isRunning}
            theme={terminalTheme}
            onResize={handleResize}
          />
          {!isRunning && terminal.version === 0 ? (
            <Text style={styles.dim}>Starting shell…</Text>
          ) : null}
        </ScrollView>
      </Pressable>

      {/* Hidden field carries soft-keyboard input straight to the PTY. */}
      <TextInput
        ref={inputRef}
        value={field}
        onChangeText={handleFieldChange}
        onKeyPress={handleKeyPress}
        onSubmitEditing={() => handleInput("\r")}
        autoCapitalize="none"
        autoCorrect={false}
        blurOnSubmit={false}
        returnKeyType="send"
        style={styles.hiddenInput}
      />

      {keyboardVisible ? (
        // iOS overlays the keyboard, so the accessory needs bottom padding
        // to sit flush above it. Android already accounts for the keyboard
        // (resize/pan) — a marginBottom here inflates layout and the OS
        // overshoots, floating the buttons way above the keyboard.
        <View style={[styles.accessory, Platform.OS === "ios" ? { paddingBottom: keyboardHeight } : null]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.accessoryContent}
          >
            <Pressable style={styles.pill} onPress={() => handleInput("\u001b")}>
              <Text style={styles.pillLabel}>esc</Text>
            </Pressable>
            <Pressable
              style={[styles.pill, pendingModifier === "ctrl" && styles.pillActive]}
              onPress={() => setPendingModifier((p) => (p === "ctrl" ? null : "ctrl"))}
            >
              <Text style={[styles.pillLabel, pendingModifier === "ctrl" && styles.pillLabelActive]}>
                CTRL
              </Text>
            </Pressable>
            <Pressable
              style={[styles.pill, pendingModifier === "meta" && styles.pillActive]}
              onPress={() => setPendingModifier((p) => (p === "meta" ? null : "meta"))}
            >
              <Text style={[styles.pillLabel, pendingModifier === "meta" && styles.pillLabelActive]}>
                ALT
              </Text>
            </Pressable>
            <Pressable style={styles.pill} onPress={() => handleInput("\t")}>
              <Text style={styles.pillLabel}>tab</Text>
            </Pressable>
            <Pressable
              style={styles.pill}
              onPress={() => {
                if (!client) return;
                client
                  .call("terminal.clear", { sessionId: SESSION_ID, terminalId })
                  .catch((e) => setError(e instanceof Error ? e.message : String(e)));
              }}
            >
              <Text style={styles.pillLabel}>CLEAR</Text>
            </Pressable>
            <Pressable
              style={styles.dismissBtn}
              accessibilityLabel="Dismiss keyboard"
              onPress={() => {
                inputRef.current?.blur();
                Keyboard.dismiss();
              }}
            >
              <KeyboardIcon size={18} color={theme.colors.foreground} />
            </Pressable>
          </ScrollView>
        </View>
      ) : isRunning ? (
        <Pressable
          style={styles.fab}
          accessibilityLabel="Open keyboard"
          onPress={focusKeyboard}
        >
          <KeyboardIcon size={22} color="#0b0b0c" />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.screen, padding: 16, gap: 8 },
  headerWrap: { zIndex: 10 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerTitle: { flex: 1, gap: 2 },
  title: { color: theme.colors.foreground, fontSize: 20, fontFamily: theme.font.bold },
  subtitle: { color: theme.colors.secondary, fontSize: 12, fontFamily: theme.font.regular },
  iconBtn: {
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 999,
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.card,
  },
  popup: {
    position: "absolute",
    top: 50,
    right: 0,
    width: 300,
    maxWidth: "90%",
    backgroundColor: theme.colors.cardAlt,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 6,
    elevation: 8,
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  popupStatus: {
    color: theme.colors.secondary,
    fontSize: 13,
    fontFamily: theme.font.regular,
    textAlign: "center",
    paddingVertical: 8,
  },
  popupDivider: { height: 1, backgroundColor: theme.colors.border },
  popupRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  popupRowText: { flex: 1, gap: 2 },
  popupLabel: { color: theme.colors.foreground, fontSize: 15, fontFamily: theme.font.medium },
  popupSub: { color: theme.colors.secondary, fontSize: 12, fontFamily: theme.font.regular },
  stepperRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 16, paddingVertical: 10 },
  stepBtn: {
    backgroundColor: theme.colors.card,
    borderRadius: 8,
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  stepLabel: { color: theme.colors.foreground, fontSize: 18, fontFamily: theme.font.bold },
  stepValue: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 14, minWidth: 44, textAlign: "center" },
  error: { color: theme.colors.danger, fontFamily: theme.font.regular, fontSize: 12 },
  dim: { color: theme.colors.secondary, fontFamily: theme.font.regular, fontSize: 14 },
  surfaceWrap: { flex: 1 },
  surfaceScroll: { flex: 1 },
  surfaceContent: { paddingVertical: 8, flexGrow: 1 },
  hiddenInput: { position: "absolute", width: 1, height: 1, opacity: 0 },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 5,
  },
  accessory: { marginHorizontal: -16, paddingHorizontal: 12 },
  accessoryContent: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
  pill: {
    backgroundColor: theme.colors.cardAlt,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  pillActive: { borderColor: "rgba(255,255,255,0.35)" },
  pillLabel: { color: theme.colors.foreground, fontSize: 14, fontFamily: theme.font.medium },
  pillLabelActive: { fontFamily: theme.font.bold },
  dismissBtn: {
    backgroundColor: theme.colors.cardAlt,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 999,
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  fab: {
    position: "absolute",
    right: 20,
    bottom: 24,
    width: 54,
    height: 54,
    borderRadius: 999,
    backgroundColor: "#f5f5f5",
    alignItems: "center",
    justifyContent: "center",
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
});
