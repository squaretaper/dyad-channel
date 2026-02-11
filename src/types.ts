import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { decodeBotToken, type DyadBotToken } from "./token.js";

export interface DyadAccountConfig {
  enabled?: boolean;
  name?: string;
  token?: string;
  dmPolicy?: "open" | "disabled";
  coordChatId?: string;
  apiUrl?: string;
  botToken?: string;
  botName?: string;
  gatewayUrl?: string;
  gatewayToken?: string;
}

export interface ResolvedDyadAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  /** Raw bot token string — OpenClaw framework checks this as string for readiness */
  botToken: string;
  /** Raw app token string — OpenClaw framework requires this for readiness (reuse compound token) */
  appToken: string;
  /** Decoded bot token (null if not configured or invalid) */
  decodedToken: DyadBotToken | null;
  /** Bot ID from token */
  botId: string;
  /** Bot user ID from token */
  botUserId: string;
  /** Supabase URL from token */
  supabaseUrl: string;
  /** Supabase anon key from token */
  supabaseKey: string;
  /** Coordination chat ID (UUID) — null if coordination not configured */
  coordChatId: string | null;
  /** Dyad API URL for posting coordination messages */
  apiUrl: string;
  /** Hex API token for bot auth with Dyad API — null if not configured */
  apiBotToken: string | null;
  /** Bot display name for coordination speaker identity */
  botName: string;
  /** OpenClaw gateway URL for LLM calls */
  gatewayUrl: string;
  /** OpenClaw gateway bearer token — null if not configured */
  gatewayToken: string | null;
  /** Raw config */
  config: DyadAccountConfig;
}

const DEFAULT_ACCOUNT_ID = "default";

/**
 * List all configured Dyad account IDs.
 * Always returns default account — isConfigured handles the actual check.
 */
export function listDyadAccountIds(cfg: OpenClawConfig): string[] {
  const dyadCfg = (cfg.channels as Record<string, unknown> | undefined)?.dyad as
    | DyadAccountConfig
    | undefined;

  // Always return default account if dyad config section exists
  // isConfigured will determine if the token is valid
  if (dyadCfg) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return [];
}

/**
 * Get the default account ID
 */
export function resolveDefaultDyadAccountId(cfg: OpenClawConfig): string {
  const ids = listDyadAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve a Dyad account from config.
 * Decodes the bot token to extract Supabase credentials and workspace identity.
 */
export function resolveDyadAccount(opts: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedDyadAccount {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const dyadCfg = (opts.cfg.channels as Record<string, unknown> | undefined)?.dyad as
    | DyadAccountConfig
    | undefined;

  const baseEnabled = dyadCfg?.enabled !== false;
  const rawToken = dyadCfg?.token ?? "";
  const configured = Boolean(rawToken.trim());

  let botToken: DyadBotToken | null = null;
  if (configured) {
    try {
      botToken = decodeBotToken(rawToken);
    } catch {
      // Invalid token — leave null, configured still true to show error
    }
  }

  return {
    accountId,
    name: dyadCfg?.name?.trim() || undefined,
    enabled: baseEnabled,
    configured,
    botToken: rawToken.trim(),
    appToken: rawToken.trim(), // Dyad uses single compound token for both
    decodedToken: botToken,
    botId: botToken?.sub ?? "",
    botUserId: botToken?.uid ?? "",
    supabaseUrl: botToken?.url ?? "",
    supabaseKey: botToken?.key ?? "",
    coordChatId: dyadCfg?.coordChatId?.trim() || null,
    apiUrl: dyadCfg?.apiUrl?.trim() || botToken?.apiUrl || "https://dyadai.vercel.app",
    apiBotToken: dyadCfg?.botToken?.trim() || null,
    botName: dyadCfg?.botName?.trim() || dyadCfg?.name?.trim() || "Bot",
    gatewayUrl: dyadCfg?.gatewayUrl?.trim() || "http://localhost:18789",
    gatewayToken: dyadCfg?.gatewayToken?.trim() || null,
    config: {
      enabled: dyadCfg?.enabled,
      name: dyadCfg?.name,
      token: dyadCfg?.token,
      dmPolicy: dyadCfg?.dmPolicy,
      coordChatId: dyadCfg?.coordChatId,
      apiUrl: dyadCfg?.apiUrl,
      botToken: dyadCfg?.botToken,
      botName: dyadCfg?.botName,
      gatewayUrl: dyadCfg?.gatewayUrl,
      gatewayToken: dyadCfg?.gatewayToken,
    },
  };
}
