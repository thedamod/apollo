/**
 * Extensible RPC registry — mirrors t3code's RpcGroup but minimal.
 * Now Effect-native: handlers can return Effect, validation uses TaggedErrors.
 */
import { z } from "zod";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export type RpcHandler = (params: unknown, ctx: RpcContext) => Promise<unknown>;
export type RpcHandlerEffect = (params: unknown, ctx: RpcContext) => Effect.Effect<unknown, RpcError>;
export interface RpcContext {
  token: string | null;
  reqId: string;
}

export interface RegisteredRpc {
  method: string;
  inputSchema?: z.ZodTypeAny;
  handler: RpcHandler;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class RpcAlreadyRegisteredError extends Schema.TaggedError<RpcAlreadyRegisteredError>()(
  "RpcAlreadyRegisteredError",
  { method: Schema.String },
) {
  get message() {
    return `RPC method already registered: ${this.method}`;
  }
}

export class RpcNotFoundError extends Schema.TaggedError<RpcNotFoundError>()("RpcNotFoundError", {
  method: Schema.String,
}) {
  get message() {
    return `Unknown method: ${this.method}`;
  }
}

export class RpcBadRequestError extends Schema.TaggedError<RpcBadRequestError>()(
  "RpcBadRequestError",
  {
    method: Schema.String,
    details: Schema.optional(Schema.Unknown),
    cause: Schema.optional(Schema.Defect),
  },
) {
  get message() {
    return `Invalid params for ${this.method}`;
  }
}

export type RpcError = RpcAlreadyRegisteredError | RpcNotFoundError | RpcBadRequestError;

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

export class RpcRegistryTag extends Context.Tag("home-server/RpcRegistry")<
  RpcRegistryTag,
  RpcRegistry
>() {}

export class RpcRegistry {
  private map = new Map<string, RegisteredRpc>();

  register(method: string, handler: RpcHandler, inputSchema?: z.ZodTypeAny): void {
    if (this.map.has(method)) throw new RpcAlreadyRegisteredError({ method });
    this.map.set(method, { method, handler, inputSchema });
  }

  registerZod<I, O>(method: string, input: z.ZodType<I>, handler: (params: I, ctx: RpcContext) => Promise<O>): void {
    this.register(
      method,
      async (raw, ctx) => {
        const parsed = input.safeParse(raw ?? {});
        if (!parsed.success) {
          throw new RpcBadRequestError({ method, details: parsed.error.flatten() });
        }
        return handler(parsed.data, ctx);
      },
      input,
    );
  }

  registerEffect<I, O, E>(
    method: string,
    input: z.ZodType<I>,
    handler: (params: I, ctx: RpcContext) => Effect.Effect<O, E>,
  ): void {
    this.register(
      method,
      (raw, ctx) =>
        Effect.runPromise(
          Effect.gen(this, function* () {
            const parsed = input.safeParse(raw ?? {});
            if (!parsed.success) {
              return yield* Effect.fail(new RpcBadRequestError({ method, details: parsed.error.flatten() }));
            }
            return yield* handler(parsed.data, ctx);
          }),
        ),
      input,
    );
  }

  has(method: string): boolean {
    return this.map.has(method);
  }

  async call(method: string, params: unknown, ctx: RpcContext): Promise<unknown> {
    const reg = this.map.get(method);
    if (!reg) throw new RpcNotFoundError({ method });
    return reg.handler(params, ctx);
  }

  callEffect(method: string, params: unknown, ctx: RpcContext): Effect.Effect<unknown, RpcError> {
    const reg = this.map.get(method);
    if (!reg) return Effect.fail(new RpcNotFoundError({ method }));
    return Effect.tryPromise({
      try: () => reg.handler(params, ctx),
      catch: (cause) => (cause instanceof RpcBadRequestError || cause instanceof RpcNotFoundError ? cause : (cause as RpcError)),
    });
  }

  methods(): string[] {
    return [...this.map.keys()];
  }
}

export const RpcRegistryLive = Layer.succeed(RpcRegistryTag, new RpcRegistry());
