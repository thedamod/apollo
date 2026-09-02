import { z } from "zod";
import { RpcMethod, SystemStatsInput } from "@home-server/contracts";
import type { RpcRegistry } from "../registry.ts";
import type { SystemService } from "../../services/system.ts";

export function registerSystemHandlers(reg: RpcRegistry, sys: SystemService): void {
  reg.registerZod(RpcMethod.systemStats, SystemStatsInput, async (p) => sys.getStats(p));
}
