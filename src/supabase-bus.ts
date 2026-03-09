/**
 * Supabase bus for Dyad channel plugin — v5 table-backed dispatch.
 *
 * Architecture:
 *   Dispatch route: INSERT pending_dispatches (durable) + broadcast (fast path)
 *   Plugin:         broadcast delivers (~100ms) → claim row (CAS) → process
 *                   poll every 2s (safety net)  → find unclaimed  → claim → process
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
// Streaming coalesce buffer — prevents micro-POSTs from fast streaming models
// ============================================================================

export class CoalesceBuffer {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly flush: (text: string) => Promise<void>,
    private readonly minChars = 1500,
    private readonly idleMs = 1000,
  ) {}

  append(chunk: string): void {
    this.buffer += chunk;
    if (this.timer) clearTimeout(this.timer);

    if (this.buffer.length >= this.minChars) {
      this.flushing = this.doFlush();
    } else {
      this.timer = setTimeout(() => {
        this.flushing = this.doFlush();
      }, this.idleMs);
    }
  }

  async finalize(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.flushing;
    if (this.buffer.length > 0) {
      await this.doFlush();
    }
  }

  private async doFlush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const text = this.buffer;
    this.buffer = "";
    if (text) await this.flush(text);
  }
}

// ============================================================================
// Transport health tracking
// ============================================================================

export interface TransportHealth {
  lastDispatchAt: number | null;
  lastProbeAt: number | null;
  lastProbeOk: boolean;
  lastProbeLatencyMs: number;
  lastProbeError?: string;
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
  /** Dyad API URL for HTTP message posting (replaces direct Supabase INSERT) */
  apiUrl?: string;
  /** Dyad API bearer token for HTTP message posting */
  apiToken?: string;
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
  /** Coordination chat ID — enables inter-agent backchannel subscription */
  coordChatId?: string;
  /** Max coordination chain depth (default 4) */
  maxCoordinationDepth?: number;
  /** Callback for inbound coordination messages from other agents */
  onCoordinationMessage?: (msg: {
    chatId: string;
    text: string;
    messageId: string;
    speaker: string;
    kind: string;
    depth: number;
    rawParsed: Record<string, unknown>;
  }) => Promise<void>;
}

export interface DyadBusHandle {
  sendMessage: (chatId: string, content: string) => Promise<void>;
  sendStreamingChunk: (chatId: string, content: string, exchangeId: string, sequenceNumber: number, isFinal: boolean) => Promise<void>;
  sendCoordinationMessage: (chatId: string, content: string) => Promise<void>;
  probeDyad: () => Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  disconnect: () => Promise<void>;
  waitUntilDead: () => Promise<void>;
  health: TransportHealth;
  client: SupabaseClient;
}

// ============================================================================
// Constants
// ============================================================================

