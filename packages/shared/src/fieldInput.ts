/**
 * Hidden-field input diffing — pure helpers behind the terminal screen's soft
 * keyboard field (`screens/Terminal.tsx`).
 *
 * The field is kept at a one-char sentinel so backspace always produces a
 * change event; after forwarding input the screen resets it and syncs the
 * diff baseline synchronously (never via the reset echo, which some platforms
 * never deliver — otherwise the next backspace diffs stale state and is
 * swallowed). Event delivery from soft keyboards is not strictly ordered
 * (rapid typing, composing-text restores), so the diff must never mistake a
 * reset echo for user input:
 *
 * - A reset echo reproduces the synced baseline exactly, so it arrives as a
 *   duplicate (`next === last`) and is skipped. The bare sentinel from longer
 *   text is therefore always a genuine bulk delete down to the bare field
 *   (coalesced rapid backspaces), in which case every removed char still
 *   earns its DEL.
 * - Anything else is diffed with a prefix/suffix split and only the inserted
 *   range is forwarded, so batched keystrokes and mid-field cursor placement
 *   can never resend earlier input (mirrors Android's onTextChanged
 *   start/count and t3code's intercept-and-reject native field).
 */

export interface FieldEdit {
  /** Raw inserted slice (empty when nothing was inserted). */
  readonly inserted: string;
  /** Number of removed chars (DELs to send) when nothing was inserted. */
  readonly deletes: number;
}

/**
 * Prefix/suffix diff between the last observed field text and the new one.
 *
 * `sentinel` is the one-char reset value the screen holds the field at: while
 * it is still the leading char it was never forwarded as input, so a wipe
 * down to `""` must not bill it — otherwise every bulk delete to empty sends
 * one phantom DEL ("deletes more than I pressed"). A last text with no
 * sentinel prefix (accumulated/foreign state) bills every removed char. The
 * lone-backspace shape (`sentinel` -> `""`) still maps to exactly one DEL.
 */
export function diffFieldText(
  last: string,
  next: string,
  sentinel = " ",
): FieldEdit {
  let prefix = 0;
  while (
    prefix < last.length &&
    prefix < next.length &&
    last[prefix] === next[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < last.length - prefix &&
    suffix < next.length - prefix &&
    last[last.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++;
  }
  const inserted = next.slice(prefix, next.length - suffix);
  if (inserted) {
    return { inserted, deletes: 0 };
  }
  if (next.length < last.length) {
    const deletes =
      next === "" && last !== sentinel && last.startsWith(sentinel)
        ? Math.max(0, last.length - 1)
        : last.length - next.length;
    return { inserted: "", deletes };
  }
  return { inserted: "", deletes: 0 };
}
