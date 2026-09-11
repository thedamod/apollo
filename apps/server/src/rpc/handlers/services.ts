import {
  RpcMethod,
  ServiceGetInput,
  ServiceCreateInput,
  ServiceUpdateInput,
  ServiceDeleteInput,
  ServiceStartInput,
  ServiceStopInput,
  ServiceRestartInput,
  ServiceLogsInput,
  ServiceStatusInput,
  ServiceDiscoverInput,
  ServiceSetEnabledInput,
} from "@home-server/contracts";
import type { RpcRegistry } from "../registry.ts";
import type { ServiceManager } from "../../services/serviceManager.ts";

export function registerServiceHandlers(reg: RpcRegistry, svc: ServiceManager): void {
  reg.register(RpcMethod.servicesList, async () => svc.list());
  reg.registerZod(RpcMethod.servicesGet, ServiceGetInput, async (p) => {
    const s = svc.get(p.id);
    if (!s) throw Object.assign(new Error(`Unknown service: ${p.id}`), { code: "not_found" });
    return s;
  });
  reg.registerZod(RpcMethod.servicesCreate, ServiceCreateInput, async (p) => svc.create(p as unknown as Parameters<ServiceManager["create"]>[0]));
  reg.registerZod(RpcMethod.servicesUpdate, ServiceUpdateInput, async (p) => {
    const { id, ...patch } = p;
    return svc.update(id, patch as unknown as Parameters<ServiceManager["update"]>[1]);
  });
  reg.registerZod(RpcMethod.servicesDelete, ServiceDeleteInput, async (p) => svc.delete(p.id));
  reg.registerZod(RpcMethod.servicesStart, ServiceStartInput, async (p) => svc.start(p.id));
  reg.registerZod(RpcMethod.servicesStop, ServiceStopInput, async (p) => svc.stop(p.id, p.killSignal));
  reg.registerZod(RpcMethod.servicesRestart, ServiceRestartInput, async (p) => svc.restart(p.id));
  reg.registerZod(RpcMethod.servicesLogs, ServiceLogsInput, async (p) => {
    const content = await svc.readLogs(p.id, p.tailLines);
    return { id: p.id, content };
  });
  reg.registerZod(RpcMethod.servicesStatus, ServiceStatusInput, async (p) => svc.getStatus(p.id));
  reg.registerZod(RpcMethod.servicesDiscover, ServiceDiscoverInput, async (p) => svc.discover(p ?? {}));
  reg.registerZod(RpcMethod.servicesSetEnabled, ServiceSetEnabledInput, async (p) => svc.setEnabled(p.id, p.enabled));
}
