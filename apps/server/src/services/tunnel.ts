import type { TunnelInfo, TunnelProviderKind } from "@home-server/contracts";
import * as tailscale from "@home-server/tailscale";

export interface TunnelProvider {
  readonly kind: TunnelProviderKind;
  ensure(localPort: number, opts?: Record<string, unknown>): Promise<string | null>; // returns publicUrl
  disable(): Promise<void>;
  probe(publicUrl: string): Promise<boolean>;
  getStatus(): Promise<TunnelInfo>;
}

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

  async ensure(localPort: number, _opts?: Record<string, unknown>): Promise<string | null> {
    this.status = "connecting";
    this.error = null;
    try {
      const st = await tailscale.readTailscaleStatus().catch(() => null);
      if (!st?.magicDnsName) {
        this.status = "error";
        this.error = "Not logged into tailscale (no MagicDNS)";
        this.publicUrl = null;
        return null;
      }
      await tailscale.ensureTailscaleServe({ localPort, servePort: this.servePort });
      this.publicUrl = tailscale.buildTailscaleHttpsBaseUrl({
        magicDnsName: st.magicDnsName,
        servePort: this.servePort,
      });
      this.status = "connected";
      return this.publicUrl;
    } catch (e: any) {
      this.status = "error";
      this.error = e.message;
      this.publicUrl = null;
      return null;
    }
  }

  async disable(): Promise<void> {
    await tailscale.tryDisableTailscaleServe({ servePort: this.servePort });
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
      // extensible: cloudflare, frp
      default:
        return new DisabledTunnelProvider(localPort);
    }
  }

  async configure(input: { provider: TunnelProviderKind; options?: Record<string, unknown> }): Promise<TunnelInfo> {
    // if switching provider, disable old
    if (input.provider !== this.provider.kind) {
      await this.provider.disable().catch(() => {});
      const localPort = (await this.provider.getStatus()).localPort;
      this.provider = this.createProvider(input.provider, localPort, 443);
    }
    if (input.provider === "disabled") {
      await this.provider.disable();
      return this.provider.getStatus();
    }
    const info = await this.provider.getStatus();
    await this.provider.ensure(info.localPort, input.options as any);
    return this.provider.getStatus();
  }

  async getInfo(): Promise<TunnelInfo> {
    return this.provider.getStatus();
  }

  async ensure(): Promise<TunnelInfo> {
    const info = await this.provider.getStatus();
    if (info.provider !== "disabled" && info.status !== "connected") {
      await this.provider.ensure(info.localPort);
    }
    return this.provider.getStatus();
  }

  async shutdown(): Promise<void> {
    await this.provider.disable().catch(() => {});
  }
}
