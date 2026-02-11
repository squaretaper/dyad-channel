/**
 * Bot token encode/decode for Dyad channel plugin.
 *
 * MVP (Option A): Self-contained base64 JSON token.
 * Contains all info needed to connect to one or more workspaces.
 *
 * Format: base64url({ sub, uid, url, key, wid?, wids?, iss?, iat? })
 *
 * Legacy tokens use `wid` (single workspace). New user-scoped tokens
 * use `wids` (array of workspace IDs). Both are supported — on decode
 * the token is normalized so both `wid` and `wids` are always populated.
 */

export interface DyadBotToken {
  /** Bot ID (UUID) — identifies the bot in bot_tokens table */
  sub: string;
  /** Workspace ID (UUID) — single workspace (legacy). Normalized from wids[0] if absent. */
  wid?: string;
  /** Workspace IDs (UUID[]) — all workspaces this bot can access (user-scoped). */
  wids?: string[];
  /** Bot's user ID in Dyad (UUID) — used as speaker identity */
  uid: string;
  /** Supabase project URL (e.g. https://xxx.supabase.co) */
  url: string;
  /** Supabase anon key (public, RLS-scoped) */
  key: string;
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

  // Validate required fields (wid/wids handled separately)
  const required = ["sub", "uid", "url", "key"] as const;
  for (const field of required) {
    if (typeof parsed[field] !== "string" || !parsed[field].trim()) {
      throw new Error(`Invalid bot token: missing or empty field "${field}"`);
    }
  }

  // Validate workspace identity: need at least wid or wids
  const hasWid = typeof parsed.wid === "string" && parsed.wid.trim();
  const hasWids = Array.isArray(parsed.wids) && parsed.wids.length > 0;
  if (!hasWid && !hasWids) {
    throw new Error('Invalid bot token: missing workspace identity (need "wid" or "wids")');
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

  // Normalize: ensure both wid and wids are populated
  const wids: string[] = hasWids
    ? (parsed.wids as string[]).filter((w: string) => typeof w === "string" && w.trim())
    : [parsed.wid.trim()];
  const wid = hasWid ? parsed.wid.trim() : wids[0];

  return {
    sub: parsed.sub,
    wid,
    wids,
    uid: parsed.uid,
    url: parsed.url,
    key: parsed.key,
    apiUrl: parsed.apiUrl,
    iss: parsed.iss ?? "dyad",
    iat: parsed.iat,
  };
}
