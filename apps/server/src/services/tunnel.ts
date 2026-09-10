import type { TunnelInfo, TunnelProviderKind } from "@home-server/contracts";
import * as tailscale from "@home-server/tailscale";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class TunnelError extends Schema.TaggedError<TunnelError>()("TunnelError", {
  provider: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface TunnelProvider {
  readonly kind: TunnelProviderKind;
  ensure(localPort: number, opts?: Record<string, unknown>): Promise<string | null>;
  disable(): Promise<void>;
  probe(publicUrl: string): Promise<boolean>;
  getStatus(): Promise<TunnelInfo>;
}

export class TunnelServiceTag extends Context.Tag("home-server/TunnelService")<
  TunnelServiceTag,
  {
    readonly configure: (input: {
      provider: TunnelProviderKind;
      options?: Record<string, unknown>;
    }) => Effect.Effect<TunnelInfo, TunnelError>;
    readonly getInfo: () => Effect.Effect<TunnelInfo, never>;
    readonly ensure: () => Effect.Effect<TunnelInfo, never>;
    readonly shutdown: () => Effect.Effect<void, never>;
  }
>() {}

/** Tailscale provider — wraps @home-server/tailscale */
export class TailscaleTunnelProvider implements TunnelProvider {
  readonly kind: TunnelProviderKind = "tailscale";
  private publicUrl: string | null = null;
  private status: TunnelInfo["status"] = "disconnected";
  private error: string | null = null;

  constructor(
    private readonly localPort: number,
    private readonly servePort: number = 443,
  ) {}

  ensureEffect(localPort: number, _opts?: Record<string, unknown>): Effect.Effect<string | null, TunnelError> {
    return Effect.gen(this, function* () {
      this.status = "connecting";
      this.error = null;
      const st = yield* Effect.tryPromise({
        try: () => tailscale.readTailscaleStatus(),
        catch: () => null as unknown as Awaited<ReturnType<typeof tailscale.readTailscaleStatus>> | null,
      }).pipe(Effect.orElseSucceed(() => null as unknown as Awaited<ReturnType<typeof tailscale.readTailscaleStatus>> | null));
      if (!st?.magicDnsName) {
        this.status = "error";
        this.error = "Not logged into tailscale (no MagicDNS)";
        this.publicUrl = null;
        return null;
      }
      yield* Effect.tryPromise({
        try: () => tailscale.ensureTailscaleServe({ localPort, servePort: this.servePort }),
        catch: (cause) => new TunnelError({ provider: "tailscale", cause }),
      }).pipe(Effect.catchAll((e) => Effect.fail(e as TunnelError)));
      this.publicUrl = tailscale.buildTailscaleHttpsBaseUrl({
        magicDnsName: st.magicDnsName,
        servePort: this.servePort,
      });
      this.status = "connected";
      return this.publicUrl;
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.gen(this, function* () {
          this.status = "error";
          this.error = cause instanceof Error ? cause.message : String(cause);
          this.publicUrl = null;
          return null;
        }),
      ),
    );
  }

  async ensure(localPort: number, _opts?: Record<string, unknown>): Promise<string | null> {
    return Effect.runPromise(this.ensureEffect(localPort, _opts));
  }

  async disable(): Promise<void> {
    await Effect.runPromise(
      Effect.tryPromise({
        try: () => tailscale.tryDisableTailscaleServe({ servePort: this.servePort }),
        catch: () => undefined as void,
      }).pipe(Effect.orElseSucceed(() => undefined)),
    );
    this.status = "disconnected";
    this.publicUrl = null;
    this.error = null;
  }

  async probe(publicUrl: string): Promise<boolean> {
    return tailscale.probeTailscaleHttpsEndpoint({ baseUrl: publicUrl });
  }

  async getStatus(): Promise<TunnelInfo> {
    return {
      provider: "tailscale",
      status: this.status,
      publicUrl: this.publicUrl,
      localPort: this.localPort,
      error: this.error,
      updatedAt: new Date().toISOString(),
    };
  }
}

export class DisabledTunnelProvider implements TunnelProvider {
  readonly kind: TunnelProviderKind = "disabled";
  constructor(private readonly localPort: number) {}
  async ensure(): Promise<string | null> {
    return null;
  }
  async disable(): Promise<void> {}
  async probe(): Promise<boolean> {
    return false;
  }
  async getStatus(): Promise<TunnelInfo> {
    return {
      provider: "disabled",
      status: "disabled",
      publicUrl: null,
      localPort: this.localPort,
      error: null,
      updatedAt: new Date().toISOString(),
    };
  }
}

/** Extensible registry — add cloudflare/frp providers here */
export class TunnelService {
  private provider: TunnelProvider;

  constructor(
    localPort: number,
    kind: TunnelProviderKind = "disabled",
    servePort = 443,
  ) {
    this.provider = this.createProvider(kind, localPort, servePort);
  }

  private createProvider(kind: TunnelProviderKind, localPort: number, servePort: number): TunnelProvider {
    switch (kind) {
      case "tailscale":
        return new TailscaleTunnelProvider(localPort, servePort);
      case "disabled":
        return new DisabledTunnelProvider(localPort);
      default:
        return new DisabledTunnelProvider(localPort);
    }
  }

  configureEffect(input: {
    provider: TunnelProviderKind;
    options?: Record<string, unknown>;
  }): Effect.Effect<TunnelInfo, TunnelError> {
    return Effect.gen(this, function* () {
      if (input.provider !== this.provider.kind) {
        yield* Effect.tryPromise({
          try: () => this.provider.disable(),
          catch: () => undefined as void,
        }).pipe(Effect.orElseSucceed(() => undefined));
        const localPort = (yield* Effect.promise(() => this.provider.getStatus())).localPort;
        this.provider = this.createProvider(input.provider, localPort, 443);
      }
      if (input.provider === "disabled") {
        yield* Effect.tryPromise({
          try: () => this.provider.disable(),
          catch: () => undefined as void,
        }).pipe(Effect.orElseSucceed(() => undefined));
        return yield* Effect.promise(() => this.provider.getStatus());
      }
      const info = yield* Effect.promise(() => this.provider.getStatus());
      yield* Effect.tryPromise({
        try: () => this.provider.ensure(info.localPort, input.options),
        catch: (cause) => new TunnelError({ provider: input.provider, cause }),
      }).pipe(Effect.catchAll(() => Effect.succeed(null as string | null)));
      return yield* Effect.promise(() => this.provider.getStatus());
    });
  }

  async configure(input: { provider: TunnelProviderKind; options?: Record<string, unknown> }): Promise<TunnelInfo> {
    return Effect.runPromise(this.configureEffect(input).pipe(Effect.orElseSucceed(() => ({ provider: input.provider, status: "error" as const, publicUrl: null, localPort: 0, error: "configure failed", updatedAt: new Date().toISOString() } as TunnelInfo))));
  }

  getInfoEffect(): Effect.Effect<TunnelInfo> {
    return Effect.promise(() => this.provider.getStatus());
  }

  async getInfo(): Promise<TunnelInfo> {
    return Effect.runPromise(this.getInfoEffect());
  }

  ensureEffect(): Effect.Effect<TunnelInfo> {
    return Effect.gen(this, function* () {
      const info = yield* Effect.promise(() => this.provider.getStatus());
      if (info.provider !== "disabled" && info.status !== "connected") {
        yield* Effect.tryPromise({
          try: () => this.provider.ensure(info.localPort),
          catch: () => null as string | null,
        }).pipe(Effect.orElseSucceed(() => null as string | null));
      }
      return yield* Effect.promise(() => this.provider.getStatus());
    });
  }

  async ensure(): Promise<TunnelInfo> {
    return Effect.runPromise(this.ensureEffect());
  }

  shutdownEffect(): Effect.Effect<void> {
    return Effect.tryPromise({
      try: () => this.provider.disable(),
      catch: () => undefined as void,
    }).pipe(Effect.orElseSucceed(() => undefined));
  }

  async shutdown(): Promise<void> {
    await Effect.runPromise(this.shutdownEffect());
  }
}

export const TunnelServiceLive = (localPort: number, kind: TunnelProviderKind = "disabled", servePort = 443) =>
  Layer.succeed(TunnelServiceTag, TunnelServiceTag.of({
    configure: (input) => new TunnelService(localPort, kind, servePort).configureEffect(input),
    getInfo: () => new TunnelService(localPort, kind, servePort).getInfoEffect(),
    ensure: () => new TunnelService(localPort, kind, servePort).ensureEffect(),
    shutdown: () => new TunnelService(localPort, kind, servePort).shutdownEffect(),
  }));
