export function getTerminalLabel(terminalId: string): string {
  if (terminalId === "term-1") return "Shell";
  const match = /^term-(\d+)$/.exec(terminalId);
  if (match) return `Shell ${match[1]}`;
  return terminalId;
}

export function truncateLabel(label: string, max = 128): string {
  return label.length > max ? label.slice(0, max) : label;
}
