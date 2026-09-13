import { useEffect } from "react";

type BackHandlerFn = () => boolean;

/**
 * Minimal LIFO back-press stack.
 *
 * Android hardware back *and* the system edge-swipe gesture both surface as
 * `hardwareBackPress`. A single native listener (registered in `App`) drains
 * this stack top-first so open sheets/modals close before tab-level
 * navigation runs, and tab-level navigation runs before the OS exits the app.
 */
const stack: BackHandlerFn[] = [];

export function pushBackHandler(fn: BackHandlerFn): () => void {
  stack.push(fn);
  return () => {
    const i = stack.lastIndexOf(fn);
    if (i !== -1) stack.splice(i, 1);
  };
}

/** Run handlers top-first; true when one of them consumed the press. */
export function handleBackPress(): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    try {
      if (stack[i]()) return true;
    } catch {
      // ignore a misbehaving handler and keep draining
    }
  }
  return false;
}

/** Register `fn` on top of the stack while `enabled` (e.g. a sheet is open). */
export function useBackPress(enabled: boolean, fn: BackHandlerFn) {
  useEffect(() => {
    if (!enabled) return;
    return pushBackHandler(fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
