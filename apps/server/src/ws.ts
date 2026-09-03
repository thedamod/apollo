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
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ error: { code: "bad_request", message: "Invalid JSON" } }));
        return;
      }

      // Streaming attach: terminal.attach
      if (msg.method === "terminal.attach") {
        try {
          const params = msg.params ?? {};
          const send = (ev: unknown) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "event", channel: `terminal:${params.sessionId}:${params.terminalId}`, payload: ev }));
            }
          };
          const cleanup = await opts.terminalManager.attachStream(params, async (ev) => send(ev));
          cleanups.push(cleanup);
          // ack
          ws.send(JSON.stringify({ id: msg.id, result: { attached: true } }));
        } catch (e: any) {
          ws.send(JSON.stringify({ id: msg.id, error: { code: e.code ?? "unknown", message: e.message } }));
        }
        return;
      }

      // Generic subscriptions
      if (msg.method === "terminal.subscribe") {
        const cleanup = opts.terminalManager.subscribe((ev) => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "event", channel: "terminal", payload: ev }));
        });
        cleanups.push(cleanup);
        ws.send(JSON.stringify({ id: msg.id, result: { subscribed: true } }));
        return;
      }
      if (msg.method === "scripts.subscribe") {
        const cleanup = opts.scriptService.onEvent((ev) => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "event", channel: "scripts", payload: ev }));
        });
        cleanups.push(cleanup);
        ws.send(JSON.stringify({ id: msg.id, result: { subscribed: true } }));
        return;
      }
      if (msg.method === "services.subscribe" || msg.method === "servicesSubscribe") {
        const cleanup = opts.serviceManager.onEvent((ev) => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "event", channel: "services", payload: ev }));
        });
        cleanups.push(cleanup);
        ws.send(JSON.stringify({ id: msg.id, result: { subscribed: true } }));
        // immediate snapshot
        try {
          const list = opts.serviceManager.list();
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "event", channel: "services", payload: { type: "snapshot", services: list } }));
        } catch {}
        return;
      }
      if (msg.method === "system.statsSubscribe") {
        // push stats every 2s
        const interval = setInterval(async () => {
          try {
            const stats = await opts.systemService.getStats({});
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ type: "event", channel: "system", payload: stats }));
          } catch {}
        }, 2000);
        cleanups.push(() => clearInterval(interval));
        ws.send(JSON.stringify({ id: msg.id, result: { subscribed: true } }));
        // immediate
        opts.systemService.getStats({}).then((stats) => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "event", channel: "system", payload: stats }));
        });
        return;
      }

      // Normal RPC
      const { id, method, params } = msg;
      if (!id || !method) {
        ws.send(JSON.stringify({ error: { code: "bad_request", message: "Missing id/method" } }));
        return;
      }
      try {
        const result = await opts.registry.call(method, params, { token: null, reqId: id });
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, result: result ?? null }));
      } catch (e: any) {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ id, error: { code: e.code ?? "unknown", message: e.message ?? String(e) } }));
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
