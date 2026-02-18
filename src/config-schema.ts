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
});

export type DyadConfig = z.infer<typeof DyadConfigSchema>;

/**
 * JSON Schema for Control UI (converted from Zod)
 */
export const dyadChannelConfigSchema = buildChannelConfigSchema(DyadConfigSchema);
