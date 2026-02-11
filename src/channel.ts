import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { DyadConfigSchema } from "./config-schema.js";
import { startDyadBus, type DyadBusHandle } from "./supabase-bus.js";
import {
  listDyadAccountIds,
  resolveDefaultDyadAccountId,
  resolveDyadAccount,
  type ResolvedDyadAccount,
} from "./types.js";
import { createCoordinationHandler, type CoordinationHandler } from "./coordination.js";

// Store active bus handles per account
const activeBuses = new Map<string, DyadBusHandle>();

export const dyadPlugin: ChannelPlugin<ResolvedDyadAccount> = {
  id: "dyad",
  meta: {
    id: "dyad",
    label: "Dyad",
    selectionLabel: "Dyad (AI Workspace)",
    docsPath: "/channels/dyad",
    docsLabel: "dyad",
    blurb: "Connect your agent to Dyad collaborative AI workspaces.",
    order: 90,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false, // MVP: text only
  },
  reload: { configPrefixes: ["channels.dyad"] },
  configSchema: buildChannelConfigSchema(DyadConfigSchema),

  config: {
    listAccountIds: (cfg) => listDyadAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveDyadAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultDyadAccountId(cfg),
    isConfigured: (account) => account.configured && account.decodedToken !== null,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      botToken: account.botToken,
      appToken: account.appToken,
      botTokenSource: account.botToken ? "config" : "none",
      appTokenSource: account.appToken ? "config" : "none",
    }),
  },

  security: {
    resolveDmPolicy: ({ account }) => {
      return {
        // Dyad handles access control via Supabase workspace membership,
        // not OpenClaw's DM policy system
        policy: account.config.dmPolicy ?? "disabled",
        allowFrom: [],
        policyPath: "channels.dyad.dmPolicy",
        allowFromPath: "channels.dyad.allowFrom",
        approveHint: "Dyad workspace member",
      };
    },
  },

  messaging: {
    normalizeTarget: (target) => target.trim(),
    targetResolver: {
      looksLikeId: (input) => {
        // UUID format check for chat IDs
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          input.trim(),
        );
      },
      hint: "<chat_id (UUID)>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 10000, // Dyad/Supabase can handle larger messages
    sendText: async ({ to, text, accountId }) => {
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) {
        throw new Error(`Dyad bus not running for account ${aid}`);
      }
      await bus.sendMessage(to, text ?? "");
      return { channel: "dyad" as const, messageId: "", to };
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) {
          return [];
        }
        return [
          {
            channel: "dyad",
            accountId: account.accountId,
            kind: "runtime" as const,
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      botToken: account.botToken,
      appToken: account.appToken,
      botTokenSource: account.botToken ? "config" : "none",
      appTokenSource: account.appToken ? "config" : "none",
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const tag = `[${account.accountId}]`;
      ctx.setStatus({
        accountId: account.accountId,
      });
      ctx.log?.info(`${tag} Starting Dyad provider`);

      if (!account.configured || !account.decodedToken) {
        throw new Error("Dyad bot token not configured or invalid");
      }

      // --- Gateway caller for coordination LLM calls ---
      const coordEnabled = Boolean(
        account.coordChatId && account.apiBotToken && account.gatewayToken,
      );

      async function callGateway(
        prompt: string,
        timeoutMs: number,
        retries: number = 1,
      ): Promise<string | null> {
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const thisTimeout = attempt === 0 ? timeoutMs : timeoutMs * 2;
            const res = await fetch(`${account.gatewayUrl}/v1/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${account.gatewayToken}`,
              },
              body: JSON.stringify({
                model: "openclaw:main",
                user: "dyad:coord",
                messages: [{ role: "user", content: prompt }],
              }),
              signal: AbortSignal.timeout(thisTimeout),
            });

            const result = await res.json();
            const content = result?.choices?.[0]?.message?.content?.trim() || null;
            if (content) return content;
            ctx.log?.warn(
              `${tag} Gateway returned empty (attempt ${attempt + 1}/${retries + 1})`,
            );
          } catch (e: any) {
            ctx.log?.error(
              `${tag} Gateway call failed (attempt ${attempt + 1}/${retries + 1}): ${e.message}`,
            );
            if (attempt < retries) {
              const backoff = 2000 * (attempt + 1);
              await new Promise((r) => setTimeout(r, backoff));
            }
          }
        }
        return null;
      }

      // --- Create coordination handler (if configured) ---
      let coordination: CoordinationHandler | null = null;

      // Start bus with coordination opts wired in
      const bus = await startDyadBus({
        supabaseUrl: account.supabaseUrl,
        supabaseKey: account.supabaseKey,
        botId: account.botId,
        botUserId: account.botUserId,
        botEmail: account.botEmail,
        botPassword: account.botPassword,
        botDisplayName: account.botName,
        onMessage: async ({ chatId, text, userId }) => {
          ctx.log?.info(`${tag} Message from ${userId} in chat ${chatId}: ${text.slice(0, 50)}...`);

          try {
            // Call OpenClaw gateway — session context managed by OpenClaw via user key
            const gatewayRes = await fetch(`${account.gatewayUrl}/v1/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(account.gatewayToken ? { Authorization: `Bearer ${account.gatewayToken}` } : {}),
              },
              body: JSON.stringify({
                model: "openclaw:main",
                user: `dyad:${chatId}`,
                messages: [{ role: "user", content: text }],
              }),
              signal: AbortSignal.timeout(120_000),
            });

            if (!gatewayRes.ok) {
              const errText = await gatewayRes.text().catch(() => "unknown");
              ctx.log?.error(`${tag} Gateway error ${gatewayRes.status}: ${errText.slice(0, 200)}`);
              return;
            }

            const result = await gatewayRes.json();
            const responseText = result?.choices?.[0]?.message?.content?.trim();

            if (responseText) {
              await bus.sendMessage(chatId, responseText);
              ctx.log?.info(`${tag} Reply sent to chat ${chatId} (${responseText.length} chars)`);
            } else {
              ctx.log?.warn(`${tag} Gateway returned empty response`);
            }
          } catch (err: any) {
            ctx.log?.error(`${tag} Failed to process message: ${err.message}`);
          }
        },
        onError: (error, context) => {
          ctx.log?.error(`${tag} Dyad error (${context}): ${error.message}`);
        },
        onConnect: () => {
          ctx.log?.info(`${tag} Connected to Supabase Realtime`);
        },
        onDisconnect: () => {
          ctx.log?.warn(`${tag} Disconnected from Supabase Realtime`);
        },
        // Coordination options — only active if coordChatId is configured
        ...(coordEnabled
          ? {
              coordChatId: account.coordChatId!,
              apiUrl: account.apiUrl,
              apiBotToken: account.apiBotToken!,
              botName: account.botName,
              onCoordinationMessage: async (msg) => {
                if (coordination) {
                  await coordination.handleMessage(msg);
                }
              },
            }
          : {}),
      });

      // Create coordination handler after bus is ready (needs bus.sendCoordination)
      if (coordEnabled) {
        coordination = createCoordinationHandler({
          botName: account.botName,
          callGateway,
          postToCoordination: async (content: string) => {
            try {
              await bus.sendCoordination(content);
            } catch (e: any) {
              ctx.log?.error(`${tag} Post to coordination failed: ${e.message}`);
            }
          },
          log: {
            info: (m) => ctx.log?.info(`${tag} [coord] ${m}`),
            warn: (m) => ctx.log?.warn(`${tag} [coord] ${m}`),
            error: (m) => ctx.log?.error(`${tag} [coord] ${m}`),
          },
        });

        ctx.log?.info(
          `${tag} Coordination enabled (chat: ${account.coordChatId!.slice(0, 8)}..., bot: ${account.botName})`,
        );
      }

      // Store the bus handle
      activeBuses.set(account.accountId, bus);

      ctx.log?.info(`${tag} Dyad provider started, listening for messages`);

      // Return cleanup function
      return {
        stop: () => {
          if (coordination) {
            coordination.cleanup();
            coordination = null;
          }
          bus.disconnect().catch((err) => {
            ctx.log?.error(`${tag} Error disconnecting: ${err.message}`);
          });
          activeBuses.delete(account.accountId);
          ctx.log?.info(`${tag} Dyad provider stopped`);
        },
      };
    },
  },
};

/**
 * Get all active Dyad bus handles.
 */
export function getActiveDyadBuses(): Map<string, DyadBusHandle> {
  return new Map(activeBuses);
}
