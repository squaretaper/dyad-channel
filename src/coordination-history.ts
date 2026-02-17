/**
 * Coordination history and cross-agent awareness for the Dyad channel plugin.
 *
 * Ported from dyadai-repo/lib/coordination/history.ts — adapted to use
 * the bus's authenticated SupabaseClient directly instead of server-side
 * service role client.
 *
 * Three concerns:
 * 1. loadCoordinationHistory — previous round outcomes for prompt injection
 * 2. loadRecentBotResponses — what other bots recently said in the main chat
 * 3. writeResponseSummary — record what this bot said (to coordination_summaries table)
 *
 * All functions are resilient: try/catch around DB queries, return empty on failure.
 * This handles missing tables (migration not yet run), RLS issues, and network errors.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COORDINATION_PROTOCOL_VERSION,
  COORD_HISTORY_MAX_ROUNDS,
  COORD_HISTORY_MAX_CHARS,
  RECENT_RESPONSES_MAX_PER_AGENT,
  RECENT_RESPONSES_MAX_CHARS,
  RESPONSE_SUMMARY_MAX_CHARS,
} from "./types-coordination.js";

// ============================================================================
// Types
// ============================================================================

interface CoordMessage {
  speaker: string;
  content: string;
  created_at: string;
}

interface ParsedCoordEntry {
  speaker: string;
  created_at: string;
  round_id: string;
  intent?: {
    type: string;
    scope?: string;
    to?: string;
    reason?: string;
    with?: string;
    topic?: string;
  };
  kind?: string;
  summaryContent?: string;
}

interface ResponseSummaryRow {
  speaker: string;
  content: string;
  round_id: string;
  created_at: string;
}

// ============================================================================
// Helpers
// ============================================================================

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function formatIntent(
  intent: ParsedCoordEntry["intent"],
): string {
  if (!intent) return "unknown";
  const parts: string[] = [intent.type];
  if (intent.scope) parts.push(`scope: "${intent.scope}"`);
  if (intent.to) parts.push(`to: ${intent.to}`);
  if (intent.reason) parts.push(`reason: "${intent.reason}"`);
  if (intent.with) parts.push(`with: ${intent.with}`);
  if (intent.topic) parts.push(`topic: "${intent.topic}"`);
  return parts.join(", ");
}

// ============================================================================
// loadCoordinationHistory
// ============================================================================

/**
 * Load recent coordination history from the #coordination channel + summaries table.
 * Groups messages by round_id, formats as readable text.
 * Excludes the current round (excludeRoundId) so agents only see past rounds.
 */
