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
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Keyboard,
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
import { confirmTerminalClose } from "../features/terminal/terminalCloseConfirm";
import { diffFieldText } from "@home-server/shared/fieldInput";
import { terminalDebugLog } from "../features/terminal/terminalDebugLog";
import {
  stagePendingTerminalLaunch,
  takePendingTerminalLaunch,
  type PendingTerminalLaunch,
} from "../features/terminal/terminalLaunchContext";
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

export function TerminalScreen({
  client,
  serverLabel,
  keyboardLift = 0,
}: {
  client: RpcClient | null;
  serverLabel: string;
  keyboardLift?: number;
}) {
  const {
    isReady: hasResolvedFontPreference,
    appearance,
    themeAppearance,
    preferences,
    setTerminalFontSize,
  } = useAppearancePreferences();
  const fontSize = appearance.terminalFontSize;
  const terminalTheme = getMobileTerminalTheme(
    preferences.themeMode,
    themeAppearance,
  );

  const [terminalId, setTerminalId] = useState(DEFAULT_TERMINAL_ID);
  const [menuOpen, setMenuOpen] = useState(false);
  const [textSizeOpen, setTextSizeOpen] = useState(false);
  const [pendingModifier, setPendingModifier] =
    useState<PendingModifier | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [renderVersion, setRenderVersion] = useState(0);
  const [field, setField] = useState(FIELD_SENTINEL);
  const [error, setError] = useState<string | null>(null);
  const [lastGridSize, setLastGridSize] = useState(
    () =>
      getCachedTerminalGridSize({
        sessionId: SESSION_ID,
        terminalId: DEFAULT_TERMINAL_ID,
      }) ?? {
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
      },
  );

  const inputRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);
  const pinnedRef = useRef(true);
  const parserRef = useRef<{
    key: string;
    parser: VtParser;
    fed: number;
  } | null>(null);
  // Stable fallback so the memoized surface never sees a new parser identity.
  const fallbackParserRef = useRef<VtParser | null>(null);
  if (!fallbackParserRef.current) {
    fallbackParserRef.current = new VtParser(DEFAULT_TERMINAL_COLS);
  }
  const runningTerminalKeyRef = useRef<string | null>(null);

  const knownSessions = useKnownTerminalSessions({
    client,
    sessionId: SESSION_ID,
  });

  useEffect(() => {
    setLastGridSize(
      getCachedTerminalGridSize({ sessionId: SESSION_ID, terminalId }) ?? {
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
      },
    );
    setPendingModifier(null);
  }, [terminalId]);

  // Keyboard visibility drives the accessory row vs the floating button.
  // T3Code equivalent: useKeyboardState().isVisible. The bottom offset itself
  // arrives via the keyboardLift prop (measured in App.tsx).
  useEffect(() => {
    const onShow = () => {
      setKeyboardVisible(true);
    };
    const onHide = () => {
      setKeyboardVisible(false);
      // Force-close (system gesture/back button) hides the keyboard WITHOUT
      // blurring the hidden field on some Android IMEs — focus stays held, so
      // the `inputFocused` fallback below keeps the accessory row stuck on
      // screen, and a later focus() is a no-op on an already-focused field
      // (keyboard can never reopen). Release focus here; the next surface tap
      // refocuses cleanly via requestKeyboardFocus.
      setInputFocused(false);
      inputRef.current?.blur();
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

  // Consume-once pending launch for the active terminal (staged by
  // `openNewTerminal` so the new shell inherits the current cwd). Declared
  // before the attach input so the memo below can read it.
  const [pendingLaunch, setPendingLaunch] =
    useState<PendingTerminalLaunch | null>(null);
  useEffect(() => {
    setPendingLaunch(
      takePendingTerminalLaunch({ sessionId: SESSION_ID, terminalId }),
    );
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
    [
      client,
      hasResolvedFontPreference,
      lastGridSize.cols,
      lastGridSize.rows,
      terminalId,
    ],
  );

  const attachInput = useMemo(
    () =>
      terminalAttachInput
        ? {
            sessionId: terminalAttachInput.sessionId,
            terminalId: terminalAttachInput.terminalId,
            cwd:
              knownSessions.find((s) => s.terminalId === terminalId)?.summary
                ?.cwd ??
              pendingLaunch?.cwd ??
              "",
            cols: terminalAttachInput.cols,
            rows: terminalAttachInput.rows,
            ...(pendingLaunch?.env ? { env: pendingLaunch.env } : {}),
            restartIfNotRunning: true,
          }
        : null,
    [knownSessions, pendingLaunch, terminalAttachInput, terminalId],
  );

  const terminal = useAttachedTerminalSession({
    client,
    sessionId: SESSION_ID,
    terminal: attachInput,
  });

  const terminalKey = `${SESSION_ID}:${terminalId}`;
  const isRunning =
    terminal.status === "running" || terminal.status === "starting";

  // `initialInput` from a pending launch is written once the shell runs
  // (t3code `initialInput` parity).
  const sentInitialInputRef = useRef<string | null>(null);
  useEffect(() => {
    const initialInput = pendingLaunch?.initialInput;
    if (!initialInput || !client || !isRunning) return;
    const key = `${terminalKey}:${initialInput.length}`;
    if (sentInitialInputRef.current === key) return;
    sentInitialInputRef.current = key;
    client
      .call("terminal.write", {
        sessionId: SESSION_ID,
        terminalId,
        data: initialInput,
      })
      .catch(() => {});
  }, [client, isRunning, pendingLaunch, terminalId, terminalKey]);

  // Feed PTY output incrementally into the VT grid. Snapshots/clears replace
  // the buffer (it shrinks) — those reset the parser and replay from scratch.
  useEffect(() => {
    let entry = parserRef.current;
    if (!entry || entry.key !== terminalKey) {
      entry = {
        key: terminalKey,
        parser: new VtParser(lastGridSize.cols),
        fed: 0,
      };
      parserRef.current = entry;
    }
    entry.parser.setCols(lastGridSize.cols);
    entry.parser.setViewportRows(lastGridSize.rows);
    if (terminal.buffer.length < entry.fed) {
      entry.parser.feedSnapshot(terminal.buffer);
    } else if (terminal.buffer.length > entry.fed) {
      entry.parser.feed(terminal.buffer.slice(entry.fed));
    } else {
      return;
    }
    entry.fed = terminal.buffer.length;
    // Device-query replies (DSR/DA) the parser queued while feeding must be
    // written back to the PTY or TUIs stall waiting for the answer.
    const replies = entry.parser.takeReplies();
    if (replies.length > 0 && client && isRunning) {
      for (const reply of replies) {
        client
          .call("terminal.write", {
            sessionId: SESSION_ID,
            terminalId,
            data: reply,
          })
          .catch(() => {});
      }
    }
    setRenderVersion((v) => v + 1);
  }, [
    client,
    isRunning,
    lastGridSize.cols,
    terminal.buffer,
    terminal.version,
    terminalId,
    terminalKey,
  ]);

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
          displayLabel: resolveTerminalSessionLabel(
            terminalId,
            terminal.summary,
          ),
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
  // session instead of stranding the user on a dead shell. Dead sessions
  // stay dead until the user restarts them (t3code parity — open/restart are
  // explicit user commands; the server's `restartIfNotRunning` attach flag
  // covers sessions that are missing entirely).
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
  }, [
    isRunning,
    terminal.status,
    terminalAttachInput,
    terminalKey,
    terminalId,
    terminalMenuSessions,
  ]);

  // t3code focus parity: tap-to-focus / FAB / menu-select bump a focus
  // request counter; the effect below performs the actual focus, gated on
  // the terminal running (t3code's `keyboardFocusRequest` running-gate).
  const [focusRequest, setFocusRequest] = useState(0);
  const requestKeyboardFocus = useCallback(
    () => setFocusRequest((n) => n + 1),
    [],
  );
  useEffect(() => {
    if (focusRequest === 0 || !isRunning) return;
    inputRef.current?.focus();
  }, [focusRequest, isRunning]);

  // Autofocus once on mount, like t3code's native surface.
  useEffect(() => {
    const timer = setTimeout(() => setFocusRequest((n) => n + 1), 400);
    return () => clearTimeout(timer);
  }, []);

  const writeInput = useCallback(
    (data: string) => {
      if (!client || data.length === 0) return;
      if (!isRunning) {
        // Never swallow keystrokes silently: a dead shell drops input on the
        // floor, which looks exactly like a hung terminal.
        setError(
          "Shell is not running — press Restart below to open a new shell.",
        );
        return;
      }
      client
        .call("terminal.write", { sessionId: SESSION_ID, terminalId, data })
        .catch((e) => {
          setError(e instanceof Error ? e.message : String(e));
        });
    },
    [client, isRunning, terminalId],
  );

  const handleInput = useCallback(
    (data: string) => {
      if (data.length === 0) return;
      setError(null);
      // Bracketed paste (?2004): wrap user text so TUIs treat it as a paste
      // (t3code web parity). Key encodings (ESC-prefixed) pass through raw.
      const parser = parserRef.current?.parser;
      const text =
        parser?.bracketedPaste && data.length > 1 && !data.startsWith("\u001b")
          ? `\u001b[200~${data}\u001b[201~`
          : data;
      if (pendingModifier === "ctrl") {
        setPendingModifier(null);
        terminalDebugLog("input:ctrl-modifier", { chars: text.length });
        writeInput(applyCtrlModifier(text));
      } else if (pendingModifier === "meta") {
        setPendingModifier(null);
        terminalDebugLog("input:meta-modifier", { chars: text.length });
        writeInput(`\u001b${text}`);
      } else {
        writeInput(text);
      }
    },
    [pendingModifier, writeInput],
  );

  // Long-press the surface to copy the visible screen text (t3code's
  // native selection/copy is owned by Ghostty; here we copy the plain-text
  // grid tail via the clipboard).
  const copyVisibleText = useCallback(() => {
    const parser = parserRef.current?.parser;
    if (!parser) return;
    const text = parser.lines
      .slice(-200)
      .map((line) =>
        line
          .filter((cell) => cell.w !== 0)
          .map((cell) => cell.ch)
          .join("")
          .replace(/\s+$/, ""),
      )
      .join("\n")
      .replace(/\n+$/, "");
    if (!text) return;
    Clipboard.setStringAsync(text)
      .then(() => {
        Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        ).catch(() => {});
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  /** Soft-keyboard typing arrives through the hidden field.
   *
   * Mirrors t3code's native terminal input (`T3TerminalView` iOS/Android):
   * there the field intercept-and-rejects every change (iOS
   * `shouldChangeCharacters → return false`; Android TextWatcher forwarding
   * only the inserted `start,count` range, DEL via a consumed key event, IME
   * set to visible-password + no-suggestions + no-learning), so each
   * keystroke becomes exactly one input event with no reset race. RN has no
   * reject hook, so we emulate it: diff each event against the last observed
   * text and forward only the inserted range (prefix+suffix diff, so fast or
   * batched keystrokes and mid-field cursor placement can't resend), forward
   * deletions as DEL, then clear the native text. The diff baseline is synced
   * synchronously inside the reset (never via the reset echo, which some
   * platforms never deliver) so backspace cannot desync into a duplicate
   * no-op; echoes arrive as exact duplicates and are ignored. Backspace key
   * events feed DEL directly with a 200 ms change-side guard, so key+change
   * pairs (iOS/Samsung) send exactly one DEL while change-only (Gboard) and
   * key-only (hardware/empty field) paths still work.
   */
  const lastTextRef = useRef(FIELD_SENTINEL);
  // Timestamp (Date.now()) of the last Backspace key event — lets change
  // events skip deletions the key event already forwarded. Key/change pairing
  // differs per platform: iOS and Samsung fire BOTH onKeyPress and
  // onChangeText for one press, Gboard fires only the change, hardware fires
  // only the key (empty field = dead key, no change event at all).
  const lastBackspaceKeyAt = useRef(0);
  // Resets are LAZY, not per-keystroke: every programmatic reset gives the
  // keyboard a chance to "restore" composing text, and each restore diffs as
  // phantom input/deletes. The field instead accumulates real user text
  // (diffs stay meaningful) and is reset after 750 ms idle, on submit/blur,
  // or past 64 chars.
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearFieldNow = useCallback(() => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    // Sync the diff baseline synchronously with the reset: a native echo (if
    // the platform sends one at all) then arrives as an exact duplicate and
    // is ignored by the `next === last` early return. Never rely on the echo
    // to sync state — on platforms that don't echo, the baseline would stay
    // stale ("") while the field shows the sentinel, so the NEXT backspace
    // diffs "" -> "" and is swallowed (backspace works once, then dies until
    // the 750 ms idle reset papers over it).
    lastTextRef.current = FIELD_SENTINEL;
    inputRef.current?.setNativeProps({ text: FIELD_SENTINEL });
    // Usually a no-op render (state already equals the sentinel); keeps
    // the controlled value in sync when it diverged (e.g. backspace "").
    setField(FIELD_SENTINEL);
  }, []);
  const scheduleFieldReset = useCallback(() => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(clearFieldNow, 750);
  }, [clearFieldNow]);
  useEffect(
    () => () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    },
    [],
  );
  const handleFieldChange = useCallback(
    (next: string) => {
      const last = lastTextRef.current;
      if (next === last) return; // duplicate event (includes reset echoes)
      // A Backspace key event within the last 200 ms already forwarded this
      // deletion (key+change pair for a single press) — the change side must
      // not send it again. Gboard-style changes arrive with no key event, so
      // the guard is stale and they forward normally.
      const coveredByBackspaceKey = Date.now() - lastBackspaceKeyAt.current < 200;
      // Bare sentinel from longer text is always a genuine bulk delete
      // (coalesced rapid backspaces). Reset echoes can't reach here: they
      // match the synced baseline and return as duplicates above. (The
      // sentinel is single-char by design, so a lone backspace on it yields
      // "" and takes the diff path below.)
      if (next === FIELD_SENTINEL) {
        lastTextRef.current = next;
        if (coveredByBackspaceKey) return;
        if (next.length < last.length) {
          for (let i = 0; i < last.length - next.length; i++) {
            handleInput("\u007f");
          }
        }
        return;
      }
      lastTextRef.current = next;
      if (!isRunning) {
        // Dead shell: swallow input, but keep the field lazy-resetting so a
        // later restart starts from a canonical sentinel.
        if (next !== FIELD_SENTINEL) scheduleFieldReset();
        return;
      }
      // Inserted range between last and next (mirrors Android's
      // onTextChanged start/count — never the whole tail, so an event that
      // arrives before our clear applies can't resend an earlier char).
      const edit = diffFieldText(last, next, FIELD_SENTINEL);
      if (edit.inserted) {
        // Trailing newlines belong to the return key (onSubmitEditing sends
        // them) — never double-send.
        const cleaned = edit.inserted.replace(/[\r\n]+$/, "");
        if (cleaned) {
          handleInput(cleaned.replace(/\r\n?/g, "\r").replace(/\n/g, "\r"));
        }
      } else if (edit.deletes > 0) {
        // Pure deletion (soft backspace on the sentinel) — one DEL per
        // removed char, like t3code's consumed KEYCODE_DEL. Skipped when a
        // Backspace key event just covered it (key+change pair, one press).
        if (coveredByBackspaceKey) {
          terminalDebugLog("field:delete-covered-by-key", {
            deletes: edit.deletes,
          });
        } else {
          if (edit.deletes > 1) {
            terminalDebugLog("field:bulk-delete", {
              deletes: edit.deletes,
              lastLen: last.length,
              nextLen: next.length,
            });
          }
          for (let i = 0; i < edit.deletes; i++) {
            handleInput("\u007f");
          }
        }
      } else {
        terminalDebugLog("field:ignoring-foreign-change", {
          lastLen: last.length,
          nextLen: next.length,
        });
      }
      // An empty field is a dead key (backspace on empty text fires no
      // change event), so it must be re-armed to the sentinel immediately —
      // otherwise the next backspace within the idle window does nothing.
      // Anything else resets lazily to deny the keyboard restore surfaces.
      if (next === "" || next.length > 64) clearFieldNow();
      else scheduleFieldReset();
    },
    [clearFieldNow, handleInput, isRunning, scheduleFieldReset],
  );

  /** Special keys: Backspace plus hardware-keyboard keys.
   *
   * Mirrors t3code's native/iPadOS handling: Escape, arrows, Tab, Shift-Tab
   * (`\E[Z`), and Ctrl+letter combos (sent as control bytes) are encoded
   * before the PTY so hardware keyboards work like the native surface.
   * Backspace also arrives here on hardware keyboards and on iOS/Samsung soft
   * keyboards (whose change event the field handler then skips via the
   * 200 ms guard, so one press still equals exactly one DEL).
   */
  const handleKeyPress = useCallback(
    ({
      nativeEvent,
    }: {
      nativeEvent: {
        key: string;
        shiftKey?: boolean;
        ctrlKey?: boolean;
        metaKey?: boolean;
      };
    }) => {
      // Backspace key event (hardware keyboards, iOS/Samsung soft keyboards):
      // the change event may never come (empty field is a dead key) or may
      // arrive as a duplicate pair — the change side skips itself when this
      // fired within the last 200 ms, so one press always equals one DEL.
      if (nativeEvent.key === "Backspace") {
        lastBackspaceKeyAt.current = Date.now();
        handleInput("\u007f");
        return;
      }
      if (nativeEvent.shiftKey && nativeEvent.key === "Tab") {
        handleInput("\u001b[Z");
        return;
      }
      if (
        (nativeEvent.ctrlKey || nativeEvent.metaKey) &&
        nativeEvent.key.length === 1
      ) {
        handleInput(applyCtrlModifier(nativeEvent.key));
        return;
      }
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
      if (size.cols === lastGridSize.cols && size.rows === lastGridSize.rows)
        return;
      setLastGridSize(size);
      if (!client || !isRunning) return;
      client
        .call("terminal.resize", {
          sessionId: SESSION_ID,
          terminalId,
          cols: size.cols,
          rows: size.rows,
        })
        .catch(() => {});
    },
    [client, isRunning, lastGridSize.cols, lastGridSize.rows, terminalId],
  );

  const openNewTerminal = useCallback(() => {
    const nextId = nextOpenTerminalId({
      listedTerminalIds: terminalMenuSessions.map((s) => s.terminalId),
      activeRouteTerminalId: terminalId,
    });
    // t3code `takePendingTerminalLaunch` parity: the new shell inherits the
    // current working directory (consumed once by the attach input below).
    if (cwd) {
      stagePendingTerminalLaunch({
        target: { sessionId: SESSION_ID, terminalId: nextId },
        launch: { cwd },
      });
    }
    setMenuOpen(false);
    setPendingModifier(null);
    setTerminalId(nextId);
    requestKeyboardFocus();
  }, [cwd, requestKeyboardFocus, terminalId, terminalMenuSessions]);

  const closeCurrentTerminal = useCallback(() => {
    if (!client) return;
    const label = resolveTerminalSessionLabel(terminalId, terminal.summary);
    const doClose = () => {
      setPendingModifier(null);
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
    };
    // Destructive confirm for live shells (t3code `confirmTerminalClose`
    // parity); dead shells close immediately.
    if (!isRunning) {
      doClose();
      return;
    }
    void confirmTerminalClose([label]).then((confirmed) => {
      if (confirmed) doClose();
    });
  }, [client, isRunning, terminal.summary, terminalId, terminalMenuSessions]);

  const restartCurrentTerminal = useCallback(() => {
    if (!client) return;
    // cwd is optional: the server reuses the session's stored cwd when the
    // client has no summary (e.g. restarting a dead shell straight from the
    // dead-shell banner). Prefer the freshest known cwd when available.
    const restartCwd =
      terminal.summary?.cwd ??
      knownSessions.find((s) => s.terminalId === terminalId)?.summary?.cwd ??
      pendingLaunch?.cwd ??
      undefined;
    setError(null);
    setPendingModifier(null);
    client
      .call("terminal.restart", {
        sessionId: SESSION_ID,
        terminalId,
        ...(restartCwd ? { cwd: restartCwd } : {}),
        cols: lastGridSize.cols,
        rows: lastGridSize.rows,
      })
      .then(() => setMenuOpen(false))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [
    client,
    knownSessions,
    lastGridSize.cols,
    lastGridSize.rows,
    pendingLaunch,
    terminal.summary,
    terminalId,
  ]);

  // CLEAR pill: wipe server history AND run the shell's `clear` command so
  // the fresh prompt redraws immediately (like typing `clear` + Enter).
  // The RPC goes first so the command echo and its output land in the fresh
  // history in order. The leading Ctrl-U kills any partial line first, so a
  // half-typed line can never fuse with the command ("d" + clear = "dclear"):
  // readline shells erase the whole line, fullscreen apps treat it as a
  // harmless redraw. The write is raw (no bracketed-paste wrap — this is a
  // command, not a paste). On a dead shell the clear still lands and the
  // write surfaces the not-running hint via writeInput.
  const handleClearPill = useCallback(() => {
    if (!client) return;
    setError(null);
    setPendingModifier(null);
    void (async () => {
      try {
        await client.call("terminal.clear", {
          sessionId: SESSION_ID,
          terminalId,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      writeInput("\u0015clear\r");
    })();
  }, [client, terminalId, writeInput]);

  const stepFontSize = useCallback(
    (direction: -1 | 1) => {
      const next = normalizeTerminalFontSize(
        Math.round((fontSize + direction * 0.5) * 2) / 2,
      );
      setTerminalFontSize(
        Math.max(
          MIN_TERMINAL_FONT_SIZE,
          Math.min(MAX_TERMINAL_FONT_SIZE, next),
        ),
      );
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
            <Pressable
              style={styles.popupRow}
              onPress={() => setTextSizeOpen((v) => !v)}
            >
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
                  setPendingModifier(null);
                  setTerminalId(session.terminalId);
                  requestKeyboardFocus();
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

      {terminal.error ? (
        <Text style={styles.error}>{terminal.error}</Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {/* Dead shell: never leave the user staring at a blank surface with
          input silently dropped (t3code "reverse states" parity — the way
          back out must be visible: close needs reopen). */}
      {!isRunning && terminal.version > 0 ? (
        <View style={styles.deadBar}>
          <Text style={styles.deadText}>
            {terminal.status === "exited"
              ? "Shell exited."
              : terminal.status === "closed"
                ? "Shell closed."
                : "Shell is not running."}{" "}
            Restart to open a new shell.
          </Text>
          <Pressable
            style={styles.deadRestart}
            accessibilityLabel="Restart terminal"
            onPress={restartCurrentTerminal}
          >
            <RotateCcw size={16} color={theme.colors.foreground} />
            <Text style={styles.deadRestartLabel}>Restart</Text>
          </Pressable>
        </View>
      ) : null}

      {menuOpen ? (
        <Pressable
          style={styles.backdrop}
          accessibilityLabel="Close terminal menu"
          onPress={() => setMenuOpen(false)}
        />
      ) : null}

      <Pressable
        style={styles.surfaceWrap}
        onPress={requestKeyboardFocus}
        onLongPress={copyVisibleText}
        disabled={!isRunning}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.surfaceScroll}
          contentContainerStyle={styles.surfaceContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
          scrollEventThrottle={16}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } =
              e.nativeEvent;
            pinnedRef.current =
              contentOffset.y + layoutMeasurement.height >=
              contentSize.height - 40;
          }}
          onContentSizeChange={() => {
            if (pinnedRef.current)
              scrollRef.current?.scrollToEnd({ animated: false });
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

      {/* Hidden field carries soft-keyboard input straight to the PTY.
          IME mirrors t3code's native field (visible-password + no
          suggestions/learning) so commits are always literal keystrokes. */}
      <TextInput
        ref={inputRef}
        value={field}
        onChangeText={handleFieldChange}
        onKeyPress={handleKeyPress}
        onSubmitEditing={() => {
          handleInput("\r");
          clearFieldNow();
        }}
        onFocus={() => setInputFocused(true)}
        onBlur={() => {
          setInputFocused(false);
          clearFieldNow();
        }}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        importantForAutofill="no"
        keyboardType="visible-password"
        blurOnSubmit={false}
        returnKeyType="send"
        style={styles.hiddenInput}
      />

      {controlsOpen ? (
        // Bottom offset comes from the shell (keyboard height minus whatever
        // the OS already shrank): full lift in pan mode (Expo Go), ~0 in
        // resize mode (dev build). Either way flush, like T3Code's
        // KeyboardStickyView with offset 0.
        <View
          style={[
            styles.accessory,
            keyboardLift > 0 ? { marginBottom: keyboardLift } : null,
          ]}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            contentContainerStyle={styles.accessoryContent}
          >
            <Pressable
              style={styles.pill}
              onPress={() => handleInput("\u001b")}
            >
              <Text style={styles.pillLabel}>esc</Text>
            </Pressable>
            <Pressable
              style={[
                styles.pill,
                pendingModifier === "ctrl" && styles.pillActive,
              ]}
              onPress={() =>
                setPendingModifier((p) => (p === "ctrl" ? null : "ctrl"))
              }
            >
              <Text
                style={[
                  styles.pillLabel,
                  pendingModifier === "ctrl" && styles.pillLabelActive,
                ]}
              >
                CTRL
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.pill,
                pendingModifier === "meta" && styles.pillActive,
              ]}
              onPress={() =>
                setPendingModifier((p) => (p === "meta" ? null : "meta"))
              }
            >
              <Text
                style={[
                  styles.pillLabel,
                  pendingModifier === "meta" && styles.pillLabelActive,
                ]}
              >
                ALT
              </Text>
            </Pressable>
            <Pressable style={styles.pill} onPress={() => handleInput("\t")}>
              <Text style={styles.pillLabel}>tab</Text>
            </Pressable>
            <Pressable style={styles.pill} onPress={handleClearPill}>
              <Text style={styles.pillLabel}>CLEAR</Text>
            </Pressable>
            <Pressable
              style={styles.pill}
              onPress={() => handleInput("\u001b[A")}
            >
              <Text style={styles.pillLabel}>↑</Text>
            </Pressable>
            <Pressable
              style={styles.pill}
              onPress={() => handleInput("\u001b[B")}
            >
              <Text style={styles.pillLabel}>↓</Text>
            </Pressable>
            <Pressable
              style={styles.pill}
              onPress={() => handleInput("\u001b[D")}
            >
              <Text style={styles.pillLabel}>←</Text>
            </Pressable>
            <Pressable
              style={styles.pill}
              onPress={() => handleInput("\u001b[C")}
            >
              <Text style={styles.pillLabel}>→</Text>
            </Pressable>
            <Pressable style={styles.pill} onPress={() => handleInput("~")}>
              <Text style={styles.pillLabel}>~</Text>
            </Pressable>
            <Pressable style={styles.pill} onPress={() => handleInput("|")}>
              <Text style={styles.pillLabel}>|</Text>
            </Pressable>
            <Pressable style={styles.pill} onPress={() => handleInput("/")}>
              <Text style={styles.pillLabel}>/</Text>
            </Pressable>
            <Pressable style={styles.pill} onPress={() => handleInput("-")}>
              <Text style={styles.pillLabel}>-</Text>
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
          onPress={requestKeyboardFocus}
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
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: { flex: 1, gap: 2 },
  title: {
    color: theme.colors.foreground,
    fontSize: 20,
    fontFamily: theme.font.bold,
  },
  subtitle: {
    color: theme.colors.secondary,
    fontSize: 12,
    fontFamily: theme.font.regular,
  },
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
  popupLabel: {
    color: theme.colors.foreground,
    fontSize: 15,
    fontFamily: theme.font.medium,
  },
  popupSub: {
    color: theme.colors.secondary,
    fontSize: 12,
    fontFamily: theme.font.regular,
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingVertical: 10,
  },
  stepBtn: {
    backgroundColor: theme.colors.card,
    borderRadius: 8,
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  stepLabel: {
    color: theme.colors.foreground,
    fontSize: 18,
    fontFamily: theme.font.bold,
  },
  stepValue: {
    color: theme.colors.foreground,
    fontFamily: "monospace",
    fontSize: 14,
    minWidth: 44,
    textAlign: "center",
  },
  error: {
    color: theme.colors.danger,
    fontFamily: theme.font.regular,
    fontSize: 12,
  },
  deadBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: theme.colors.cardAlt,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  deadText: {
    flex: 1,
    color: theme.colors.secondary,
    fontFamily: theme.font.regular,
    fontSize: 13,
  },
  deadRestart: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  deadRestartLabel: {
    color: theme.colors.foreground,
    fontSize: 14,
    fontFamily: theme.font.medium,
  },
  dim: {
    color: theme.colors.secondary,
    fontFamily: theme.font.regular,
    fontSize: 14,
  },
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
  accessoryContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
  },
  pill: {
    backgroundColor: theme.colors.cardAlt,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  pillActive: { borderColor: "rgba(255,255,255,0.35)" },
  pillLabel: {
    color: theme.colors.foreground,
    fontSize: 14,
    fontFamily: theme.font.medium,
  },
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
