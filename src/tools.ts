/**
 * OpenClaw agent tools for Dyad workspace integration.
 *
 * All tools are dynamically discovered from the Dyad MCP endpoint at startup.
 * The plugin is a thin transport layer — no business logic, no hardcoded tools.
 * Tools are proxied via JSON-RPC to POST /api/mcp.
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { decodeBotToken } from "./token.js";

// ToolFactory isn't re-exported from plugin-sdk entry
type ToolFactory = (ctx: { config?: any }) => AnyAgentTool | AnyAgentTool[] | null | undefined;

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
// Dynamic workspace tools (discovered from Dyad MCP endpoint)
// ============================================================================

/**
 * Discover ALL workspace tools from the Dyad MCP endpoint and create
 * OpenClaw tool factories that proxy calls via JSON-RPC.
 *
 * This includes coordination tools (send_coordination_message,
 * get_coordination_context) which are MCP tools like any other.
 * The plugin has no hardcoded business logic — everything goes through MCP.
 */
export function createWorkspaceToolFactories(): ToolFactory[] {
  let cachedTools: Array<{ name: string; description: string; inputSchema: any }> | null = null;
  let discoveryPromise: Promise<void> | null = null;

  async function discoverTools(apiUrl: string, apiToken: string): Promise<void> {
    if (cachedTools) return;
    if (discoveryPromise) {
      await discoveryPromise;
      return;
    }

    discoveryPromise = (async () => {
      try {
        const res = await fetch(`${apiUrl}/api/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiToken}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "discover",
            method: "tools/list",
          }),
        });

        if (!res.ok) {
          console.error(`[dyad-tools] Discovery failed: HTTP ${res.status}`);
          cachedTools = [];
          return;
        }

        const body = await res.json();
        cachedTools = body.result?.tools || [];
        console.log(`[dyad-tools] Discovered ${cachedTools!.length} workspace tools`);
      } catch (e: any) {
        console.error(`[dyad-tools] Discovery error: ${e.message}`);
        cachedTools = [];
      }
    })();

    await discoveryPromise;
  }

  const factory: ToolFactory = (ctx) => {
    const coord = readCoordConfig(ctx);
    if (!coord) return null;

    // Kick off async discovery — tools available after first resolve
    discoverTools(coord.apiUrl, coord.apiBotToken);

    if (!cachedTools || cachedTools.length === 0) return null;

    return cachedTools.map((tool) => {
      const params = Type.Object(
        Object.fromEntries(
          Object.entries(tool.inputSchema?.properties || {}).map(
            ([key, prop]: [string, any]) => {
              const required = (tool.inputSchema?.required || []).includes(key);
              const schema = prop.type === "number"
                ? Type.Number({ description: prop.description })
                : Type.String({ description: prop.description });
              return [key, required ? schema : Type.Optional(schema)];
            },
          ),
        ),
      );

      return {
        name: `dyad_${tool.name}`,
        label: tool.name.replace(/_/g, " "),
        description: tool.description,
        parameters: params,
        execute: async (_toolCallId: string, args: Record<string, any>) => {
          try {
            const res = await fetch(`${coord.apiUrl}/api/mcp`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${coord.apiBotToken}`,
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: _toolCallId || "call",
                method: "tools/call",
                params: { name: tool.name, arguments: args },
              }),
            });

            if (!res.ok) {
              return {
                content: [{ type: "text" as const, text: `Tool call failed: HTTP ${res.status}` }],
                details: {},
              };
            }

            const body = await res.json();
            const result = body.result || body.error;

            const text = result?.content
              ?.map((c: any) => c.text)
              .join("\n") || JSON.stringify(result);

            return {
              content: [{ type: "text" as const, text }],
              details: {},
            };
          } catch (e: any) {
            return {
              content: [{ type: "text" as const, text: `Tool error: ${e.message}` }],
              details: {},
            };
          }
        },
      } as AnyAgentTool;
    });
  };

  return [factory];
}
