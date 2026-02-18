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
      ctx.setStatus({
        accountId: account.accountId,
      });
      ctx.log?.info(`${tag} Starting Dyad provider`);

      if (!account.configured || !account.decodedToken) {
        throw new Error("Dyad bot token not configured or invalid");
      }

      // Synchronous messageId guard — catches duplicate delivery regardless of cause
      const processedMessageIds = new Set<string>();

      // Content-based dedup for onMessage
      const seenMsgContent = new Set<string>();

      // Start bus — Realtime subscription for inbound messages + outbound delivery.
      // Server-side dispatch route handles routing; plugin does NOT dispatch.
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
          // Absolute first guard — synchronous messageId check
          if (processedMessageIds.has(messageId)) {
            ctx.log?.warn(`${tag} MessageId dedup: skipped ${messageId.slice(0, 8)}`);
            return;
          }
          processedMessageIds.add(messageId);
          setTimeout(() => processedMessageIds.delete(messageId), 600_000);

          // Content-based dedup
          const msgKey = `${chatId}:${userId}:${text.slice(0, 80)}`;
          if (seenMsgContent.has(msgKey)) {
            ctx.log?.warn(`${tag} Content dedup: skipped duplicate for ${messageId.slice(0, 8)}`);
            return;
          }
          seenMsgContent.add(msgKey);
          setTimeout(() => seenMsgContent.delete(msgKey), 5_000);

          ctx.log?.info(`${tag} Message from ${userId} in chat ${chatId}: ${text.slice(0, 50)}...`);
          // No-op: server-side dispatch route handles gateway dispatch
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

      // Store the bus handle and signal readiness
      activeBuses.set(account.accountId, bus);
      markBusReady(account.accountId);

      ctx.log?.info(`${tag} Dyad provider started, listening for messages`);

      // Return cleanup function
      return {
        stop: () => {
          bus.disconnect().catch((err) => {
            ctx.log?.error(`${tag} Error disconnecting: ${err.message}`);
          });
          activeBuses.delete(account.accountId);
          resetBusReady(account.accountId);
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
