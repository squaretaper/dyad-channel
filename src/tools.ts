/**
 * OpenClaw agent tools for inter-agent dialogue via the Dyad coordination channel.
 *
 * Two tools:
 * - dyad_coord_send: Post a message to another agent via #coordination
 * - dyad_coord_history: Query past coordination messages
 *
 * Both use the Dyad bot/message API route (service-role backed, bypasses RLS).
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { decodeBotToken } from "./token.js";

// ToolFactory isn't re-exported from plugin-sdk entry
type ToolFactory = (ctx: { config?: any }) => AnyAgentTool | AnyAgentTool[] | null | undefined;

const COORDINATION_PROTOCOL_VERSION = "dyad-coord-v2";

// ============================================================================
// Schemas
// ============================================================================

const CoordSendSchema = Type.Object({
  to: Type.String({ description: "Name of the agent to message (e.g. 'Ren', 'Noa')" }),
  message: Type.String({ description: "The message content" }),
  kind: Type.Optional(
    Type.Union(
      [Type.Literal("question"), Type.Literal("inform"), Type.Literal("flag")],
      {
        default: "inform",
        description:
          "Message type: question (expects reply), inform (FYI), flag (urgent)",
      },
    ),
  ),
  source_chat_id: Type.Optional(
    Type.String({
      description: "Chat ID this message originates from (for scoping coordination to a specific chat)",
    }),
  ),
});

const CoordHistorySchema = Type.Object({
  limit: Type.Optional(
    Type.Number({
      default: 20,
      description: "Max messages to return (default 20)",
    }),
  ),
  since: Type.Optional(
    Type.String({
      description: "ISO timestamp — only return messages after this time",
    }),
  ),
  source_chat_id: Type.Optional(
    Type.String({
      description: "Filter to only messages from this chat ID",
    }),
  ),
});

// ============================================================================
// Config helpers
// ============================================================================

function readCoordConfig(ctx: { config?: any }): {
  apiBotToken: string;
  coordChatId: string;
  apiUrl: string;
} | null {
  const dyadCfg = (ctx.config?.channels as Record<string, any> | undefined)?.dyad;
  const rawToken: string = dyadCfg?.token ?? "";
  if (!rawToken) return null;

  try {
    const decoded = decodeBotToken(rawToken);
    // Fall back to flat config fields if the token was generated before
    // coordChatId/apiUrl/apiToken were added to the token payload.
    const coordChatId = decoded.coordChatId ?? dyadCfg?.coordChatId ?? "";
    const apiUrl = decoded.apiUrl ?? dyadCfg?.apiUrl ?? "";
    const apiBotToken = decoded.apiToken ?? dyadCfg?.botToken ?? "";
    if (!apiBotToken || !coordChatId || !apiUrl) return null;
    return { apiBotToken, coordChatId, apiUrl };
  } catch {
    return null;
  }
}

// ============================================================================
// Tool factories
// ============================================================================

/**
 * Factory for the dyad_coord_send tool.
 * Reads Dyad coordination config from raw plugin config at tool-call time.
 */
