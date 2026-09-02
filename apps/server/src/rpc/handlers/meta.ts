import { RpcMethod } from "@home-server/contracts";
import type { RpcRegistry } from "../registry.ts";
import type { ServerConfig } from "../../config.ts";

export function registerMetaHandlers(reg: RpcRegistry, config: ServerConfig): void {
  reg.register(RpcMethod.serverProbe, async () => ({ ok: true }));
  reg.register(RpcMethod.serverGetInfo, async () => ({
    name: "home-server",
    version: "0.1.0",
    uptimeSeconds: Math.floor(process.uptime()),
    port: config.port,
  }));
}
