/**
 * Supabase Realtime connection manager for Dyad channel plugin.
 *
 * v4 hybrid: Receives dispatch signals via Supabase Realtime Broadcast
 * (ephemeral, no DB writes). Outbound bot responses written to `messages` table.
 *
 * The server-side dispatch route handles routing + RCD context injection,
 * then broadcasts to `bot-dispatch-{botId}`. This bus subscribes to that
 * broadcast channel and invokes onMessage when a dispatch arrives.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// RealtimeChannel type — use ReturnType to avoid import issues across supabase-js versions
type RealtimeChannel = ReturnType<SupabaseClient["channel"]>;

// ============================================================================
// Module-level dedup — persists across bus restarts, reconnects, and
// stacked subscriptions. This is the last line of defence.
// ============================================================================
const GLOBAL_DEDUP_TTL_MS = 720_000; // 12 min
const globalSeenIds = new Set<string>();

// ============================================================================
// Types
// ============================================================================

export interface DyadBusOptions {
  /** Supabase project URL */
  supabaseUrl: string;
  /** Supabase anon key (RLS-scoped) */
  supabaseKey: string;
  /** Bot ID (from bot_tokens) */
  botId: string;
  /** Bot's user ID in Dyad (used as speaker identity) */
  botUserId: string;
  /** Bot email for Supabase auth sign-in */
  botEmail?: string;
  /** Bot password for Supabase auth sign-in */
  botPassword?: string;
  /** Bot display name (used as speaker in messages) */
  botDisplayName?: string;
  /** Called when a dispatch signal arrives for this bot */
  onMessage: (msg: {
    chatId: string;
    text: string;
    userId: string;
    messageId: string;
    speaker: string;
  }) => Promise<void>;
  /** Called on errors */
  onError: (error: Error, context: string) => void;
  /** Called when Realtime connection is established */
  onConnect?: () => void;
  /** Called on Realtime disconnection */
  onDisconnect?: () => void;
}

export interface DyadBusHandle {
  /** Send a text message to a chat */
  sendMessage: (chatId: string, content: string) => Promise<void>;
  /** Disconnect from Supabase Realtime */
  disconnect: () => Promise<void>;
  /** Get the Supabase client (for advanced use) */
  client: SupabaseClient;
}

// ============================================================================
// Constants
// ============================================================================

const STALE_THRESHOLD_MS = 600_000; // 10 minutes without any event = stale
const HEALTH_CHECK_INTERVAL_MS = 30_000; // check every 30s
const KEEPALIVE_INTERVAL_MS = 60_000; // DB keepalive every 60s
const RECONNECT_DELAY_MS = 5_000;

// ============================================================================
// Main Bus
// ============================================================================

