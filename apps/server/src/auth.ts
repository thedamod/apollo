import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export function generateToken(): string {
  return `hs_${crypto.randomBytes(32).toString("hex")}`;
}

export function ensureToken(tokenPath: string): string {
  try {
    if (fs.existsSync(tokenPath)) {
      const existing = fs.readFileSync(tokenPath, "utf8").trim();
      if (existing.length > 10) return existing;
    }
  } catch {}
  const token = generateToken();
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  return token;
}

export function verifyToken(headerValue: string | undefined, expected: string): boolean {
  if (!headerValue) return false;
  const token = headerValue.startsWith("Bearer ") ? headerValue.slice(7) : headerValue;
  // constant-time compare
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// pairing: generates a short-lived pairing token that exchanges for the real token
const pairingStore = new Map<string, { createdAt: number; expiresAt: number }>();

export function createPairingToken(ttlMs = 10 * 60 * 1000): string {
  const t = `pair_${crypto.randomBytes(16).toString("hex")}`;
  const now = Date.now();
  pairingStore.set(t, { createdAt: now, expiresAt: now + ttlMs });
  // cleanup
  for (const [k, v] of pairingStore) if (v.expiresAt < now) pairingStore.delete(k);
  return t;
}

export function consumePairingToken(token: string): boolean {
  const v = pairingStore.get(token);
  if (!v) return false;
  if (v.expiresAt < Date.now()) {
    pairingStore.delete(token);
    return false;
  }
  pairingStore.delete(token);
  return true;
}

export function pairingUrlFromConfig(port: number, host: string, pairingToken: string): string {
  const h = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${h}:${port}/pair?token=${pairingToken}`;
}
