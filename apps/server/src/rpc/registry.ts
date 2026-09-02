/**
 * Extensible RPC registry — mirrors t3code's RpcGroup but minimal.
 * Handlers register with `register(method, schema, handler)`.
 * New features add a file under rpc/handlers/ and import it in server.ts.
 */
import { z } from "zod";

export type RpcHandler = (params: unknown, ctx: RpcContext) => Promise<unknown>;
export interface RpcContext {
  token: string | null;
  reqId: string;
}

export interface RegisteredRpc {
  method: string;
  inputSchema?: z.ZodTypeAny;
  handler: RpcHandler;
}

export class RpcRegistry {
  private map = new Map<string, RegisteredRpc>();

  register(method: string, handler: RpcHandler, inputSchema?: z.ZodTypeAny): void {
    if (this.map.has(method)) throw new Error(`RPC method already registered: ${method}`);
    this.map.set(method, { method, handler, inputSchema });
  }

  registerZod<I, O>(method: string, input: z.ZodType<I>, handler: (params: I, ctx: RpcContext) => Promise<O>): void {
    this.register(
      method,
      async (raw, ctx) => {
        const parsed = input.safeParse(raw ?? {});
        if (!parsed.success) {
          throw Object.assign(new Error(`Invalid params for ${method}: ${parsed.error.message}`), {
            code: "bad_request",
            details: parsed.error.flatten(),
          });
        }
        return handler(parsed.data, ctx);
      },
      input,
    );
  }

  has(method: string): boolean {
    return this.map.has(method);
  }

  async call(method: string, params: unknown, ctx: RpcContext): Promise<unknown> {
    const reg = this.map.get(method);
    if (!reg) throw Object.assign(new Error(`Unknown method: ${method}`), { code: "not_found" });
    return reg.handler(params, ctx);
  }

  methods(): string[] {
    return [...this.map.keys()];
  }
}
