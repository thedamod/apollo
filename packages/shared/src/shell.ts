/** Port of t3code shell resolution helpers, simplified. */

export function defaultShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") return "pwsh.exe";
  return env.SHELL ?? "bash";
}

export function normalizeShellCommand(cmd: string | undefined, platform: NodeJS.Platform): string | null {
  if (!cmd) return null;
  const t = cmd.trim();
  if (t.length === 0) return null;
  if (platform === "win32") return t;
  const first = t.split(/\s+/)[0]?.trim();
  if (!first) return null;
  return first.replace(/^['"]|['"]$/g, "");
}

export function basenameForPlatform(command: string, platform: NodeJS.Platform): string {
  const normalized = platform === "win32" ? command.replaceAll("/", "\\") : command.replaceAll("\\", "/");
  const parts = normalized.split(platform === "win32" ? /\\+/ : /\/+/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}
