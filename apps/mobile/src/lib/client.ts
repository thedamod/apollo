/**
 * Minimal JSON-RPC WebSocket client for home-server.
 *
 * Mirrors `cli/client.mjs` wire format and t3code's connection semantics:
 *  - auth via `?token=` query (server `apps/server/src/ws.ts` also accepts
 *    `Authorization: Bearer`, which RN WebSocket can't send — so query it is)
 *  - request/response: `{ id, method, params }` -> `{ id, result|error }`
 *  - subscriptions: `system.statsSubscribe`, `services.subscribe`,
 *    `scripts.subscribe` then `{ type:"event", channel, payload }` frames
 *  - pairing: `GET <baseUrl>/pair?token=pair_...` -> `{ token }`
 *    (server `apps/server/src/http.ts` + `bin.ts pair`)
 *  - tailscale: server runs `tailscale serve --bg --https=443
 *    http://127.0.0.1:<port>` when started with `--tailscale`
 *    (see `@home-server/tailscale`). The app just connects to whatever
 *    URL the user gives it — LAN ip, 100.x tailnet ip, or MagicDNS name —
 *    over http(s)/ws(s). No native Tailscale SDK needed.
 */
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export interface ServerEntry {
  /** stable id, e.g. `srv_<rand>` */
  id: string;
  /** user label, e.g. "Aether-PC (tailnet)" */
  label: string;
  /** base URL, e.g. http://192.168.1.10:7070 or https://aether.tailabcd.ts.net */
  baseUrl: string;
  /** long-lived bearer token (`home-server token`) */
  token: string;
}
/** Backwards-compat alias (single-server code paths). */
export type ConnectionProfile = ServerEntry;

export interface ParsedServerUrl {
  baseUrl: string;
  host: string;
  port: number;
  secure: boolean;
  wsUrl: string;
}

const STORE_KEY = "aether-connection-v1";
const CATALOG_KEY = "aether-servers-v2";

export interface ServerCatalog {
  servers: ServerEntry[];
  activeId: string | null;
}

export function newServerId(): string {
  return `srv_${Math.random().toString(36).slice(2, 10)}`;
}

function defaultLabel(baseUrl: string): string {
  try {
    const { host } = parseServerUrl(baseUrl);
    return host;
  } catch {
    return baseUrl;
  }
}

/** Load the server catalog, migrating the legacy single-profile key once. */
export async function loadCatalog(): Promise<ServerCatalog> {
  try {
    const raw = await SecureStore.getItemAsync(CATALOG_KEY);
    if (raw) {
      const c = JSON.parse(raw) as ServerCatalog;
      if (Array.isArray(c.servers)) return { servers: c.servers, activeId: c.activeId ?? null };
    }
  } catch {}
  // migrate v1 single profile -> catalog
  try {
    const legacy = await SecureStore.getItemAsync(STORE_KEY);
    if (legacy) {
      const p = JSON.parse(legacy) as { baseUrl: string; token: string; label?: string };
      if (p.baseUrl && p.token) {
        const entry: ServerEntry = {
          id: newServerId(),
          label: p.label || defaultLabel(p.baseUrl),
          baseUrl: p.baseUrl,
          token: p.token,
        };
        const catalog: ServerCatalog = { servers: [entry], activeId: entry.id };
        await SecureStore.setItemAsync(CATALOG_KEY, JSON.stringify(catalog));
        await SecureStore.deleteItemAsync(STORE_KEY);
        return catalog;
      }
    }
  } catch {}
  return { servers: [], activeId: null };
}

export async function saveCatalog(c: ServerCatalog): Promise<void> {
  await SecureStore.setItemAsync(CATALOG_KEY, JSON.stringify(c));
}

/** @deprecated single-profile era; kept for migration only. */
export async function loadProfile(): Promise<ConnectionProfile | null> {
  const c = await loadCatalog();
  return c.servers.find((s) => s.id === c.activeId) ?? null;
}

/** @deprecated use saveCatalog. */
export async function saveProfile(p: ConnectionProfile): Promise<void> {
  const c = await loadCatalog();
  const servers = c.servers.some((s) => s.id === p.id) ? c.servers.map((s) => (s.id === p.id ? p : s)) : [...c.servers, p];
  await saveCatalog({ servers, activeId: p.id });
}

export async function clearProfile(): Promise<void> {
  await saveCatalog({ servers: [], activeId: null });
}

export function parseServerUrl(raw: string): ParsedServerUrl {
  let v = raw.trim();
  if (!v) throw new Error("Enter a server URL");
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`;
  const u = new URL(v);
  const secure = u.protocol === "https:";
  const port = u.port ? Number(u.port) : secure ? 443 : 80;
  const baseUrl = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
  const wsProto = secure ? "wss" : "ws";
  return {
    baseUrl,
    host: u.hostname,
    port,
    secure,
    wsUrl: `${wsProto}://${u.hostname}${u.port ? `:${u.port}` : ""}/ws`,
  };
}