const POLL_INTERVAL_MS = 2_000;
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

  // Boot timestamp — skip any messages created before this bus instance started.
  // Prevents replaying stale dispatches/coordination from before a gateway restart.
  const bootTime = new Date().toISOString();
  console.log(`[dyad-bus] Boot time: ${bootTime}`);

  // Transport health tracking
  const health: TransportHealth = {
    lastDispatchAt: null,
    lastProbeAt: null,
    lastProbeOk: true,
    lastProbeLatencyMs: 0,
  };

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
      const { data: claimed } = await supabase
        .from("pending_dispatches")
        .update({ status: "handled", handled_at: new Date().toISOString() })
        .eq("bot_id", botId)
        .eq("message_id", messageId)
        .eq("status", "pending")
        .select("id");

      if (!claimed || claimed.length === 0) {
        console.log(`[dyad-bus] CAS claim lost (0 rows) for ${messageId.slice(0, 8)} — skipping`);
        return;
      }
    } catch (err) {
      // CAS claim failed — log but don't block processing.
      // Row may not exist yet (broadcast arrived before INSERT committed).
      onError(err as Error, "cas-claim");
    }

    health.lastDispatchAt = Date.now();
    await onMessage({
      chatId: payload.chatId,
      text: payload.text,
      userId: botUserId,
      messageId: payload.messageId,
      speaker: payload.speaker ?? "",
    });
  }

  // ============================================================================
  // Poll fallback — 2s safety net
  // ============================================================================

  // One-time cleanup: mark stale rows from before boot as handled
  async function cleanupPreBootRows(): Promise<void> {
    try {
      await supabase
        .from("pending_dispatches")
        .update({ status: "handled", handled_at: new Date().toISOString() })
        .eq("bot_id", botId)
        .eq("status", "pending")
        .lt("created_at", bootTime);
    } catch (err) {
      onError(err as Error, "pre-boot-cleanup");
    }
  }

  async function pollPending(): Promise<void> {
    try {
      const { data } = await supabase
        .from("pending_dispatches")
        .select("*")
        .eq("bot_id", botId)
        .eq("status", "pending")
        .gte("created_at", bootTime)
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
        console.log(`[dyad-bus] Dispatch received via POLL: ${row.message_id.slice(0, 8)} for chat ${(row.payload as any)?.chatId?.slice(0, 8)}`);
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

      console.log(`[dyad-bus] Dispatch received via BROADCAST: ${messageId.slice(0, 8)} for chat ${chatId.slice(0, 8)}`);
      await claimAndProcess(messageId, { chatId, text, speaker: speaker ?? "", messageId });
    })
    .subscribe((status: string) => {
      if (status === "SUBSCRIBED") {
        console.log(`[dyad-bus] Broadcast channel subscribed: ${channelName}`);
        onConnect?.();
      } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn(`[dyad-bus] Broadcast channel ${status}: ${channelName}`);
        onDisconnect?.();
        deathResolve?.();
      }
    });

  // Clean up pre-boot stale rows (one-time), then start polling
  await cleanupPreBootRows();
  startPolling();

  // ============================================================================
  // Coordination channel subscription (inter-agent backchannel)
  // ============================================================================

  const MAX_COORDINATION_DEPTH = opts.maxCoordinationDepth ?? 4;
  const VALID_COORD_KINDS = new Set(["question", "inform", "flag", "delegate", "status", "signal"]);
  let coordChannel: RealtimeChannel | null = null;

  if (opts.coordChatId && opts.onCoordinationMessage) {
    const coordChatId = opts.coordChatId;
    const coordChannelName = `coord-${botId}`;
    console.log(`[dyad-bus] coordChatId: ${coordChatId.slice(0, 8)}… (coordination subscription active)`);

    coordChannel = supabase
      .channel(coordChannelName)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `chat_id=eq.${coordChatId}`,
        },
        async (payload: { new: Record<string, unknown> }) => {
          try {
            const msg = payload.new;
            if (!msg) return;

            // Filter 0: Skip messages from before this bus booted (stale WAL replay)
            if (msg.created_at && (msg.created_at as string) < bootTime) return;

            // Filter 1: Only bot_coordination messages
            if (msg.message_type !== "bot_coordination") return;

            // Filter 2: Not from self
            const speakerLower = (msg.speaker as string)?.toLowerCase();
            if (speakerLower === botDisplayName?.toLowerCase()) return;

            // Filter 3: Dedup
            if (isDuplicate(msg.id as string)) return;

            // Filter 4: Parse structured JSON content
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(msg.content as string);
            } catch {
              return; // Not valid structured JSON — skip
            }

            // Filter 5: Must be a known inter-agent message kind
            const kind = parsed.kind as string;
            if (!kind || !VALID_COORD_KINDS.has(kind)) return;

            // Filter 6: Addressed to this bot or broadcast (no `to` field)
            if (parsed.to && (parsed.to as string).toLowerCase() !== botDisplayName?.toLowerCase()) return;

            // Filter 7: Depth cap
            const depth = typeof parsed.depth === "number" ? parsed.depth : 0;
            if (depth >= MAX_COORDINATION_DEPTH) {
              console.log(`[dyad-bus] Coordination message dropped: depth=${depth} >= cap=${MAX_COORDINATION_DEPTH}`);
              return;
            }

            // Filter 8: Respect expects_reply — default to false for non-question kinds
            const implicitExpectsReply = (kind === "question");
            const expectsReply = parsed.expects_reply ?? implicitExpectsReply;
            if (!expectsReply) {
              console.log(`[dyad-bus] Coordination message skipped: expects_reply=${expectsReply} (depth=${depth}, kind=${kind})`);
              return;
            }

            // Format as readable text for the agent
            const fromLabel = (msg.speaker as string) || "Unknown";
            const kindLabel = kind === "question" ? "asks" : kind === "flag" ? "flags" : kind === "delegate" ? "delegates" : "says";
            const toLabel = parsed.to ? ` (to ${parsed.to})` : "";
            const depthLabel = ` [depth=${depth}/${MAX_COORDINATION_DEPTH}]`;
            const text = `[Coordination${toLabel}${depthLabel}] ${fromLabel} ${kindLabel}: ${parsed.content || ""}`;

            console.log(`[dyad-bus] Coordination message from ${fromLabel}: ${kind} (depth=${depth})`);

            await opts.onCoordinationMessage!({
              chatId: coordChatId,
              text,
              messageId: msg.id as string,
              speaker: msg.speaker as string,
              kind,
              depth,
              rawParsed: parsed,
            });
          } catch (err) {
            onError(err as Error, "coord-message");
          }
        },
      )
      .subscribe((status: string) => {
        if (status === "SUBSCRIBED") {
          console.log(`[dyad-bus] Coordination channel subscribed: ${coordChannelName}`);
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          // Log but do NOT trigger deathResolve — coordination is secondary
          console.warn(`[dyad-bus] Coordination channel ${status}: ${coordChannelName} (non-fatal)`);
        }
      });
  } else {
    console.log(`[dyad-bus] No coordChatId — coordination subscription skipped`);
  }

  // ============================================================================
  // Heartbeat — keeps DB connection alive + proves bot connectivity to Dyad API
  // ============================================================================

  const pingApi = async () => {
    if (opts.apiUrl && opts.apiToken) {
      try {
        const res = await fetch(`${opts.apiUrl}/api/v2/bot/ping`, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiToken}` },
        });
        if (!res.ok) {
          onError(new Error(`Ping failed: HTTP ${res.status}`), "heartbeat");
        }
      } catch (e) {
        onError(e as Error, "heartbeat");
      }
    } else {
      // Fallback: DB keepalive if no API credentials
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
    }
  };

  // Initial ping on startup
  pingApi();
  keepaliveTimer = setInterval(pingApi, KEEPALIVE_INTERVAL_MS);

  // ============================================================================
  // Public API
  // ============================================================================

  // Shared helper: POST to Dyad API (replaces direct Supabase INSERT which is blocked by RLS)
  async function apiPost(path: string, body: Record<string, unknown>): Promise<void> {
    if (!opts.apiUrl || !opts.apiToken) {
      throw new Error("apiUrl/apiToken not configured in bot token — cannot post via API");
    }
    const res = await fetch(`${opts.apiUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`API call failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
    }
  }

  return {
    async sendMessage(chatId: string, content: string): Promise<void> {
      await apiPost("/api/v2/bot/message", {
        chat_id: chatId,
        content,
        message_type: "bot_response",
      });
    },

    async sendStreamingChunk(chatId: string, content: string, exchangeId: string, sequenceNumber: number, isFinal: boolean): Promise<void> {
      await apiPost("/api/v2/bot/message", {
        chat_id: chatId,
        content,
        message_type: "bot_response",
        is_final: isFinal,
        exchange_id: exchangeId,
        sequence_number: sequenceNumber,
      });
    },

    async sendCoordinationMessage(chatId: string, content: string): Promise<void> {
      await apiPost("/api/v2/bot/message", {
        chat_id: chatId,
        content,
        message_type: "bot_coordination",
      });
    },

    async disconnect(): Promise<void> {
      stopPolling();
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (coordChannel) {
        await supabase.removeChannel(coordChannel);
        coordChannel = null;
      }
      if (dispatchChannel) {
        await supabase.removeChannel(dispatchChannel);
        dispatchChannel = null;
      }
      await supabase.removeAllChannels();
    },

    async probeDyad(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
      const start = Date.now();
      try {
        const { error } = await supabase
          .from("bot_tokens")
          .select("id")
          .eq("id", botId)
          .limit(1);
        const latencyMs = Date.now() - start;
        health.lastProbeAt = Date.now();
        if (error) {
          health.lastProbeOk = false;
          health.lastProbeError = error.message;
          return { ok: false, latencyMs, error: error.message };
        }
        health.lastProbeOk = true;
        health.lastProbeError = undefined;
        health.lastProbeLatencyMs = latencyMs;
        return { ok: true, latencyMs };
      } catch (err) {
        const latencyMs = Date.now() - start;
        health.lastProbeAt = Date.now();
        health.lastProbeOk = false;
        health.lastProbeError = (err as Error).message;
        return { ok: false, latencyMs, error: (err as Error).message };
      }
    },

    waitUntilDead: () => deathPromise,

    health,

    client: supabase,
  };
}
