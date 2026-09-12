/**
 * Terminal close confirmation — ported from t3code
 * `apps/web/src/lib/terminalCloseConfirm.ts`.
 *
 * Web uses `localApi.dialogs.confirm`; mobile uses `Alert.alert`. Same
 * copy, same pending-counter guard against double-prompts.
 */
import { Alert } from "react-native";

let pendingConfirmations = 0;

export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

/** Confirm closing a live terminal. Dead terminals close without asking. */
export function confirmTerminalClose(
  labels: ReadonlyArray<string>,
): Promise<boolean> {
  if (labels.length === 0) return Promise.resolve(true);
  const title =
    labels.length === 1
      ? `Close terminal "${labels[0]}"?`
      : `Close ${labels.length} terminals?`;
  const quoted = labels.map((label) => `"${label}"`).join(", ");
  const message =
    labels.length === 1
      ? "This stops the running process and clears its history."
      : `This stops the running processes and clears their history: ${quoted}.`;
  pendingConfirmations += 1;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      pendingConfirmations -= 1;
      resolve(value);
    };
    Alert.alert(
      title,
      message,
      [
        { text: "Cancel", style: "cancel", onPress: () => settle(false) },
        {
          text:
            labels.length === 1
              ? "Close terminal"
              : `Close ${labels.length} terminals`,
          style: "destructive",
          onPress: () => settle(true),
        },
      ],
      { cancelable: true, onDismiss: () => settle(false) },
    );
  });
}
