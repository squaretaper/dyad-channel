import { buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { z } from "zod";

/**
 * Zod schema for channels.dyad.* configuration
 */
export const DyadConfigSchema = z.object({
  /** Account name (optional display name) */
  name: z.string().optional(),

  /** Whether this channel is enabled */
  enabled: z.boolean().optional(),

  /**
   * Bot token — base64-encoded JSON containing Supabase credentials
   * and workspace identity. Generated from Dyad dashboard.
   */
  token: z.string().optional(),

  /**
   * DM access policy.
   * For Dyad, default is "open" since workspace membership handles access control.
   */
  dmPolicy: z.enum(["open", "disabled"]).optional(),

  /**
   * Max coordination chain depth before hard-stopping inter-agent replies.
   * Default: 4 (per v5 spec §7.3).
   */
  maxCoordinationDepth: z.number().min(1).max(10).optional(),

  /**
   * Confidence falloff curve — threshold at each chain depth.
   * Signal confidence must meet or exceed the threshold for its depth
   * to trigger a follow-up dispatch (Phase 2, currently shadow-mode).
   * Default: [0.5, 0.7, 0.85, 0.95] (per v5 spec §7.3).
   */
  confidenceFalloff: z.array(z.number().min(0).max(1)).optional(),
});

export type DyadConfig = z.infer<typeof DyadConfigSchema>;

/**
 * JSON Schema for Control UI (converted from Zod)
 */
export const dyadChannelConfigSchema = buildChannelConfigSchema(DyadConfigSchema);
