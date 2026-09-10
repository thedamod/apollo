/**
 * Terminal surface — ported 1:1 from t3code
 * `apps/mobile/src/features/terminal/NativeTerminalSurface.tsx`.
 *
 * t3code renders through a native Ghostty view when available and falls back
 * to this text surface otherwise. This app ships Expo Go (no native modules),
 * so the fallback IS the surface — same props, same theme wiring, same
 * grid-size estimation, same Enter-as-CR + Ctrl-C composer.
 */
import { memo, useEffect, useRef } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useAppearancePreferences } from "../appearance/AppearanceContext";
import { getMobileTerminalTheme, type TerminalTheme } from "./terminalTheme";

export interface TerminalSurfaceProps {
  readonly terminalKey: string;
  readonly buffer: string;
  readonly fontSize?: number;
  readonly isRunning: boolean;
  readonly keyboardFocusRequest?: number;
  readonly theme?: TerminalTheme;
  readonly style?: StyleProp<ViewStyle>;
  readonly onInput: (data: string) => void;
  readonly onResize: (size: { readonly cols: number; readonly rows: number }) => void;
}

export function estimateGridSize(input: {
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
}): { readonly cols: number; readonly rows: number } {
  const cellWidth = input.fontSize * 0.62;
  const cellHeight = input.fontSize * 1.35;
  return {
    cols: Math.max(20, Math.min(400, Math.floor(input.width / cellWidth))),
    rows: Math.max(5, Math.min(200, Math.floor(input.height / cellHeight))),
  };
}

export const TerminalSurface = memo(function TerminalSurface(props: TerminalSurfaceProps) {
  const fontSize = props.fontSize ?? 12;
  const inputRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);
  const { themeAppearance, preferences } = useAppearancePreferences();
  const theme = props.theme ?? getMobileTerminalTheme(preferences.themeMode, themeAppearance);
  const statusLabel = props.isRunning
    ? "Connected — output streams live."
    : "Open terminal to start a shell.";

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) {
      props.onResize(estimateGridSize({ width, height, fontSize }));
    }
  };

  useEffect(() => {
    if ((props.keyboardFocusRequest ?? 0) > 0) {
      inputRef.current?.blur();
      const focusFrame = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(focusFrame);
    }

    return undefined;
  }, [props.keyboardFocusRequest]);

  // Autoscroll to the bottom as output streams in (t3code's native surface
  // pins to the cursor; the text fallback pins to the end).
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  }, [props.buffer]);

  return (
    <View
      style={[
        {
          backgroundColor: theme.background,
          borderRadius: 8,
          overflow: "hidden",
          flex: 1,
        },
        props.style,
      ]}
      onLayout={handleLayout}
    >
      <View style={{ flex: 1, paddingHorizontal: 10, paddingVertical: 8 }}>
        <Text style={{ color: theme.mutedForeground, fontSize: 11 }}>{statusLabel}</Text>
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 12, paddingTop: 8 }}
          showsVerticalScrollIndicator={false}
        >
          <Text
            selectable
            style={{
              color: theme.foreground,
              fontFamily: "monospace",
              fontSize,
              lineHeight: Math.round(fontSize * 1.35),
            }}
          >
            {props.buffer || "$ "}
          </Text>
        </ScrollView>
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          borderTopWidth: 1,
          borderTopColor: theme.border,
          padding: 8,
        }}
      >
        <TextInput
          ref={inputRef}
          autoCapitalize="none"
          autoCorrect={false}
          blurOnSubmit={false}
          editable={props.isRunning}
          placeholder="type and press return"
          placeholderTextColor={theme.mutedForeground}
          returnKeyType="send"
          style={{
            color: theme.foreground,
            flex: 1,
            fontFamily: "monospace",
            fontSize: 14,
            padding: 0,
          }}
          onSubmitEditing={(event) => {
            const text = event.nativeEvent.text;
            if (text.length > 0) {
              // Terminal Enter is CR. LF is Ctrl+J and raw-mode TUIs can treat it as J.
              props.onInput(`${text}\r`);
              inputRef.current?.clear();
            }
          }}
        />
        <Pressable
          disabled={!props.isRunning}
          style={({ pressed }) => ({
            opacity: !props.isRunning ? 0.35 : pressed ? 0.65 : 1,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 8,
            backgroundColor: theme.border,
          })}
          onPress={() => props.onInput("\u0003")}
        >
          <Text style={{ color: theme.foreground, fontSize: 11, fontWeight: "700" }}>Ctrl-C</Text>
        </Pressable>
      </View>
    </View>
  );
});
