/**
 * Supabase bus for Dyad channel plugin — v5 table-backed dispatch.
 *
 * Architecture:
 *   Dispatch route: INSERT pending_dispatches (durable) + broadcast (fast path)
 *   Plugin:         broadcast delivers (~100ms) → claim row (CAS) → process
 *                   poll every 5s (safety net)  → find unclaimed  → claim → process
 *                   reconnect loop              → keeps WS alive for fast path
 *
 * Exactly-once: CAS row claim (UPDATE ... SET status='handled' WHERE status='pending')
 * + module-level dedup Set. Only one path wins the claim; dedup catches any edge race.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// RealtimeChannel type
type RealtimeChannel = ReturnType<SupabaseClient["channel"]>;

// ============================================================================
// Module-level dedup — persists across bus instances and reconnects.
// This is the single dedup layer for the entire plugin.
// ============================================================================
const processedIds = new Set<string>();
const DEDUP_TTL_MS = 600_000; // 10 min

function isDuplicate(messageId: string): boolean {
  if (processedIds.has(messageId)) return true;
  processedIds.add(messageId);
  setTimeout(() => processedIds.delete(messageId), DEDUP_TTL_MS);
  return false;
}

// ============================================================================
// Types
// ============================================================================

export interface DyadBusOptions {
  supabaseUrl: string;
  supabaseKey: string;
  botId: string;
  botUserId: string;
  botEmail?: string;
  botPassword?: string;
  botDisplayName?: string;
  onMessage: (msg: {
    chatId: string;
    text: string;
    userId: string;
    messageId: string;
    speaker: string;
  }) => Promise<void>;
  onError: (error: Error, context: string) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export interface DyadBusHandle {
  sendMessage: (chatId: string, content: string) => Promise<void>;
  disconnect: () => Promise<void>;
  waitUntilDead: () => Promise<void>;
  client: SupabaseClient;
}

// ============================================================================
// Constants
// ============================================================================

const POLL_INTERVAL_MS = 5_000;
const KEEPALIVE_INTERVAL_MS = 60_000;

// ============================================================================
// Main Bus
// ============================================================================

export async function startDyadBus(opts: DyadBusOptions): Promise<DyadBusHandle> {
  const {
    supabaseUrl,
    supabaseKey,
    botId,
    botUserId,
    botEmail,
    botPassword,
    botDisplayName,
    onMessage,
    onError,
    onConnect,
    onDisconnect,
  } = opts;

  // Fresh Supabase client per bus instance (clean WS state on reconnect)
  const supabase = createClient(supabaseUrl, supabaseKey, {
    realtime: {
      params: { eventsPerSecond: 10 },
    },
  });

  // Sign in as the bot user so RLS passes
  if (botEmail && botPassword) {
    console.log(`[dyad-bus] Attempting sign-in for ${botEmail}`);
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email: botEmail,
      password: botPassword,
    });
    if (signInError) {
      onError(new Error(`Bot sign-in failed: ${signInError.message}`), "auth");
    } else {
      console.log(`[dyad-bus] Sign-in OK, user: ${signInData.user?.id}`);
    }
  } else {
    console.log(`[dyad-bus] No botEmail/botPassword — skipping sign-in`);
  }

  // Death signal — resolves when WS dies (reconnect loop in channel.ts restarts)
  let deathResolve: (() => void) | null = null;
  const deathPromise = new Promise<void>((r) => { deathResolve = r; });

  let dispatchChannel: RealtimeChannel | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  // ============================================================================
  // CAS row claim — atomic, broadcast and poll can't both win
  // ============================================================================

  async function claimAndProcess(
    messageId: string,
    payload: { chatId: string; text: string; speaker: string; messageId: string },
  ): Promise<void> {
    // Atomic claim: UPDATE only if status is still 'pending'
    try {
      await supabase
        .from("pending_dispatches")
        .update({ status: "handled", handled_at: new Date().toISOString() })
        .eq("bot_id", botId)
        .eq("message_id", messageId)
        .eq("status", "pending");
    } catch (err) {
      // CAS claim failed — log but don't block processing.
      // Row may not exist yet (broadcast arrived before INSERT committed).
      onError(err as Error, "cas-claim");
    }

    await onMessage({
      chatId: payload.chatId,
      text: payload.text,
      userId: botUserId,
      messageId: payload.messageId,
      speaker: payload.speaker ?? "",
    });
  }

  // ============================================================================
  // Poll fallback — 5s safety net
  // ============================================================================

  async function pollPending(): Promise<void> {
    try {
      const { data } = await supabase
        .from("pending_dispatches")
        .select("*")
        .eq("bot_id", botId)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(20);

      for (const row of data || []) {
        if (isDuplicate(row.message_id)) {
          // Already processed via broadcast — just claim the row silently
          await supabase
            .from("pending_dispatches")
            .update({ status: "handled", handled_at: new Date().toISOString() })
            .eq("id", row.id)
            .eq("status", "pending");
          continue;
        }
        await claimAndProcess(row.message_id, row.payload);
      }

      // Cleanup: delete handled rows older than 1 hour
      await supabase
        .from("pending_dispatches")
        .delete()
        .eq("bot_id", botId)
        .eq("status", "handled")
        .lt("handled_at", new Date(Date.now() - 3_600_000).toISOString());
    } catch (err) {
      onError(err as Error, "poll");
    }
  }

  function startPolling(): void {
    pollPending(); // immediate drain
    pollTimer = setInterval(() => pollPending(), POLL_INTERVAL_MS);
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ============================================================================
  // Broadcast subscription (fast path)
  // ============================================================================

  const channelName = `bot-dispatch-${botId}`;
  console.log(`[dyad-bus] Subscribing to broadcast channel: ${channelName}`);

  dispatchChannel = supabase
    .channel(channelName)
    .on("broadcast", { event: "dispatch" }, async (event: { payload: Record<string, unknown> }) => {
      const { chatId, text, speaker, messageId } = (event.payload ?? {}) as {
        chatId?: string;
        text?: string;
        speaker?: string;
        messageId?: string;
      };

      if (!chatId || !text || !messageId) return;
      if (isDuplicate(messageId)) return;

      // CAS claim + process
      await claimAndProcess(messageId, { chatId, text, speaker: speaker ?? "", messageId });
    })
    .subscribe((status: string) => {
      if (status === "SUBSCRIBED") {
        console.log(`[dyad-bus] Broadcast channel subscribed: ${channelName}`);
        onConnect?.();
        startPolling();
      } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn(`[dyad-bus] Broadcast channel ${status}: ${channelName}`);
        onDisconnect?.();
        deathResolve?.();
      }
    });

  // ============================================================================
  // DB keepalive — prevents idle connection timeout
  // ============================================================================

  keepaliveTimer = setInterval(async () => {
    try {
      const { error } = await supabase
        .from("bot_tokens")
        .select("id")
        .eq("id", botId)
        .limit(1);
      if (error) {
        onError(new Error(error.message), "keepalive query");
      }
    } catch (e) {
      onError(e as Error, "keepalive");
    }
  }, KEEPALIVE_INTERVAL_MS);

  // ============================================================================
  // Public API
  // ============================================================================

  return {
    async sendMessage(chatId: string, content: string): Promise<void> {
      const { error } = await supabase.from("messages").insert({
        chat_id: chatId,
        user_id: botUserId,
        speaker: botDisplayName || "Bot",
        content,
        message_type: "bot_response",
      });

      if (error) {
        throw new Error(`Failed to send message: ${error.message}`);
      }
    },

    async disconnect(): Promise<void> {
      stopPolling();
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (dispatchChannel) {
        await supabase.removeChannel(dispatchChannel);
        dispatchChannel = null;
      }
      await supabase.removeAllChannels();
    },

    waitUntilDead: () => deathPromise,

    client: supabase,
  };
}
