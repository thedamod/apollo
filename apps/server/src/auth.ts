import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
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

// pairing: short, human-friendly token like t3code (12 chars, no 0/O/1/I)
// Alphabet: 23456789ABCDEFGHJKLMNPQRSTUVWXYZ — easy to read/type
const PAIRING_TOKEN_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIRING_TOKEN_LENGTH = 12;
const PAIRING_TOKEN_REJECTION_LIMIT =
  Math.floor(256 / PAIRING_TOKEN_ALPHABET.length) * PAIRING_TOKEN_ALPHABET.length;

const pairingStore = new Map<string, { createdAt: number; expiresAt: number }>();

export function createPairingToken(ttlMs = 10 * 60 * 1000): string {
  let t = "";
  while (t.length < PAIRING_TOKEN_LENGTH) {
    const bytes = crypto.randomBytes(PAIRING_TOKEN_LENGTH);
    for (const b of bytes) {
      if (b >= PAIRING_TOKEN_REJECTION_LIMIT) continue;
      t += PAIRING_TOKEN_ALPHABET[b % PAIRING_TOKEN_ALPHABET.length]!;
      if (t.length === PAIRING_TOKEN_LENGTH) break;
    }
  }
  const now = Date.now();
  pairingStore.set(t, { createdAt: now, expiresAt: now + ttlMs });
  // cleanup expired
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

// ── connection string helpers — mirrors t3code apps/server/src/startupAccess.ts ─────

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host || host.length === 0) return true;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.startsWith("127.");
}

export function isWildcardHost(host: string | undefined): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

export function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function normalizeHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function resolveHeadlessConnectionHost(
  host: string | undefined,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string {
  if (!host) return "localhost";
  if (!isWildcardHost(host)) return normalizeHost(host);
  const entries = Object.values(interfaces).flatMap((e) => e ?? []);
  const externalIpv4 = entries.find((e) => !e.internal && (e.family === "IPv4" || (e.family as unknown as number) === 4));
  if (externalIpv4) return externalIpv4.address;
  const externalIpv6 = entries.find((e) => !e.internal && (e.family === "IPv6" || (e.family as unknown as number) === 6));
  return externalIpv6 ? normalizeHost(externalIpv6.address) : "localhost";
}

export function resolveHeadlessConnectionString(
  host: string | undefined,
  port: number,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string {
  const connectionHost = resolveHeadlessConnectionHost(host, interfaces);
  return `http://${formatHostForUrl(connectionHost)}:${port}`;
}

export function connectionStringFromConfig(port: number, host: string): string {
  return resolveHeadlessConnectionString(host, port);
}

export function buildPairingUrl(connectionString: string, token: string): string {
  const url = new URL(connectionString);
  url.pathname = "/pair";
  url.search = "";
  url.hash = new URLSearchParams([["token", token]]).toString();
  return url.toString();
}

export function pairingUrlFromConfig(port: number, host: string, pairingToken: string): string {
  const connectionString = resolveHeadlessConnectionString(host, port);
  return buildPairingUrl(connectionString, pairingToken);
}

export function getPairingTokenFromUrl(url: URL | string): string | null {
  const u = typeof url === "string" ? new URL(url) : url;
  const hash = new URLSearchParams(u.hash.startsWith("#") ? u.hash.slice(1) : u.hash).get("token")?.trim();
  if (hash) return hash;
  const q = u.searchParams.get("token")?.trim();
  return q && q.length > 0 ? q : null;
}

export function getPairingTokenFromRequest(req: { query?: Record<string, unknown>; headers?: Record<string, unknown>; url?: string }): string | null {
  const q = (req.query?.token as string | undefined)?.trim();
  if (q) return q;
  const h = (req.headers?.["x-pairing-token"] as string | undefined)?.trim();
  if (h) return h;
  if (req.url) {
    try {
      return getPairingTokenFromUrl(new URL(req.url, "http://localhost"));
    } catch {
      return null;
    }
  }
  return null;
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