export function createCoordSendTool(): ToolFactory {
  return (ctx) => {
    const coord = readCoordConfig(ctx);
    if (!coord) return null;

    return {
      name: "dyad_coord_send",
      label: "Send to Agent",
      description:
        "Send a message to another agent in the Dyad workspace via the coordination channel. " +
        "Use this to ask questions, share information, or flag issues to other agents. " +
        "The other agent will receive your message and can reply.",
      parameters: CoordSendSchema,
      execute: async (
        _toolCallId: string,
        params: Static<typeof CoordSendSchema>,
      ) => {
        const kind = params.kind || "inform";
        const expectsReply = kind === "question";

        const payload = JSON.stringify({
          protocol: COORDINATION_PROTOCOL_VERSION,
          kind,
          to: params.to,
          content: params.message,
          expects_reply: expectsReply,
          depth: 0,
          source_chat_id: params.source_chat_id || null,
        });

        try {
          const res = await fetch(`${coord.apiUrl}/api/v2/bot/message`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${coord.apiBotToken}`,
            },
            body: JSON.stringify({
              chat_id: coord.coordChatId,
              content: payload,
              message_type: "bot_coordination",
            }),
          });

          if (!res.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `✗ coord send failed: HTTP ${res.status}`,
                },
              ],
              details: {},
            };
          }

          const body = await res.json().catch(() => null);
          const id = body?.id || body?.message?.id || "";
          const idSuffix = id ? ` | id:${id.slice(0, 4)}…${id.slice(-4)}` : "";
          return {
            content: [
              {
                type: "text" as const,
                text: `✓ coord → ${params.to}${idSuffix}`,
              },
            ],
            details: {},
          };
        } catch (e: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `✗ coord send failed: ${e.message.slice(0, 80)}`,
              },
            ],
            details: {},
          };
        }
      },
    } as AnyAgentTool;
  };
}

/**
 * Factory for the dyad_coord_history tool.
 * Queries coordination channel messages via the bot/message GET endpoint.
 */
export function createCoordHistoryTool(): ToolFactory {
  return (ctx) => {
    const coord = readCoordConfig(ctx);
    if (!coord) return null;

    return {
      name: "dyad_coord_history",
      label: "Coordination History",
      description:
        "Query the coordination channel history to see past messages exchanged between agents. " +
        "Returns coordination rounds, proposals, intents, and inter-agent dialogue. " +
        "Use this to recall what was discussed or decided in previous rounds.",
      parameters: CoordHistorySchema,
      execute: async (
        _toolCallId: string,
        params: Static<typeof CoordHistorySchema>,
      ) => {
        const limit = params.limit || 20;

        try {
          const url = new URL(`${coord.apiUrl}/api/v2/bot/message`);
          url.searchParams.set("chat_id", coord.coordChatId);
          if (params.since) {
            url.searchParams.set("since", params.since);
          }

          const res = await fetch(url.toString(), {
            headers: {
              Authorization: `Bearer ${coord.apiBotToken}`,
            },
          });

          if (!res.ok) {
            const text = await res.text().catch(() => "");
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to fetch history: HTTP ${res.status} — ${text.slice(0, 200)}`,
                },
              ],
              details: {},
            };
          }

          const data = await res.json();
          const messages: any[] = data.messages || [];

          let recent = messages.slice(-limit);

          if (params.source_chat_id) {
            recent = recent.filter((msg: any) => {
              try {
                const parsed = JSON.parse(msg.content);
                return parsed.source_chat_id === params.source_chat_id;
              } catch {
                return false;
              }
            });
          }

          if (recent.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "No coordination messages found.",
                },
              ],
              details: {},
            };
          }

          const lines = recent.map((msg: any) => {
            const ts = msg.created_at
              ? new Date(msg.created_at).toLocaleString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })
              : "";

            let summary: string;
            try {
              const parsed = JSON.parse(msg.content);
              if (parsed.intent?.type === "round_start") {
                summary = `[round_start] trigger: "${(parsed.trigger_content || "").slice(0, 100)}"`;
              } else if (parsed.kind === "propose") {
                summary = `[propose] angle: "${parsed.proposal?.angle || ""}", covers: [${(parsed.proposal?.covers || []).join(", ")}]`;
              } else if (parsed.kind === "accept") {
                summary = `[accept]`;
              } else if (parsed.kind === "counter") {
                summary = `[counter] angle: "${parsed.proposal?.angle || ""}"`;
              } else if (parsed.kind === "ready") {
                summary = `[ready] intent: ${parsed.intent?.type || "unknown"}, summary: "${(parsed.summary || "").slice(0, 100)}"`;
              } else if (parsed.kind === "micro_propose") {
                summary = `[micro_propose] angle: "${parsed.proposal?.angle || ""}", confidence: ${parsed.proposal?.confidence ?? "n/a"}`;
              } else if (parsed.kind === "resolved") {
                const runnerUpLabel = parsed.runner_up ? `, runner_up: ${parsed.runner_up}` : "";
                summary = `[resolved] mode: ${parsed.mode || "n/a"}, winner: ${parsed.winner || "n/a"}${runnerUpLabel}, reason: "${(parsed.reason || "").slice(0, 100)}"`;
              } else if (parsed.kind === "response_summary") {
                summary = `[response_summary] "${(parsed.content || "").slice(0, 150)}"`;
              } else if (
                ["question", "inform", "flag", "delegate", "status"].includes(
                  parsed.kind,
                )
              ) {
                const toLabel = parsed.to ? ` → ${parsed.to}` : "";
                summary = `[${parsed.kind}${toLabel}] ${(parsed.content || "").slice(0, 150)}`;
              } else if (parsed.kind === "signal") {
                const si = parsed.solo_insufficient ? "TRUE" : "false";
                summary = `[signal] solo_insufficient: ${si}, confidence: ${parsed.confidence ?? "n/a"}, reason: "${(parsed.reason || "").slice(0, 200)}"`;
              } else if (parsed.kind === "judgment_trace") {
                summary = `[chain_trace] depth=${parsed.chain_depth ?? "?"}, ended: ${parsed.termination_reason || "unknown"}, ${parsed.display || ""}`;
              } else if (parsed.kind === "routing_decision") {
                summary = `[routing] route=${parsed.route}, source=${parsed.source}, confidence=${parsed.confidence}`;
              } else {
                summary = msg.content.slice(0, 150);
              }
            } catch {
              summary = msg.content.slice(0, 150);
            }

            return `${msg.speaker} (${ts}): ${summary}`;
          });

          return {
            content: [
              {
                type: "text" as const,
                text: `coord history (${recent.length}):\n${lines.join("\n")}`,
              },
            ],
            details: {},
          };
        } catch (e: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to fetch history: ${e.message}`,
              },
            ],
            details: {},
          };
        }
      },
    } as AnyAgentTool;
  };
}
