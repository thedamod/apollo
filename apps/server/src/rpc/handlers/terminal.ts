import {
  RpcMethod,
  TerminalOpenInput,
  TerminalWriteInput,
  TerminalResizeInput,
  TerminalClearInput,
  TerminalRestartInput,
  TerminalCloseInput,
} from "@home-server/contracts";
import { z } from "zod";
import type { RpcRegistry } from "../registry.ts";
import type { TerminalManager } from "../../services/terminal/manager.ts";

export function registerTerminalHandlers(reg: RpcRegistry, tm: TerminalManager): void {
  reg.registerZod(RpcMethod.terminalOpen, TerminalOpenInput, async (p) => tm.open(p as any));
  reg.registerZod(RpcMethod.terminalWrite, TerminalWriteInput, async (p) => tm.write(p));
  reg.registerZod(RpcMethod.terminalResize, TerminalResizeInput, async (p) => tm.resize(p));
  reg.registerZod(RpcMethod.terminalClear, TerminalClearInput, async (p) => tm.clear(p));
  reg.registerZod(RpcMethod.terminalRestart, TerminalRestartInput, async (p) => tm.restart(p as any));
  reg.registerZod(RpcMethod.terminalClose, TerminalCloseInput, async (p) => tm.close(p));
  reg.registerZod(
    RpcMethod.terminalList,
    z.object({ sessionId: z.string().optional() }),
    async (p) => tm.list((p as any).sessionId),
  );
  // terminal.attach is handled as streaming subscription via WsRouter
}
