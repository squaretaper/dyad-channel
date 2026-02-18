/**
 * Supabase Realtime connection manager for Dyad channel plugin.
 *
 * Subscribes to INSERT/UPDATE events on the messages table filtered by
 * message_type=claude_request, and provides a method to write bot responses back.
 *
 * v4: Pure transport — no coordination subscription.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// RealtimeChannel type — use ReturnType to avoid import issues across supabase-js versions
type RealtimeChannel = ReturnType<SupabaseClient["channel"]>;

// ============================================================================
// Types
// ============================================================================

export interface DyadMessage {
  id: string;
  chat_id: string;
  user_id: string;
  content: string;
  message_type: string;
  speaker: string;
  created_at: string;
}

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
  /** Called when a new message arrives for the bot */
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
 * Subscribes to INSERT/UPDATE events on `public.messages` where
 * `message_type=eq.claude_request` and routes to the onMessage callback.
 * No workspace filtering — responds to all messages (self-messages excluded).
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
  let messageChannel: RealtimeChannel | null = null;

  // Dedup for messages — dual-layer: ID-based + content-based
  const DEDUP_TTL_MS = 720_000; // 12 min
  const DEDUP_CONTENT_TTL_MS = 5_000; // 5s
  const seenMessageIds = new Set<string>();
  const seenContentKeys = new Set<string>();

  // Interval handles for cleanup
  const intervals: ReturnType<typeof setInterval>[] = [];

  // ============================================================================
  // Message subscription (claude_request messages)
  // ============================================================================

  async function handleMessageEvent(payload: any): Promise<void> {
    lastEventTime = Date.now();
    try {
      const msg = payload.new as DyadMessage;

      // Skip our own messages (prevent loops)
      if (msg.user_id === botUserId) {
        return;
      }

      // Dedup layer 1: ID-based
      if (seenMessageIds.has(msg.id)) {
        onError(new Error(`Dedup(id): skipped duplicate msg ${msg.id.slice(0, 8)}`), "dedup");
        return;
      }
      seenMessageIds.add(msg.id);
      setTimeout(() => seenMessageIds.delete(msg.id), DEDUP_TTL_MS);

      // Dedup layer 2: content-based
      const contentKey = `${msg.chat_id}:${msg.user_id}:${(msg.content || "").slice(0, 80)}`;
      if (seenContentKeys.has(contentKey)) {
        onError(new Error(`Dedup(content): skipped duplicate msg ${msg.id.slice(0, 8)}`), "dedup");
        return;
      }
      seenContentKeys.add(contentKey);
      setTimeout(() => seenContentKeys.delete(contentKey), DEDUP_CONTENT_TTL_MS);

      await onMessage({
        chatId: msg.chat_id,
        text: msg.content ?? "",
        userId: msg.user_id,
        messageId: msg.id,
        speaker: msg.speaker ?? "",
      });
    } catch (err) {
      onError(err as Error, "handle message");
    }
  }

  function subscribeMessages(): void {
    if (messageChannel) {
      supabase.removeChannel(messageChannel);
    }

    const channelName = `dyad-bot-${botId}-${Date.now()}`;
    messageChannel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: "message_type=eq.claude_request",
        },
        handleMessageEvent,
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "messages",
          filter: "message_type=eq.claude_request",
        },
        handleMessageEvent,
      )
      .subscribe((status: string) => {
        if (status === "SUBSCRIBED") {
          onConnect?.();
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          onDisconnect?.();
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            setTimeout(() => subscribeMessages(), RECONNECT_DELAY_MS);
          }
        }
      });
  }

  // ============================================================================
  // Health: staleness watchdog + keepalive
  // ============================================================================

  intervals.push(
    setInterval(() => {
      const silentMs = Date.now() - lastEventTime;
      if (silentMs > STALE_THRESHOLD_MS) {
        onError(
          new Error(`No events for ${Math.round(silentMs / 1000)}s — reconnecting`),
          "staleness watchdog",
        );
        lastEventTime = Date.now();
        subscribeMessages();
      }
    }, HEALTH_CHECK_INTERVAL_MS),
  );

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

  // Polling fallback: catches Realtime misses
  const POLL_INTERVAL_MS = 5_000;
  const POLL_LOOKBACK_MS = 30_000;
  intervals.push(
    setInterval(async () => {
      try {
        const since = new Date(Date.now() - POLL_LOOKBACK_MS).toISOString();
        const { data, error } = await supabase
          .from("messages")
          .select("*")
          .eq("message_type", "claude_request")
          .gt("created_at", since)
          .order("created_at", { ascending: true })
          .limit(10);

        if (error || !data) return;

        for (const msg of data) {
          if (msg.user_id === botUserId) continue;
          if (seenMessageIds.has(msg.id)) continue;

          onError(
            new Error(`Polling caught missed msg ${msg.id.slice(0, 8)}`),
            "polling fallback",
          );
          await handleMessageEvent({ new: msg });
        }
      } catch (e) {
        onError(e as Error, "polling fallback");
      }
    }, POLL_INTERVAL_MS),
  );

  // ============================================================================
  // Start subscription
  // ============================================================================

  subscribeMessages();

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

      if (messageChannel) {
        await supabase.removeChannel(messageChannel);
        messageChannel = null;
      }
    },

    client: supabase,
  };
}
