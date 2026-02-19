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
import { getDyadRuntime } from "./runtime.js";

// Store active bus handles per account
const activeBuses = new Map<string, DyadBusHandle>();
// Bus readiness — gates outbound.sendText until startAccount completes.
// Prevents "Outbound not configured" errors after SIGUSR1 restart.
const busReadyPromises = new Map<string, { promise: Promise<void>; resolve: () => void }>();

function getBusReadyPromise(accountId: string): Promise<void> {
  const existing = busReadyPromises.get(accountId);
  if (existing) return existing.promise;
  let resolve: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  busReadyPromises.set(accountId, { promise, resolve: resolve! });
  return promise;
}

function markBusReady(accountId: string): void {
  const existing = busReadyPromises.get(accountId);
  if (existing) {
    existing.resolve();
  } else {
    busReadyPromises.set(accountId, { promise: Promise.resolve(), resolve: () => {} });
  }
}

function resetBusReady(accountId: string): void {
  busReadyPromises.delete(accountId);
}

// ============================================================================
// Backoff utilities (inline — no external deps)
// ============================================================================

interface BackoffPolicy { initialMs: number; maxMs: number; factor: number; jitter: number; }

function computeBackoff(p: BackoffPolicy, attempt: number): number {
  const base = Math.min(p.initialMs * Math.pow(p.factor, attempt - 1), p.maxMs);
  return base + base * p.jitter * (Math.random() * 2 - 1);
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((r) => {
    if (signal?.aborted) { r(); return; }
    const t = setTimeout(r, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      looksLikeId: (input) => UUID_RE.test(input.trim()),
      hint: "<chat_id (UUID)>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 10000,
    sendText: async ({ to, text, accountId }) => {
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;

      // Wait for bus readiness (up to 5s)
      let bus = activeBuses.get(aid);
      if (!bus) {
        const readyPromise = getBusReadyPromise(aid);
        const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000));
        const result = await Promise.race([readyPromise.then(() => "ready" as const), timeout]);
        if (result === "timeout") {
          throw new Error(`Dyad bus not ready for account ${aid} after 5s wait`);
        }
        bus = activeBuses.get(aid);
        if (!bus) {
          throw new Error(`Dyad bus not running for account ${aid}`);
        }
      }

      // Guard: only deliver to valid chat UUIDs
      if (!UUID_RE.test(to)) {
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
      ctx.setStatus({ accountId: account.accountId });
      ctx.log?.info(`${tag} Starting Dyad provider (v5 table-backed dispatch)`);

      // Disconnect any stale bus from a previous start cycle
      const existingBus = activeBuses.get(account.accountId);
      if (existingBus) {
        ctx.log?.warn(`${tag} Cleaning up stale bus from previous start cycle`);
        try { await existingBus.disconnect(); } catch (_) { /* best-effort */ }
        activeBuses.delete(account.accountId);
        resetBusReady(account.accountId);
      }

      if (!account.configured || !account.decodedToken) {
        throw new Error("Dyad bot token not configured or invalid");
      }

      // Reconnect loop — keeps WS alive for fast-path broadcast,
      // poll continues as safety net. On WS death, reconnect with backoff.
      const BACKOFF: BackoffPolicy = { initialMs: 2_000, maxMs: 60_000, factor: 2, jitter: 0.2 };
      let attempts = 0;

      while (!ctx.abortSignal?.aborted) {
        let bus: DyadBusHandle | null = null;
        try {
          bus = await startDyadBus({
            supabaseUrl: account.supabaseUrl,
            supabaseKey: account.supabaseKey,
            botId: account.botId,
            botUserId: account.botUserId,
            botEmail: account.botEmail,
            botPassword: account.botPassword,
            botDisplayName: account.botName,
            onMessage: async ({ chatId, text, userId, messageId, speaker }) => {
              ctx.log?.info(`${tag} Dispatch for chat ${chatId}: ${text.slice(0, 50)}...`);

              try {
                const rt = getDyadRuntime();

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
                    deliver: async (payload: any, { kind }: any) => {
                      if (payload.text) {
                        await bus!.sendMessage(chatId, payload.text);
                        ctx.log?.info(`${tag} Reply sent to chat ${chatId} (${payload.text.length} chars, ${kind})`);
                      }
                    },
                    onError: (err: any, { kind }: any) => {
                      ctx.log?.error(`${tag} Dispatch error (${kind}): ${err}`);
                    },
                    onSkip: (payload: any, { kind, reason }: any) => {
                      ctx.log?.warn(`${tag} Reply skipped (${kind}): reason=${reason}`);
                    },
                  },
                });

                if (!result.queuedFinal) {
                  ctx.log?.warn(`${tag} No reply generated for chat ${chatId}`);
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
          });

          activeBuses.set(account.accountId, bus);
          markBusReady(account.accountId);
          ctx.setStatus({ accountId: account.accountId, running: true, lastStartAt: Date.now(), lastError: null });
          attempts = 0;
          ctx.log?.info(`${tag} Connected — broadcast + poll active`);

          // Block until WS dies (poll keeps running independently)
          await bus.waitUntilDead();
          ctx.log?.warn(`${tag} WS died, reconnecting for fast-path...`);
        } catch (err: any) {
          ctx.log?.error(`${tag} Connection error: ${err.message}`);
          ctx.setStatus({ accountId: account.accountId, lastError: err.message });
        }

        // Cleanup before reconnect
        if (bus) {
          try { await bus.disconnect(); } catch (_) { /* best-effort */ }
        }
        activeBuses.delete(account.accountId);
        resetBusReady(account.accountId);
        if (ctx.abortSignal?.aborted) break;

        attempts++;
        const delayMs = computeBackoff(BACKOFF, attempts);
        ctx.log?.info(`${tag} Reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${attempts})`);
        await sleepWithAbort(delayMs, ctx.abortSignal);
      }

      ctx.log?.info(`${tag} Dyad provider stopped (aborted)`);
    },
  },
};

/**
 * Get all active Dyad bus handles.
 */
export function getActiveDyadBuses(): Map<string, DyadBusHandle> {
  return new Map(activeBuses);
}
