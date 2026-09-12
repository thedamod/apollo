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

function openErrorCode(tag: string): string {
  switch (tag) {
    case "TerminalCwdNotFoundError":
    case "TerminalSessionLookupError":
    case "TerminalNotFoundError":
      return "not_found";
    case "TerminalCwdNotDirectoryError":
      return "not_directory";
    case "TerminalCwdStatError":
      return "stat_error";
    case "TerminalHistoryError":
      return "history_error";
    default:
      return "unknown";
  }
}

export function registerTerminalHandlers(
  reg: RpcRegistry,
  tm: TerminalManager,
): void {
  reg.registerZod(RpcMethod.terminalOpen, TerminalOpenInput, async (p) =>
    tm.open(p as TerminalOpenInput).catch((e: unknown) => {
      const err = e as Error & { code?: string };
      // `tm.open` already maps to coded Errors; pass through.
      throw err;
    }),
  );
  reg.registerZod(RpcMethod.terminalWrite, TerminalWriteInput, async (p) =>
    tm.write(p),
  );
  reg.registerZod(RpcMethod.terminalResize, TerminalResizeInput, async (p) =>
    tm.resize(p),
  );
  reg.registerZod(RpcMethod.terminalClear, TerminalClearInput, async (p) =>
    tm.clear(p),
  );
  reg.registerZod(RpcMethod.terminalRestart, TerminalRestartInput, async (p) =>
    tm.restart(p as TerminalRestartInput).catch((e: unknown) => {
      const err = e as Error & { code?: string };
      if (!err.code)
        throw Object.assign(new Error(err.message), {
          code: openErrorCode((err as { _tag?: string })._tag ?? ""),
        });
      throw err;
    }),
  );
  reg.registerZod(RpcMethod.terminalClose, TerminalCloseInput, async (p) =>
    tm.close(p),
  );
  reg.registerZod(
    RpcMethod.terminalList,
    z.object({ sessionId: z.string().optional() }),
    async (p) => tm.list((p as { sessionId?: string }).sessionId),
  );
  // terminal.attach / terminal.detach / terminal.subscribe /
  // terminal.subscribeMetadata are streaming subscriptions via WsRouter.
}
