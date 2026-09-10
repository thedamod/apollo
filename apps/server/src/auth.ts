import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "@effect/platform/FileSystem";

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

// ---------------------------------------------------------------------------
// Effect-native
// ---------------------------------------------------------------------------

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  cause: Schema.optional(Schema.Defect),
}) {}

export function ensureTokenEffect(tokenPath: string): Effect.Effect<string, AuthError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const existing = yield* fs.readFileString(tokenPath).pipe(
      Effect.map((s) => s.trim()),
      Effect.filterOrFail(
        (s) => s.length > 10,
        () => new AuthError({ cause: "empty token" }),
      ),
      Effect.orElseSucceed(() => null as string | null),
    );
    if (existing) return existing;
    const token = generateToken();
    const dir = path.dirname(tokenPath);
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
    yield* fs.writeFileString(tokenPath, token + "\n").pipe(
      Effect.catchAll((cause) => Effect.fail(new AuthError({ cause }))),
    );
    // best-effort chmod 600
    yield* fs
      .chmod(tokenPath, 0o600)
      .pipe(Effect.orElseSucceed(() => undefined));
    return token;
  });
}

export function verifyTokenEffect(
  headerValue: string | undefined,
  expected: string,
): Effect.Effect<boolean> {
  return Effect.sync(() => verifyToken(headerValue, expected));
}
