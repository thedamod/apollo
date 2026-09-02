import { RpcMethod, TunnelConfigureInput } from "@home-server/contracts";
import { z } from "zod";
import type { RpcRegistry } from "../registry.ts";
import type { TunnelService } from "../../services/tunnel.ts";

export function registerTunnelHandlers(reg: RpcRegistry, tunnel: TunnelService): void {
  reg.register(RpcMethod.tunnelGet, async () => tunnel.getInfo());
  reg.registerZod(RpcMethod.tunnelConfigure, TunnelConfigureInput, async (p) => tunnel.configure(p));
}