export async function loadCoordinationHistory(
  supabase: SupabaseClient,
  coordChatId: string,
  excludeRoundId: string,
  maxRounds: number = COORD_HISTORY_MAX_ROUNDS,
): Promise<string> {
  try {
    // Fetch coordination messages and response summaries in parallel
    const [coordResult, summariesResult] = await Promise.allSettled([
      supabase
        .from("messages")
        .select("speaker, content, created_at")
        .eq("chat_id", coordChatId)
        .eq("message_type", "bot_coordination")
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("coordination_summaries")
        .select("speaker, content, round_id, created_at")
        .eq("coord_chat_id", coordChatId)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

    // Extract coordination messages
    const messages: CoordMessage[] =
      coordResult.status === "fulfilled" && !coordResult.value.error
        ? (coordResult.value.data as CoordMessage[]) ?? []
        : [];

    // Extract response summaries (from dedicated table)
    const summaries: ResponseSummaryRow[] =
      summariesResult.status === "fulfilled" && !summariesResult.value.error
        ? (summariesResult.value.data as ResponseSummaryRow[]) ?? []
        : [];

    if (messages.length === 0 && summaries.length === 0) return "";

    // Parse coordination messages into entries
    const entries: ParsedCoordEntry[] = [];
    for (const msg of messages) {
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed.round_id === excludeRoundId) continue;
        if (parsed.protocol !== "dyad-coord-v1" && parsed.protocol !== "dyad-coord-v2") continue;

        // Skip response_summary kind in messages (legacy — now in separate table)
        if (parsed.kind === "response_summary") continue;

        if (parsed.intent && parsed.intent.type !== "round_start") {
          entries.push({
            speaker: msg.speaker,
            created_at: msg.created_at,
            round_id: parsed.round_id,
            intent: parsed.intent,
          });
        } else if (parsed.kind === "micro_propose" && parsed.proposal) {
          entries.push({
            speaker: msg.speaker,
            created_at: msg.created_at,
            round_id: parsed.round_id,
            kind: "micro_propose",
            summaryContent: `angle: "${parsed.proposal.angle}", confidence: ${parsed.proposal.confidence}`,
          });
        } else if (parsed.kind === "resolved") {
          entries.push({
            speaker: msg.speaker,
            created_at: msg.created_at,
            round_id: parsed.round_id,
            kind: "resolved",
            summaryContent: `${parsed.mode}: winner=${parsed.winner || "n/a"}, ${parsed.reason || ""}`,
          });
        }
      } catch {
        // Skip malformed
      }
    }

    // Add response summaries from dedicated table
    for (const summary of summaries) {
      if (summary.round_id === excludeRoundId) continue;
      entries.push({
        speaker: summary.speaker,
        created_at: summary.created_at,
        round_id: summary.round_id,
        kind: "response_summary",
        summaryContent: summary.content,
      });
    }

    if (entries.length === 0) return "";

    // Group by round_id, preserving order (most recent first)
    const roundOrder: string[] = [];
    const roundMap = new Map<string, ParsedCoordEntry[]>();

    for (const entry of entries) {
      if (!roundMap.has(entry.round_id)) {
        roundOrder.push(entry.round_id);
        roundMap.set(entry.round_id, []);
      }
      roundMap.get(entry.round_id)!.push(entry);
    }

    // Take only the most recent N rounds
    const selectedRounds = roundOrder.slice(0, maxRounds);

    // Format each round
    const roundBlocks: string[] = [];
    let totalChars = 0;

    for (let i = 0; i < selectedRounds.length; i++) {
      const roundId = selectedRounds[i];
      const roundEntries = roundMap.get(roundId)!;
      const timestamp = formatTime(roundEntries[0].created_at);

      const lines: string[] = [];
      lines.push(`Round ${i + 1} (${timestamp}):`);

      for (const entry of roundEntries) {
        if (entry.intent) {
          lines.push(`- ${entry.speaker}: ${formatIntent(entry.intent)}`);
        } else if (entry.kind === "micro_propose" && entry.summaryContent) {
          lines.push(`- ${entry.speaker} proposed: ${entry.summaryContent}`);
        } else if (entry.kind === "resolved" && entry.summaryContent) {
          lines.push(`- ${entry.speaker} resolved: ${entry.summaryContent}`);
        } else if (entry.kind === "response_summary" && entry.summaryContent) {
          const truncated =
            entry.summaryContent.length > 1000
              ? entry.summaryContent.slice(0, 1000) + "..."
              : entry.summaryContent;
          lines.push(`- ${entry.speaker} responded: "${truncated}"`);
        }
      }

      const block = lines.join("\n");

      if (totalChars + block.length > COORD_HISTORY_MAX_CHARS) break;
      totalChars += block.length;
      roundBlocks.push(block);
    }

    if (roundBlocks.length === 0) return "";

    return `[Previous coordination rounds:\n${roundBlocks.join("\n\n")}\n]`;
  } catch {
    // Resilience: any unexpected error → return empty
    return "";
  }
}

// ============================================================================
// loadRecentBotResponses
// ============================================================================

/**
 * Load recent bot_response messages from the MAIN chat by other agents.
 * Gives an agent awareness of what the other agent(s) recently said to users.
 *
 * Self-discovering: finds other bot names from coordination_summaries speakers
 * rather than requiring them in config.
 */
export async function loadRecentBotResponses(
  supabase: SupabaseClient,
  chatId: string,
  forBotName: string,
  maxPerAgent: number = RECENT_RESPONSES_MAX_PER_AGENT,
): Promise<string> {
  try {
    if (!chatId) return "";

    // Discover other bot names from coordination_summaries speakers
    const { data: speakerRows, error: speakerError } = await supabase
      .from("coordination_summaries")
      .select("speaker")
      .order("created_at", { ascending: false })
      .limit(50);

    if (speakerError || !speakerRows || speakerRows.length === 0) {
      // Table might not exist or no summaries yet — try messages table as fallback
      return await loadRecentBotResponsesFallback(
        supabase,
        chatId,
        forBotName,
        maxPerAgent,
      );
    }

    // Extract unique other bot names
    const otherBots = [
      ...new Set(
        speakerRows
          .map((r: { speaker: string }) => r.speaker)
          .filter((name: string) => name !== forBotName),
      ),
    ];
    if (otherBots.length === 0) return "";

    return await queryBotResponses(supabase, chatId, otherBots, maxPerAgent);
  } catch {
    return "";
  }
}

