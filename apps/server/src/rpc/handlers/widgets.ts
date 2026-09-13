import {
  RpcMethod,
  WidgetGetInput,
  WidgetUpsertInput,
  WidgetDeleteInput,
} from "@home-server/contracts";
import type { RpcRegistry } from "../registry.ts";
import type { WidgetService } from "../../services/widgets.ts";

export function registerWidgetHandlers(reg: RpcRegistry, svc: WidgetService): void {
  reg.register(RpcMethod.widgetsList, async () => svc.list());
  reg.registerZod(RpcMethod.widgetsGet, WidgetGetInput, async (p) => {
    const d = svc.get(p.id);
    if (!d) throw Object.assign(new Error(`Unknown widget: ${p.id}`), { code: "not_found" });
    return d;
  });
  reg.registerZod(RpcMethod.widgetsUpsert, WidgetUpsertInput, async (p) => svc.upsert(p));
  reg.registerZod(RpcMethod.widgetsDelete, WidgetDeleteInput, async (p) => svc.delete(p.id));
}
