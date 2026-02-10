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
  /** Workspace ID to scope messages */
  workspaceId: string;
  /** Bot ID (from bot_tokens) */
  botId: string;
  /** Bot's user ID in Dyad (used as speaker identity) */
  botUserId: string;
  /** Called when a new message arrives for the bot */
  onMessage: (msg: {
    chatId: string;
    text: string;
    userId: string;
    messageId: string;
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

const STALE_THRESHOLD_MS = 120_000; // 2 minutes without any event = stale
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
 * `message_type=eq.claude_request`, verifies the message belongs to
 * the configured workspace, and routes to the onMessage callback.
 *
 * If coordChatId is provided, also subscribes to coordination messages.
 */
export async function startDyadBus(opts: DyadBusOptions): Promise<DyadBusHandle> {
  const {
    supabaseUrl,
    supabaseKey,
    workspaceId,
    botId,
    botUserId,
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

  // Track known chat IDs that belong to this workspace (cache)
  const workspaceChatIds = new Set<string>();

  // Subscription health tracking
  let lastEventTime = Date.now();
  let messageChannel: RealtimeChannel | null = null;
  let coordChannel: RealtimeChannel | null = null;

  // Dedup for coordination messages
  const seenCoordIds = new Set<string>();

  // Interval handles for cleanup
  const intervals: ReturnType<typeof setInterval>[] = [];

  // Pre-load workspace chats
  try {
    const { data: chats, error } = await supabase
      .from("chats")
      .select("id")
      .eq("workspace_id", workspaceId);

    if (error) {
      onError(new Error(error.message), "load workspace chats");
    } else if (chats) {
      for (const chat of chats) {
        workspaceChatIds.add(chat.id);
      }
    }
  } catch (err) {
    onError(err as Error, "load workspace chats");
  }

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

            // Verify this chat belongs to our workspace
            if (!workspaceChatIds.has(msg.chat_id)) {
              const { data: chat, error } = await supabase
                .from("chats")
                .select("id, workspace_id")
                .eq("id", msg.chat_id)
                .single();

              if (error || !chat || chat.workspace_id !== workspaceId) {
                return;
              }

              workspaceChatIds.add(msg.chat_id);
            }

            await onMessage({
              chatId: msg.chat_id,
              text: msg.content ?? "",
              userId: msg.user_id,
              messageId: msg.id,
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

            // Dedup
            if (seenCoordIds.has(msg.id)) return;
            seenCoordIds.add(msg.id);
            setTimeout(() => seenCoordIds.delete(msg.id), 60_000);

            // Parse content
            let parsed: any = null;
            try {
              parsed = JSON.parse(msg.content);
            } catch {
              // Leave null — handler deals with unparseable messages
            }

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

  // Keepalive: query DB periodically to keep connection warm
  if (coordChatId) {
    intervals.push(
      setInterval(async () => {
        try {
          const { error } = await supabase
            .from("messages")
            .select("id")
            .eq("chat_id", coordChatId)
            .order("created_at", { ascending: false })
            .limit(1);
          if (error) {
            onError(new Error(error.message), "keepalive query");
          }
        } catch (e) {
          onError(e as Error, "keepalive");
        }
      }, KEEPALIVE_INTERVAL_MS),
    );
  }

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
        speaker: "assistant",
        content,
        message_type: "bot_response",
      });

      if (error) {
        throw new Error(`Failed to send message: ${error.message}`);
      }
    },

    async sendCoordination(content: string): Promise<void> {
      if (!coordChatId || !apiUrl || !apiBotToken) {
        throw new Error("Coordination not configured (missing coordChatId, apiUrl, or apiBotToken)");
      }

      const res = await fetch(`${apiUrl}/api/v2/bot/message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiBotToken}`,
        },
        body: JSON.stringify({
          chat_id: coordChatId,
          content,
          message_type: "bot_coordination",
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Post to coordination HTTP ${res.status}: ${text.slice(0, 200)}`);
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
