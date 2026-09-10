import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "./logger.ts";
import { verifyToken } from "./auth.ts";
import type { RpcRegistry } from "./rpc/registry.ts";
import type { TerminalManager } from "./services/terminal/manager.ts";
import type { ScriptService } from "./services/scripts.ts";
import type { ServiceManager } from "./services/serviceManager.ts";
import type { SystemService } from "./services/system.ts";

/**
 * WebSocket RPC layer — minimal JSON RPC with subscriptions.
 *
 * Extensibility: streaming is done via `terminal.attach` etc. New streaming
 * methods can be added by registering a channel name and pushing events with
 * `broadcast(channel, payload)`. Clients subscribe implicitly via the initial
 * attach call.
 */
export interface WsRouterOptions {
  server: Server;
  registry: RpcRegistry;
  expectedToken: string;
  terminalManager: TerminalManager;
  scriptService: ScriptService;
  serviceManager: ServiceManager;
  systemService: SystemService;
}

export function attachWsRouter(opts: WsRouterOptions): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, path: "/ws" });

  opts.server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/ws") return;
    // auth via query token or header
    const qToken = url.searchParams.get("token");
    const hdr = req.headers.authorization as string | undefined;
    const token = qToken ?? (hdr?.startsWith("Bearer ") ? hdr.slice(7) : undefined);
    if (!token || !verifyToken(token, opts.expectedToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    logger.info("ws connected", { clients: wss.clients.size });

    // keep track of subscription cleanups
    const cleanups: Array<() => void> = [];

    // heartbeat
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30_000);
    cleanups.push(() => clearInterval(pingInterval));

    ws.on("message", async (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString()) as { method?: string; params?: unknown; id?: string };
      } catch {
        ws.send(JSON.stringify({ error: { code: "bad_request", message: "Invalid JSON" } }));
        return;
      }
      const typedMsg = msg as { method?: string; params?: unknown; id?: string };

      // Streaming attach: terminal.attach
      if (typedMsg.method === "terminal.attach") {
        try {
          const params = (typedMsg.params ?? {}) as { sessionId: string; terminalId: string };
          const send = (ev: unknown) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "event", channel: `terminal:${params.sessionId}:${params.terminalId}`, payload: ev }));
            }
          };
          const cleanup = await opts.terminalManager.attachStream(params as unknown as Parameters<typeof opts.terminalManager.attachStream>[0], async (ev) => send(ev));
          cleanups.push(cleanup);
          ws.send(JSON.stringify({ id: typedMsg.id, result: { attached: true } }));
        } catch (e: unknown) {
          const err = e as { code?: string; message?: string };
          ws.send(JSON.stringify({ id: typedMsg.id, error: { code: err.code ?? "unknown", message: err.message ?? String(e) } }));
        }
        return;
      }

      // Generic subscriptions
      if (typedMsg.method === "terminal.subscribe") {
        const cleanup = opts.terminalManager.subscribe((ev) => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "event", channel: "terminal", payload: ev }));
        });
        cleanups.push(cleanup);
        ws.send(JSON.stringify({ id: typedMsg.id, result: { subscribed: true } }));
        return;
      }
      if (typedMsg.method === "scripts.subscribe") {
        const cleanup = opts.scriptService.onEvent((ev) => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "event", channel: "scripts", payload: ev }));
        });
        cleanups.push(cleanup);
        ws.send(JSON.stringify({ id: typedMsg.id, result: { subscribed: true } }));
        return;
      }
      if (typedMsg.method === "services.subscribe" || typedMsg.method === "servicesSubscribe") {
        const cleanup = opts.serviceManager.onEvent((ev) => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "event", channel: "services", payload: ev }));
        });
        cleanups.push(cleanup);
        ws.send(JSON.stringify({ id: typedMsg.id, result: { subscribed: true } }));
        // immediate snapshot
        try {
          const list = opts.serviceManager.list();
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "event", channel: "services", payload: { type: "snapshot", services: list } }));
        } catch {}
        return;
      }
      if (typedMsg.method === "system.statsSubscribe") {
        // push stats every 2s
        const interval = setInterval(async () => {
          try {
            const stats = await opts.systemService.getStats({});
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ type: "event", channel: "system", payload: stats }));
          } catch {}
        }, 2000);
        cleanups.push(() => clearInterval(interval));
        ws.send(JSON.stringify({ id: typedMsg.id, result: { subscribed: true } }));
        // immediate
        opts.systemService.getStats({}).then((stats) => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "event", channel: "system", payload: stats }));
        });
        return;
      }

      // Normal RPC
      const { id, method, params } = typedMsg;
      if (!id || !method) {
        ws.send(JSON.stringify({ error: { code: "bad_request", message: "Missing id/method" } }));
        return;
      }
      try {
        const result = await opts.registry.call(method, params, { token: null, reqId: id });
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, result: result ?? null }));
      } catch (e: unknown) {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ id, error: { code: (e as { code?: string }).code ?? "unknown", message: (e as Error).message ?? String(e) } }));
      }
    });

    ws.on("close", () => {
      for (const c of cleanups) {
        try {
          c();
        } catch {}
      }
      logger.info("ws disconnected", { clients: wss.clients.size });
    });
    ws.on("error", (err) => logger.warn("ws error", { error: String(err) }));
  });

  return wss;
}
