import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { decodeBotToken, type DyadBotToken } from "./token.js";

export interface DyadAccountConfig {
  enabled?: boolean;
  name?: string;
  token?: string;
  dmPolicy?: "open" | "disabled";
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
  /** Bot email for Supabase auth (from token) */
  botEmail: string;
  /** Bot password for Supabase auth (from token) */
  botPassword: string;
  /** Bot display name (used as speaker identity in messages) */
  botName: string;
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
    appToken: rawToken.trim(),
    decodedToken: botToken,
    botId: botToken?.sub ?? "",
    botUserId: botToken?.uid ?? "",
    supabaseUrl: botToken?.url ?? "",
    supabaseKey: botToken?.key ?? "",
    botEmail: botToken?.email ?? "",
    botPassword: botToken?.pwd ?? "",
    botName: dyadCfg?.name?.trim() || "Bot",
    config: {
      enabled: dyadCfg?.enabled,
      name: dyadCfg?.name,
      token: dyadCfg?.token,
      dmPolicy: dyadCfg?.dmPolicy,
    },
  };
}