/**
 * Fallback: discover other bot names from coordination messages in #coordination.
 */
async function loadRecentBotResponsesFallback(
  supabase: SupabaseClient,
  chatId: string,
  forBotName: string,
  maxPerAgent: number,
): Promise<string> {
  try {
    // Query distinct speakers from bot_response messages in this chat
    const { data: responseRows, error } = await supabase
      .from("messages")
      .select("speaker")
      .eq("chat_id", chatId)
      .eq("message_type", "bot_response")
      .order("created_at", { ascending: false })
      .limit(20);

    if (error || !responseRows || responseRows.length === 0) return "";

    const otherBots = [
      ...new Set(
        responseRows
          .map((r: { speaker: string }) => r.speaker)
          .filter((name: string) => name !== forBotName),
      ),
    ];
    if (otherBots.length === 0) return "";

    return await queryBotResponses(supabase, chatId, otherBots, maxPerAgent);
  } catch {
    return "";
  }
}

/**
 * Query recent bot_response messages from a chat for specific bot names.
 */
async function queryBotResponses(
  supabase: SupabaseClient,
  chatId: string,
  otherBots: string[],
  maxPerAgent: number,
): Promise<string> {
  const { data: messages, error } = await supabase
    .from("messages")
    .select("speaker, content, created_at")
    .eq("chat_id", chatId)
    .eq("message_type", "bot_response")
    .in("speaker", otherBots)
    .order("created_at", { ascending: false })
    .limit(otherBots.length * maxPerAgent);

  if (error || !messages || messages.length === 0) return "";

  // Group by speaker, taking at most maxPerAgent each
  const perAgent = new Map<string, typeof messages>();
  for (const msg of messages) {
    const existing = perAgent.get(msg.speaker) || [];
    if (existing.length < maxPerAgent) {
      existing.push(msg);
      perAgent.set(msg.speaker, existing);
    }
  }

  const lines: string[] = [];
  let totalChars = 0;

  for (const [speaker, msgs] of perAgent) {
    for (const msg of msgs) {
      const truncated =
        msg.content.length > 500
          ? msg.content.slice(0, 500) + "..."
          : msg.content;
      const timestamp = formatTime(msg.created_at);
      const line = `${speaker} (${timestamp}): "${truncated}"`;

      if (totalChars + line.length > RECENT_RESPONSES_MAX_CHARS) break;
      totalChars += line.length;
      lines.push(line);
    }
    if (totalChars >= RECENT_RESPONSES_MAX_CHARS) break;
  }

  if (lines.length === 0) return "";

  return `[Recent responses by other agents:\n${lines.join("\n")}\n]`;
}

// ============================================================================
// writeResponseSummary
// ============================================================================

export interface ResponseSummaryOpts {
  coordChatId: string;
  roundId: string;
  speaker: string;
  content: string;
  sourceChatId: string;
}

/**
 * Write a response summary to the dedicated coordination_summaries table.
 * Fire-and-forget — callers should .catch() to avoid unhandled rejections.
 */
export async function writeResponseSummary(
  supabase: SupabaseClient,
  opts: ResponseSummaryOpts,
): Promise<void> {
  try {
    const truncated =
      opts.content.length > RESPONSE_SUMMARY_MAX_CHARS
        ? opts.content.slice(0, RESPONSE_SUMMARY_MAX_CHARS) + "..."
        : opts.content;

    const { error } = await supabase.from("coordination_summaries").insert({
      coord_chat_id: opts.coordChatId,
      round_id: opts.roundId,
      speaker: opts.speaker,
      content: truncated,
      source_chat_id: opts.sourceChatId,
    });

    if (error) {
      // Log but don't throw — this is fire-and-forget
      console.error(`[coord-history] writeResponseSummary failed: ${error.message}`);
    }
  } catch (e: any) {
    // Resilience: table might not exist yet
    console.error(`[coord-history] writeResponseSummary error: ${e.message}`);
  }
}