/**
 * Start the Dyad Supabase Realtime bus.
 *
 * Subscribes to a Broadcast channel `bot-dispatch-{botId}` for dispatch
 * signals from the server-side dispatch route. Outbound responses are
 * written to the `messages` table as `bot_response`.
 */
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

  // Create Supabase client
  const supabase = createClient(supabaseUrl, supabaseKey, {
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  });

  // Sign in as the bot user so Realtime subscriptions pass RLS
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
    console.log(`[dyad-bus] No botEmail/botPassword — skipping sign-in (email=${!!botEmail}, pwd=${!!botPassword})`);
  }

  // Subscription health tracking
  let lastEventTime = Date.now();
  let dispatchChannel: RealtimeChannel | null = null;

  // Dedup — dual-layer: ID-based + content-based
  const DEDUP_TTL_MS = 720_000; // 12 min
  const DEDUP_CONTENT_TTL_MS = 30_000; // 30s (Sonnet routing can take 10s+)
  const seenMessageIds = new Set<string>();
  const seenContentKeys = new Set<string>();

  // Interval handles for cleanup
  const intervals: ReturnType<typeof setInterval>[] = [];

  // ============================================================================
  // Broadcast dispatch handler
  //
  // The server-side dispatch route broadcasts a signal per selected bot.
  // Payload: { chatId, text, speaker, messageId }
  // ============================================================================

  async function handleDispatchEvent(event: { payload: Record<string, unknown> }): Promise<void> {
    lastEventTime = Date.now();
    try {
      const { chatId, text, speaker, messageId } = (event.payload ?? {}) as {
        chatId?: string;
        text?: string;
        speaker?: string;
        messageId?: string;
      };

      if (!chatId || !text || !messageId) {
        onError(new Error(`Invalid dispatch payload: missing fields`), "dispatch");
        return;
      }

      // Global dedup (module-level, survives bus restarts + stacked subscriptions)
      if (globalSeenIds.has(messageId)) {
        return; // silent — don't log, these are expected from stacked subscriptions
      }
      globalSeenIds.add(messageId);
      setTimeout(() => globalSeenIds.delete(messageId), GLOBAL_DEDUP_TTL_MS);

      // Dedup layer 1: ID-based (per-bus instance)
      if (seenMessageIds.has(messageId)) {
        onError(new Error(`Dedup(id): skipped duplicate dispatch ${messageId.slice(0, 8)}`), "dedup");
        return;
      }
      seenMessageIds.add(messageId);
      setTimeout(() => seenMessageIds.delete(messageId), DEDUP_TTL_MS);

      // Dedup layer 2: content-based
      const contentKey = `${chatId}:${speaker}:${(text || "").slice(0, 80)}`;
      if (seenContentKeys.has(contentKey)) {
        onError(new Error(`Dedup(content): skipped duplicate dispatch ${messageId.slice(0, 8)}`), "dedup");
        return;
      }
      seenContentKeys.add(contentKey);
      setTimeout(() => seenContentKeys.delete(contentKey), DEDUP_CONTENT_TTL_MS);

      await onMessage({
        chatId,
        text,
        userId: botUserId, // dispatch is addressed to this bot
        messageId,
        speaker: speaker ?? "",
      });
    } catch (err) {
      onError(err as Error, "handle dispatch");
    }
  }

  // ============================================================================
  // Broadcast channel subscription
  // ============================================================================

  async function subscribeDispatch(): Promise<void> {
    if (dispatchChannel) {
      // MUST await — fire-and-forget removeChannel was the root cause of stacked
      // subscriptions. Each unresolved removal left a ghost subscription on the
      // Realtime server, so after N reconnects the bot had N active subscriptions
      // all receiving the same broadcast independently.
      try { await supabase.removeChannel(dispatchChannel); } catch (_) { /* best-effort */ }
      dispatchChannel = null;
    }

    // Stable channel name — must match the dispatch route's broadcast target
    const channelName = `bot-dispatch-${botId}`;
    console.log(`[dyad-bus] Subscribing to broadcast channel: ${channelName}`);

    dispatchChannel = supabase
      .channel(channelName)
      .on("broadcast", { event: "dispatch" }, handleDispatchEvent)
      .subscribe((status: string) => {
        if (status === "SUBSCRIBED") {
          console.log(`[dyad-bus] Broadcast channel subscribed: ${channelName}`);
          onConnect?.();
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn(`[dyad-bus] Broadcast channel ${status}: ${channelName}`);
          onDisconnect?.();
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            setTimeout(() => subscribeDispatch(), RECONNECT_DELAY_MS);
          }
        }
      });
  }

  // ============================================================================
  // Health: staleness watchdog + DB keepalive
  // ============================================================================

  // Staleness watchdog disabled — subscribeDispatch() on a stale WebSocket
  // enters an infinite resubscribe loop because the new channel subscription
  // never receives a SUBSCRIBED callback. The initial subscription is reliable;
  // the watchdog was breaking it. TODO: replace with full Supabase client
  // reconnect if true stale detection is needed.

  intervals.push(
    setInterval(async () => {
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
    }, KEEPALIVE_INTERVAL_MS),
  );

  // ============================================================================
  // Start subscription
  // ============================================================================

  subscribeDispatch();

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
      for (const id of intervals) {
        clearInterval(id);
      }
      intervals.length = 0;

      if (dispatchChannel) {
        await supabase.removeChannel(dispatchChannel);
        dispatchChannel = null;
      }
      // Belt-and-suspenders: remove ALL channels on this client to kill any
      // ghost subscriptions left over from non-awaited removeChannel calls.
      await supabase.removeAllChannels();
    },

    client: supabase,
  };
}
