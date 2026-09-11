import {
  RpcMethod,
  ScriptGetInput,
  ScriptUpsertInput,
  ScriptDeleteInput,
  ScriptRunInput,
  ScriptStopInput,
  ScriptLogsInput,
  ScriptRunsInput,
  ScriptGetRunInput,
} from "@home-server/contracts";
import { z } from "zod";
import type { RpcRegistry } from "../registry.ts";
import type { ScriptService } from "../../services/scripts.ts";

export function registerScriptHandlers(reg: RpcRegistry, svc: ScriptService): void {
  reg.register(RpcMethod.scriptsList, async () => svc.list());
  reg.registerZod(RpcMethod.scriptsGet, ScriptGetInput, async (p) => {
    const d = svc.get(p.id);
    if (!d) throw Object.assign(new Error(`Unknown script: ${p.id}`), { code: "not_found" });
    return d;
  });
  reg.registerZod(RpcMethod.scriptsUpsert, ScriptUpsertInput, async (p) => svc.upsert(p));
  reg.registerZod(RpcMethod.scriptsDelete, ScriptDeleteInput, async (p) => svc.delete(p.id));
  reg.registerZod(RpcMethod.scriptsRun, ScriptRunInput, async (p) => svc.runScript(p.id));
  reg.registerZod(RpcMethod.scriptsStop, ScriptStopInput, async (p) => svc.stop(p.runId));
  reg.registerZod(RpcMethod.scriptsLogs, ScriptLogsInput, async (p) => {
    const content = await svc.readLogs(p.runId, p.tailLines);
    return { runId: p.runId, content };
  });
  reg.registerZod(RpcMethod.scriptsRuns, ScriptRunsInput, async (p) => svc.listRunsFiltered(p ?? {}));
  reg.registerZod(RpcMethod.scriptsGetRun, ScriptGetRunInput, async (p) => {
    const r = svc.getRun(p.runId);
    if (!r) throw Object.assign(new Error(`Unknown run: ${p.runId}`), { code: "not_found" });
    return r;
  });
}
