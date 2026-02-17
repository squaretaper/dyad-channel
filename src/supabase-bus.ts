/**
 * Supabase Realtime connection manager for Dyad channel plugin.
 *
 * Subscribes to INSERT events on the messages table filtered by message_type,
 * and provides a method to write bot responses back.
 *
 * Optionally subscribes to a second coordination channel for inter-agent
 * negotiation messages (Layer 1 + Layer 2).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// RealtimeChannel type — use ReturnType to avoid import issues across supabase-js versions
type RealtimeChannel = ReturnType<SupabaseClient["channel"]>;
import type { ParsedCoordinationMessage } from "./types-coordination.js";

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

  // --- Coordination (optional) ---

  /** Coordination chat ID — enables coordination subscription */
  coordChatId?: string;
  /** Dyad API URL for posting coordination messages */
  apiUrl?: string;
  /** Hex API token for bot auth */
  apiBotToken?: string;
  /** Bot display name (used to filter own messages) */
  botName?: string;
  /** Called when a coordination message arrives */
  onCoordinationMessage?: (msg: ParsedCoordinationMessage) => Promise<void>;
}

export interface DyadBusHandle {
  /** Send a text message to a chat */
  sendMessage: (chatId: string, content: string) => Promise<void>;
  /** Send a coordination message to #coordination */
  sendCoordination: (content: string) => Promise<void>;
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
 * Subscribes to INSERT events on `public.messages` where
 * `message_type=eq.claude_request` and routes to the onMessage callback.
 * No workspace filtering — responds to all messages (self-messages excluded).
 *
 * If coordChatId is provided, also subscribes to coordination messages.
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
    coordChatId,
    apiUrl,
    apiBotToken,
    botName,
    onCoordinationMessage,
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
  let coordChannel: RealtimeChannel | null = null;

  // Dedup for messages — dual-layer: ID-based + content-based
  // ID-based catches exact row re-delivery. Content-based catches cases where
  // Supabase sends different notification IDs for the same INSERT (observed: 5x in 2ms).
  // TTLs must exceed STALE_THRESHOLD_MS (10 min) to survive reconnection replays.
  const DEDUP_TTL_MS = 720_000; // 12 min — ID-based, covers staleness watchdog + reconnect delay
  const DEDUP_CONTENT_TTL_MS = 5_000; // 5s — content-based, only needs to catch ~8ms duplicate rows
  const seenMessageIds = new Set<string>();
  const seenContentKeys = new Set<string>();
  const seenCoordIds = new Set<string>();
  const seenCoordContentKeys = new Set<string>();

  // Interval handles for cleanup
  const intervals: ReturnType<typeof setInterval>[] = [];

  // ============================================================================
  // Message subscription (claude_request messages)
  // ============================================================================

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
        async (payload: any) => {
          lastEventTime = Date.now();
          try {
            const msg = payload.new as DyadMessage;

            // Skip our own messages (prevent loops)
            if (msg.user_id === botUserId) {
              return;
            }

            // Dedup layer 1: ID-based (exact row re-delivery)
            if (seenMessageIds.has(msg.id)) {
              onError(new Error(`Dedup(id): skipped duplicate msg ${msg.id.slice(0, 8)}`), "dedup");
              return;
            }
            seenMessageIds.add(msg.id);
            setTimeout(() => seenMessageIds.delete(msg.id), DEDUP_TTL_MS);

            // Dedup layer 2: content-based (catches different notification IDs for same INSERT)
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
        },
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
  // Coordination subscription (bot_coordination messages)
  // ============================================================================

  function subscribeCoordination(): void {
    if (!coordChatId || !onCoordinationMessage) return;

    if (coordChannel) {
      supabase.removeChannel(coordChannel);
    }

    const channelName = `dyad-coord-${botName?.toLowerCase() || botId}-${Date.now()}`;
    coordChannel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `chat_id=eq.${coordChatId}`,
        },
        async (payload: any) => {
          lastEventTime = Date.now();
          try {
            const msg = payload.new as DyadMessage;

            // Only handle coordination messages
            if (msg.message_type !== "bot_coordination") return;

            // Skip own messages
            if (botName && msg.speaker === botName) return;

            // Dedup layer 1: ID-based
            if (seenCoordIds.has(msg.id)) return;
            seenCoordIds.add(msg.id);
            setTimeout(() => seenCoordIds.delete(msg.id), DEDUP_TTL_MS);

            // Parse content (needed for dedup key extraction)
            let parsed: any = null;
            try {
              parsed = JSON.parse(msg.content);
            } catch {
              // Leave null — handler deals with unparseable messages
            }

            // Dedup layer 2: content-based (catches different notification IDs for same INSERT)
            // Use round_id + kind + speaker for structured messages, fall back to content slice
            const coordKey = parsed?.round_id
              ? `${parsed.round_id}:${parsed.kind || parsed.intent?.type || "unknown"}:${msg.speaker}`
              : `${msg.speaker}:${(msg.content || "").slice(0, 80)}`;
            if (seenCoordContentKeys.has(coordKey)) return;
            seenCoordContentKeys.add(coordKey);
            setTimeout(() => seenCoordContentKeys.delete(coordKey), DEDUP_CONTENT_TTL_MS);

            await onCoordinationMessage({
              id: msg.id,
              speaker: msg.speaker,
              content: msg.content ?? "",
              parsed,
              messageType: msg.message_type,
            });
          } catch (err) {
            onError(err as Error, "handle coordination message");
          }
        },
      )
      .subscribe((status: string, err?: Error) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          onError(
            new Error(`Coordination subscription ${status}${err ? `: ${err.message}` : ""}`),
            "coordination subscribe",
          );
          setTimeout(() => subscribeCoordination(), RECONNECT_DELAY_MS);
        }
      });
  }

  // ============================================================================
  // Health: staleness watchdog + keepalive
  // ============================================================================

  // Staleness watchdog: detect stale subscriptions and reconnect
  intervals.push(
    setInterval(() => {
      const silentMs = Date.now() - lastEventTime;
      if (silentMs > STALE_THRESHOLD_MS) {
        onError(
          new Error(`No events for ${Math.round(silentMs / 1000)}s — reconnecting`),
          "staleness watchdog",
        );
        lastEventTime = Date.now(); // reset to avoid rapid reconnect loops
        subscribeMessages();
        subscribeCoordination();
      }
    }, HEALTH_CHECK_INTERVAL_MS),
  );

  // Keepalive: query DB periodically to keep Realtime connection warm
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
  // Start subscriptions
  // ============================================================================

  subscribeMessages();
  subscribeCoordination();

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

    async sendCoordination(content: string): Promise<void> {
      if (!coordChatId) {
        throw new Error("Coordination not configured (missing coordChatId)");
      }

      // Direct Supabase insert — bot is signed in via auth, RLS allows insert as chat member.
      // This bypasses the bot/message API route entirely (which had workspace_id validation issues).
      const { error } = await supabase.from("messages").insert({
        chat_id: coordChatId,
        user_id: botUserId,
        speaker: botDisplayName || "Bot",
        content,
        message_type: "bot_coordination",
      });

      if (error) {
        throw new Error(`Failed to send coordination message: ${error.message}`);
      }
    },

    async disconnect(): Promise<void> {
      // Clear all intervals
      for (const id of intervals) {
        clearInterval(id);
      }
      intervals.length = 0;

      // Remove channels
      if (messageChannel) {
        await supabase.removeChannel(messageChannel);
        messageChannel = null;
      }
      if (coordChannel) {
        await supabase.removeChannel(coordChannel);
        coordChannel = null;
      }
    },

    client: supabase,
  };
}
