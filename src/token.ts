/**
 * Bot token encode/decode for Dyad channel plugin.
 *
 * Self-contained base64 JSON token with bot identity + Supabase credentials.
 * No workspace scoping — the bot responds to all messages it can see.
 *
 * Format: base64url({ sub, uid, url, key, apiUrl?, iss?, iat? })
 */

export interface DyadBotToken {
  /** Bot ID (UUID) — identifies the bot in bot_tokens table */
  sub: string;
  /** Bot's user ID in Dyad (UUID) — used as speaker identity */
  uid: string;
  /** Supabase project URL (e.g. https://xxx.supabase.co) */
  url: string;
  /** Supabase anon key (public, RLS-scoped) */
  key: string;
  /** Bot email for Supabase auth sign-in */
  email?: string;
  /** Bot password for Supabase auth sign-in */
  pwd?: string;
  /** Dyad API URL (optional, e.g. https://dyadai.vercel.app) */
  apiUrl?: string;
  /** Issuer (optional, always "dyad") */
  iss?: string;
  /** Issued at timestamp (optional) */
  iat?: number;
}

/**
 * Encode a bot token to a base64 string.
 */
export function encodeBotToken(token: DyadBotToken): string {
  const json = JSON.stringify(token);
  return Buffer.from(json, "utf-8").toString("base64url");
}

/**
 * Decode a bot token from a base64 string.
 * Handles both base64url and standard base64.
 * Throws if the token is malformed or missing required fields.
 */
export function decodeBotToken(encoded: string): DyadBotToken {
  const trimmed = encoded.trim();

  let json: string;
  try {
    // Try base64url first, then standard base64
    json = Buffer.from(trimmed, "base64url").toString("utf-8");
    // Verify it's valid JSON
    JSON.parse(json);
  } catch {
    try {
      json = Buffer.from(trimmed, "base64").toString("utf-8");
      JSON.parse(json);
    } catch {
      throw new Error("Invalid bot token: not valid base64-encoded JSON");
    }
  }

  const parsed = JSON.parse(json);

  // Validate required fields
  const required = ["sub", "uid", "url", "key"] as const;
  for (const field of required) {
    if (typeof parsed[field] !== "string" || !parsed[field].trim()) {
      throw new Error(`Invalid bot token: missing or empty field "${field}"`);
    }
  }

  // Validate URL format
  try {
    const u = new URL(parsed.url);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      throw new Error("URL must use https:// or http://");
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("URL must use")) {
      throw e;
    }
    throw new Error(`Invalid bot token: invalid Supabase URL "${parsed.url}"`);
  }

  return {
    sub: parsed.sub,
    uid: parsed.uid,
    url: parsed.url,
    key: parsed.key,
    email: parsed.email,
    pwd: parsed.pwd,
    apiUrl: parsed.apiUrl,
    iss: parsed.iss ?? "dyad",
    iat: parsed.iat,
  };
}
