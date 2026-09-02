import { z } from "zod";

export const TunnelProviderKind = z.enum(["tailscale", "cloudflare", "frp", "disabled"]);
export type TunnelProviderKind = z.infer<typeof TunnelProviderKind>;

export const TunnelStatus = z.enum(["disconnected", "connecting", "connected", "error", "disabled"]);
export type TunnelStatus = z.infer<typeof TunnelStatus>;

export const TunnelInfo = z.object({
  provider: TunnelProviderKind,
  status: TunnelStatus,
  publicUrl: z.string().nullable(), // e.g. https://foo.ts.net or https://foo.trycloudflare.com
  localPort: z.number().int().min(1).max(65535),
  error: z.string().nullable(),
  updatedAt: z.string(),
});
export type TunnelInfo = z.infer<typeof TunnelInfo>;

export const TunnelConfigureInput = z.object({
  provider: TunnelProviderKind,
  enabled: z.boolean().optional().default(true),
  // provider-specific options forwarded as JSON
  options: z.record(z.unknown()).optional(),
});
export type TunnelConfigureInput = z.infer<typeof TunnelConfigureInput>;