/** Exchange a pairing URL (from `home-server pair` / server startup log) for a token. */
export async function redeemPairingUrl(pairingUrl: string, label?: string): Promise<ServerEntry> {
  const u = new URL(pairingUrl.trim());
  const baseUrl = `${u.protocol}//${u.host}`;
  const res = await fetch(pairingUrl.trim(), { method: "GET" });
  if (res.status === 401) throw classifiedError("blocked", "Pairing token expired — mint a fresh one with `home-server pair`");
  if (!res.ok) throw classifiedError("transient", `Pairing failed (HTTP ${res.status})`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw classifiedError("blocked", "Pairing response had no token");
  return { id: newServerId(), label: label?.trim() || defaultLabel(baseUrl), baseUrl, token: body.token };
}

/**
 * t3code-style error classes: `transient` (network/timeout/transport —
 * safe to retry with backoff) vs `blocked` (auth/configuration — retrying
 * is pointless, surface to the user).
 */
export type ConnectErrorKind = "transient" | "blocked";

export class ConnectError extends Error {
  kind: ConnectErrorKind;
  constructor(kind: ConnectErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export function classifiedError(kind: ConnectErrorKind, message: string): ConnectError {
  return new ConnectError(kind, message);
}

export function classifyError(e: unknown): ConnectError {
  if (e instanceof ConnectError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/401|unauthorized|invalid token|expired|forbidden/i.test(msg)) return classifiedError("blocked", msg);
  return classifiedError("transient", msg);
}

export async function checkHealth(baseUrl: string): Promise<{ ok: boolean; version?: string }> {
  const res = await fetch(`${baseUrl}/health`);
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return (await res.json()) as { ok: boolean; version?: string };
}

type Resolver = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type EventHandler = (channel: string, payload: unknown) => void;

export class RpcClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string, Resolver>();
  private handlers = new Set<EventHandler>();
  private closeHandlers = new Set<(expected: boolean) => void>();
  private expectedClose = false;
  private url: string;

  constructor(private profile: ConnectionProfile) {
    const { wsUrl } = parseServerUrl(profile.baseUrl);
    this.url = `${wsUrl}?token=${encodeURIComponent(profile.token)}`;
  }

  get profileSnapshot(): ConnectionProfile {
    return this.profile;
  }

  /** Fired when the socket closes; `expected` is true for intentional disconnects. */
  onClose(h: (expected: boolean) => void): () => void {
    this.closeHandlers.add(h);
    return () => {
      this.closeHandlers.delete(h);
    };
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // RN's WebSocket has no headers option — token rides the query string,
        // which the server accepts (apps/server/src/ws.ts).
        const ws = new WebSocket(this.url);
        const timeout = setTimeout(() => {
          try {
            ws.close();
          } catch {}
          reject(new Error("Connection timed out"));
        }, 10_000);
        ws.onopen = () => {
          clearTimeout(timeout);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("Could not reach server — check URL, network, and Tailscale status"));
        };
        ws.onmessage = (ev) => this.handleMessage(String((ev as MessageEvent).data));
        ws.onclose = () => {
          for (const [, r] of this.pending) {
            clearTimeout(r.timer);
            r.reject(new Error("disconnected"));
          }
          this.pending.clear();
          const wasExpected = this.expectedClose;
          this.expectedClose = false;
          for (const h of this.closeHandlers) {
            try {
              h(wasExpected);
            } catch {}
          }
        };
        this.ws = ws as unknown as WebSocket;
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  close(): void {
    this.expectedClose = true;
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }

  onEvent(h: EventHandler): () => void {
    this.handlers.add(h);
    return () => {
      this.handlers.delete(h);
    };
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws;
    if (!ws || (ws as unknown as { readyState: number }).readyState !== 1) {
      return Promise.reject(new Error("Not connected"));
    }
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Request timed out"));
      }, 12_000);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Fire-and-forget subscribe; server acks with { subscribed:true } then streams events. */
  subscribe(method: string, params: Record<string, unknown> = {}): void {
    const ws = this.ws;
    if (!ws) return;
    ws.send(JSON.stringify({ id: String(this.nextId++), method, params }));
  }

  private handleMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const m = msg as { id?: string; result?: unknown; error?: { code?: string; message?: string }; type?: string; channel?: string; payload?: unknown };
    if (m.type === "event" && m.channel) {
      for (const h of this.handlers) {
        try {
          h(m.channel, m.payload);
        } catch {}
      }
      return;
    }
    if (m.id && this.pending.has(m.id)) {
      const r = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      clearTimeout(r.timer);
      if (m.error) r.reject(new Error(m.error.message ?? m.error.code ?? "rpc error"));
      else r.resolve(m.result);
    }
  }
}

/** React Native app identifier for logs / pairing display. */
export function deviceLabel(): string {
  return Platform.OS === "ios" ? "iOS app" : Platform.OS === "android" ? "Android app" : "Expo app";
}
