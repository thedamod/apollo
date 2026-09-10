/**
 * Terminal labels — ported 1:1 from t3code `packages/shared/src/terminalLabels.ts`.
 *
 * Ids are ALWAYS client-chosen (`term-1`, `term-2`, …); the server never allocates.
 */

export function getTerminalLabel(terminalId: string): string {
  const numericSuffix = /^term(?:inal)?-(\d+)$/i.exec(terminalId)?.[1];
  if (numericSuffix) {
    return `Terminal ${numericSuffix}`;
  }

  return terminalId;
}

/** Prefer server summary label when present; otherwise fall back to `getTerminalLabel`. */
export function resolveTerminalSessionLabel(
  terminalId: string,
  summary: { label?: string | null } | null | undefined,
): string {
  const trimmed = summary?.label?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  return getTerminalLabel(terminalId);
}

/**
 * Client-side terminal id allocator. Returns the lowest unused `term-N` id
 * (starting at `term-1`), skipping any ids already in `existingTerminalIds`.
 */
export function nextTerminalId(existingTerminalIds: ReadonlyArray<string>): string {
  const usedIds = new Set(existingTerminalIds.filter((id) => id.trim().length > 0));
  let nextIndex = 1;
  while (usedIds.has(`term-${nextIndex}`)) {
    nextIndex += 1;
  }

  return `term-${nextIndex}`;
}

export function truncateLabel(label: string, max = 128): string {
  return label.length > max ? label.slice(0, max) : label;
}
