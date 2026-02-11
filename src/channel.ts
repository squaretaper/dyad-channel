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
import { getDyadRuntime } from "./runtime.js";

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

      // Guard: only deliver to valid chat UUIDs.
      // The gateway may route callGateway responses (coordination LLM calls)
      // through outbound — those use non-UUID targets like "dyad:coord:*".
      // Silently skip to prevent coordination JSON from appearing as chat messages.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(to)) {
        return { channel: "dyad" as const, messageId: "", to };
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

      // Concurrency semaphore — cap parallel gateway calls to prevent session explosion
      const MAX_CONCURRENT_GATEWAY_CALLS = 3;
      let activeGatewayCalls = 0;
      const gatewayQueue: Array<() => void> = [];

      async function callGateway(
        prompt: string,
        timeoutMs: number,
        retries: number = 1,
      ): Promise<string | null> {
        for (let attempt = 0; attempt <= retries; attempt++) {
          // Concurrency guard — wait if at capacity
          if (activeGatewayCalls >= MAX_CONCURRENT_GATEWAY_CALLS) {
            await new Promise<void>(resolve => gatewayQueue.push(resolve));
          }
          activeGatewayCalls++;
          try {
            const thisTimeout = attempt === 0 ? timeoutMs : timeoutMs * 2;
            // Single stable session per bot — matches the old sidecar approach.
            // All coordination calls share one session so the bot accumulates
            // context across rounds. Depth cap (MAX_COORDINATION_DEPTH) bounds
            // the conversation, not session isolation.
            const sessionId = `dyad:coord`;
            const res = await fetch(`${account.gatewayUrl}/v1/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${account.gatewayToken}`,
              },
              body: JSON.stringify({
                model: "openclaw:main",
                user: sessionId,
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
          } finally {
            activeGatewayCalls--;
            gatewayQueue.shift()?.();
          }
        }
        return null;
      }

      // --- Create coordination handler (if configured) ---
      let coordination: CoordinationHandler | null = null;

      // --- Pending dispatches for coordination-aware message handling ---
      // When coordination is enabled, onMessage stores pending dispatches here
      // instead of dispatching immediately. The coordination handler resolves
      // them after negotiation (claim → dispatch, defer → skip).
      const pendingDispatches = new Map<
        string,
        {
          chatId: string;
          text: string;
          userId: string;
          timeoutId: ReturnType<typeof setTimeout>;
        }
      >();

      // Track message IDs that have already been dispatched (or are being dispatched).
      // Prevents duplicate Realtime INSERT events (~4ms apart) from triggering
      // two coordination rounds that both resolve → double dispatch → dropped reply.
      const dispatched = new Set<string>();

      // Will be set after bus is created (needs bus.sendMessage)
      let doDispatch: (chatId: string, text: string, userId: string) => Promise<void>;

      // Start bus with coordination opts wired in
      ctx.log?.info(`${tag} Bot identity: name="${account.botName}", userId=${account.botUserId}`);
      const bus = await startDyadBus({
        supabaseUrl: account.supabaseUrl,
        supabaseKey: account.supabaseKey,
        botId: account.botId,
        botUserId: account.botUserId,
        botEmail: account.botEmail,
        botPassword: account.botPassword,
        botDisplayName: account.botName,
        onMessage: async ({ chatId, text, userId, messageId }) => {
          ctx.log?.info(`${tag} Message from ${userId} in chat ${chatId}: ${text.slice(0, 50)}...`);

          // Coordination-aware dispatch: if coordination is active, hold dispatch
          // and let the coordination handler decide based on negotiation outcome.
          if (coordEnabled && coordination) {
            // Guard: duplicate Realtime INSERTs arrive ~4ms apart with different
            // notification IDs but the same messageId. Skip if already pending or dispatched.
            if (pendingDispatches.has(messageId)) {
              ctx.log?.warn(`${tag} Duplicate onMessage for ${messageId.slice(0, 8)} — already pending, skipping`);
              return;
            }
            if (dispatched.has(messageId)) {
              ctx.log?.warn(`${tag} Duplicate onMessage for ${messageId.slice(0, 8)} — already dispatched, skipping`);
              return;
            }

            const timeoutId = setTimeout(async () => {
              const pending = pendingDispatches.get(messageId);
              if (pending) {
                pendingDispatches.delete(messageId);
                // Check dispatched guard — another path may have dispatched during the wait
                if (dispatched.has(messageId)) return;
                dispatched.add(messageId);
                setTimeout(() => dispatched.delete(messageId), 60_000);
                ctx.log?.warn(`${tag} Coordination timeout for ${messageId.slice(0, 8)} — dispatching fallback`);
                await doDispatch(chatId, text, userId);
              }
            }, 30_000);

            pendingDispatches.set(messageId, { chatId, text, userId, timeoutId });
            ctx.log?.info(`${tag} Coordination enabled — holding dispatch for ${messageId.slice(0, 8)}, waiting for round`);
            return;
          }

          // No coordination — dispatch immediately
          await doDispatch(chatId, text, userId);
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

      // --- Native dispatch helper (uses bus.sendMessage for delivery) ---
      doDispatch = async (chatId: string, text: string, userId: string) => {
        try {
          const rt = getDyadRuntime();
          ctx.log?.info(`${tag} Runtime OK (v${rt.version}), dispatching via native pipeline`);

          const msgCtx = {
            Body: text,
            RawBody: text,
            From: userId,
            To: chatId,
            SessionKey: `dyad:${chatId}`,
            AccountId: account.accountId,
            ChatType: "group",
            Provider: "dyad",
            Surface: "dyad",
            OriginatingTo: chatId,
            SenderId: userId,
            CommandAuthorized: false,
          };

          const result = await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: msgCtx,
            cfg: ctx.cfg,
            dispatcherOptions: {
              deliver: async (payload, { kind }) => {
                ctx.log?.info(`${tag} Delivering ${kind} reply (text=${!!payload.text}, error=${!!payload.isError})`);
                if (payload.text) {
                  await bus.sendMessage(chatId, payload.text);
                  ctx.log?.info(`${tag} Reply sent to chat ${chatId} (${payload.text.length} chars)`);
                }
              },
              onError: (err, { kind }) => {
                ctx.log?.error(`${tag} Dispatch error (${kind}): ${err}`);
              },
              onSkip: (payload, { kind, reason }) => {
                ctx.log?.warn(`${tag} Reply skipped (${kind}): reason=${reason}, text=${payload.text?.slice(0, 80)}`);
              },
            },
          });

          ctx.log?.info(
            `${tag} Dispatch result: queuedFinal=${result.queuedFinal}, counts=${JSON.stringify(result.counts)}`,
          );

          if (!result.queuedFinal) {
            ctx.log?.warn(`${tag} No reply generated for chat ${chatId}`);
          }
        } catch (err: any) {
          ctx.log?.error(`${tag} Failed to process message: ${err.message}`);
        }
      };

      // Create coordination handler after bus is ready
      if (coordEnabled) {
        coordination = createCoordinationHandler({
          botName: account.botName,
          callGateway: (prompt, timeoutMs) => callGateway(prompt, timeoutMs),
          // Post to coordination via API route (same pattern as the sidecar).
          // The API route uses service role client → bypasses RLS.
          // Direct Supabase inserts require bot auth + RLS and fail silently.
          postToCoordination: async (content: string) => {
            try {
              const res = await fetch(`${account.apiUrl}/api/v2/bot/message`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${account.apiBotToken}`,
                },
                body: JSON.stringify({
                  chat_id: account.coordChatId,
                  content,
                  message_type: "bot_coordination",
                }),
              });
              if (!res.ok) {
                const text = await res.text().catch(() => "");
                ctx.log?.error(
                  `${tag} Post to coordination HTTP ${res.status}: ${text.slice(0, 200)}`,
                );
              }
            } catch (e: any) {
              ctx.log?.error(`${tag} Post to coordination failed: ${e.message}`);
            }
          },
          onDispatchDecision: async ({ triggerMessageId, shouldRespond, synthesizeContext }) => {
            if (!triggerMessageId) {
              ctx.log?.warn(`${tag} [coord] Dispatch decision without triggerMessageId — ignoring`);
              return;
            }

            // Primary double-dispatch guard: synchronous check + add is atomic in
            // single-threaded JS. If two coordination rounds both resolve for the
            // same trigger, only the first one passes this gate.
            if (dispatched.has(triggerMessageId)) {
              ctx.log?.warn(`${tag} [coord] Already dispatched ${triggerMessageId.slice(0, 8)} — ignoring duplicate decision`);
              return;
            }
            dispatched.add(triggerMessageId);
            setTimeout(() => dispatched.delete(triggerMessageId), 60_000);

            const pending = pendingDispatches.get(triggerMessageId);
            if (!pending) {
              ctx.log?.warn(`${tag} [coord] No pending dispatch for ${triggerMessageId.slice(0, 8)} — may have timed out`);
              return;
            }

            clearTimeout(pending.timeoutId);
            pendingDispatches.delete(triggerMessageId);

            if (shouldRespond) {
              ctx.log?.info(`${tag} [coord] Dispatch decision: RESPOND for ${triggerMessageId.slice(0, 8)}`);
              const prefixedText = synthesizeContext
                ? `${synthesizeContext}\n\n${pending.text}`
                : pending.text;
              await doDispatch(pending.chatId, prefixedText, pending.userId);
            } else {
              ctx.log?.info(`${tag} [coord] Dispatch decision: SKIP for ${triggerMessageId.slice(0, 8)} (deferred/abstained)`);
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
          // Clear pending dispatches
          for (const [, pending] of pendingDispatches) {
            clearTimeout(pending.timeoutId);
          }
          pendingDispatches.clear();
          dispatched.clear();

          // Drain gateway concurrency semaphore
          activeGatewayCalls = 0;
          for (const resolve of gatewayQueue) resolve();
          gatewayQueue.length = 0;

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
