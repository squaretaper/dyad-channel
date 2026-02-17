/**
 * Coordination protocol handler for the Dyad channel plugin.
 *
 * v2: Haiku micro-proposals + deterministic SOLO filter
 *   - Each bot generates a micro-proposal via Haiku (~200ms)
 *   - Pure-logic filter picks ONE winner (no LLM needed)
 *   - Both bots agree deterministically (same inputs → same output)
 *   - State register biases turn-taking via prompt context (not filter logic)
 *
 * Layer 2: General inter-agent comms (unchanged from v1)
 *   - AgentMessage, resolution signals, free-form dialogue
 *   - Suppressed during active coordination rounds
 */

import {
  COORDINATION_PROTOCOL_VERSION,
  CONFIDENCE_EPSILON,
  CONFIDENCE_GAP_THRESHOLD,
  ANGLE_OVERLAP_THRESHOLD,
  HIGH_CONFIDENCE_THRESHOLD,
  LOW_CONFIDENCE_THRESHOLD,
  SYNTHESIS_CONFIDENCE_THRESHOLD,
  MAX_COORDINATION_DEPTH,
  type MicroProposal,
  type RegisterState,
  type DispatchMode,
  type FilterResult,
  type ParsedCoordinationMessage,
} from "./types-coordination.js";

// ============================================================================
// Public interface
// ============================================================================

export interface CoordinationHandler {
  handleMessage(msg: ParsedCoordinationMessage): Promise<void>;
  hasActiveRound(): boolean;
  cleanup(): void;
}

export interface DispatchDecision {
  roundId: string;
  triggerMessageId: string | null;
  shouldRespond: boolean;
  synthesizeContext?: string;
  /** When true, confirms a defer and cancels any backup timer (no dispatch needed). */
  cancelPending?: boolean;
  /** Micro-proposal of the responding bot (for register update). */
  proposal?: MicroProposal;
  /** Source chat ID (for register update). */
  sourceChatId?: string;
  /** v3.5 SYNTHESIS mode — runner-up waits for winner's response before dispatching. */
  waitForResponse?: {
    roundId: string;
    winnerName: string;
    myProposal: MicroProposal;
    otherProposal: MicroProposal;
  };
}

export interface CoordinationHandlerOpts {
  botName: string;
  callGateway: (prompt: string, timeoutMs: number) => Promise<string | null>;
  /** Haiku call for micro-proposals — routed through gateway model pass-through */
  callHaiku: (prompt: string) => Promise<string | null>;
  postToCoordination: (content: string) => Promise<void>;
  onDispatchDecision?: (decision: DispatchDecision) => Promise<void>;
  /** Load previous round outcomes for prompt injection. Returns formatted string or empty. */
  loadHistory?: (excludeRoundId: string) => Promise<string>;
  /** Load recent bot responses from the main chat for cross-agent awareness. */
  loadRecentResponses?: (sourceChatId: string) => Promise<string>;
  /** Read state register for a chat (turn-taking context). */
  getRegister?: (chatId: string) => RegisterState | undefined;
  log: {
    info(m: string): void;
    warn(m: string): void;
    error(m: string): void;
  };
}

// ============================================================================
// Constants
// ============================================================================

const ROUND_TIMEOUT_MS = 15000;  // v3.5: must exceed Haiku timeout + Opus fallback
const ROUND_CLEANUP_MS = 30000;  // v3.5: must exceed ROUND_TIMEOUT_MS
const SEEN_TTL_MS = 720_000;     // 12 min — must exceed staleness watchdog (10 min)

// ============================================================================
// Pure logic: coordination filter
// ============================================================================

/**
 * Deterministic coordination filter — routes to SOLO, PARALLEL, or SYNTHESIS.
 *
 * Both bots run this independently with the same inputs and MUST agree.
 * The filter uses only proposal data (confidence, angle, covers, builds_on_other,
 * names), never register state (which could differ between bots → disagreement).
 *
 * Routing logic:
 * 1. confidence_gap > 0.3 → SOLO (clear winner)
 * 2. both > 0.5 AND angle_overlap < 0.5 → PARALLEL (complementary angles)
 * 3. both > 0.7 AND angle_overlap >= 0.5 AND either builds_on_other → SYNTHESIS
 * 4. both > 0.5 AND angle_overlap >= 0.5 → SOLO (overlapping, avoid duplication)
 * 5. both < 0.3 → SOLO (neither has conviction)
 * 6. else → SOLO (default)
 *
 * winner = higher confidence (or lexicographic tiebreaker).
 * runnerUp = the other bot.
 */
function coordinationFilter(
  myProposal: MicroProposal,
  otherProposal: MicroProposal,
  myName: string,
  otherName: string,
): FilterResult {
  const proposals: Record<string, MicroProposal> = {
    [myName]: myProposal,
    [otherName]: otherProposal,
  };

  // Determine winner (higher confidence, lexicographic tiebreaker)
  const diff = myProposal.confidence - otherProposal.confidence;
  let winner: string;
  let runnerUp: string;

  if (Math.abs(diff) < CONFIDENCE_EPSILON) {
    // Tie — lexicographic tiebreaker
    winner = myName < otherName ? myName : otherName;
    runnerUp = winner === myName ? otherName : myName;
  } else if (diff > 0) {
    winner = myName;
    runnerUp = otherName;
  } else {
    winner = otherName;
    runnerUp = myName;
  }

  const confidenceGap = Math.abs(myProposal.confidence - otherProposal.confidence);
  const overlap = angleSimilarity(myProposal, otherProposal);
  const bothHigh = myProposal.confidence > HIGH_CONFIDENCE_THRESHOLD &&
    otherProposal.confidence > HIGH_CONFIDENCE_THRESHOLD;
  const bothLow = myProposal.confidence < LOW_CONFIDENCE_THRESHOLD &&
    otherProposal.confidence < LOW_CONFIDENCE_THRESHOLD;
  const bothSynthesisReady = myProposal.confidence > SYNTHESIS_CONFIDENCE_THRESHOLD &&
    otherProposal.confidence > SYNTHESIS_CONFIDENCE_THRESHOLD;
  const eitherBuildsOn = Boolean(myProposal.builds_on_other || otherProposal.builds_on_other);

  const base = { winner, runnerUp, proposals };

  // Rule 1: Large confidence gap → SOLO
  if (confidenceGap > CONFIDENCE_GAP_THRESHOLD) {
    return {
      ...base,
      mode: "solo" as DispatchMode,
      reason: `confidence gap ${confidenceGap.toFixed(2)} > ${CONFIDENCE_GAP_THRESHOLD} — ${winner} wins`,
    };
  }

  // Rule 2: Both high confidence + different angles → PARALLEL
  if (bothHigh && overlap < ANGLE_OVERLAP_THRESHOLD) {
    return {
      ...base,
      mode: "parallel" as DispatchMode,
      reason: `both confident (${myProposal.confidence.toFixed(2)}, ${otherProposal.confidence.toFixed(2)}), low overlap ${overlap.toFixed(2)} — parallel`,
    };
  }

  // Rule 3: Both very high confidence + overlapping angles + opt-in → SYNTHESIS
  if (bothSynthesisReady && overlap >= ANGLE_OVERLAP_THRESHOLD && eitherBuildsOn) {
    return {
      ...base,
      mode: "synthesis" as DispatchMode,
      reason: `both high confidence (${myProposal.confidence.toFixed(2)}, ${otherProposal.confidence.toFixed(2)}), overlap ${overlap.toFixed(2)}, builds_on_other — synthesis`,
    };
  }

  // Rule 4: Both high confidence + overlapping angles → SOLO (avoid duplication)
  if (bothHigh && overlap >= ANGLE_OVERLAP_THRESHOLD) {
    return {
      ...base,
      mode: "solo" as DispatchMode,
      reason: `both confident but overlapping (${overlap.toFixed(2)}) — solo: ${winner}`,
    };
  }

  // Rule 5: Both low confidence → SOLO
  if (bothLow) {
    return {
      ...base,
      mode: "solo" as DispatchMode,
      reason: `both low confidence (${myProposal.confidence.toFixed(2)}, ${otherProposal.confidence.toFixed(2)}) — solo: ${winner}`,
    };
  }

  // Rule 6: Default → SOLO
  return {
    ...base,
    mode: "solo" as DispatchMode,
    reason: `default — solo: ${winner}`,
  };
}

/**
 * Keyword Jaccard similarity between two micro-proposals.
 * v3.5: Used by coordinationFilter for routing decisions (PARALLEL vs SOLO vs SYNTHESIS).
 */
function angleSimilarity(a: MicroProposal, b: MicroProposal): number {
  const extractKeywords = (p: MicroProposal): Set<string> => {
    const words = `${p.angle} ${p.covers.join(" ")}`
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    return new Set(words);
  };

  const aWords = extractKeywords(a);
  const bWords = extractKeywords(b);
  if (aWords.size === 0 && bWords.size === 0) return 1;
  if (aWords.size === 0 || bWords.size === 0) return 0;

  const intersection = [...aWords].filter((w) => bWords.has(w)).length;
  const union = new Set([...aWords, ...bWords]).size;
  return union > 0 ? intersection / union : 0;
}

// ============================================================================
// Factory
// ============================================================================

export function createCoordinationHandler(opts: CoordinationHandlerOpts): CoordinationHandler {
  const { botName, postToCoordination, log } = opts;

  // --- Per-round state ---
  interface MicroRound {
    roundId: string;
    triggerContent: string;
    triggerMessageId: string | null;
    sourceChatId: string | null;
    myProposal: MicroProposal | null;
    otherProposal: MicroProposal | null;
    otherName: string | null;
    coordHistory: string;
    recentResponses: string;
    timeoutId: ReturnType<typeof setTimeout>;
    resolved: boolean;
  }

  const rounds = new Map<string, MicroRound>();

  // --- Deduplication ---
  const seenMessageIds = new Set<string>();

  function isDuplicate(messageId: string): boolean {
    if (!messageId) {
      log.warn("Message with empty ID — treating as duplicate to be safe");
      return true;
    }
    if (seenMessageIds.has(messageId)) return true;
    seenMessageIds.add(messageId);
    setTimeout(() => seenMessageIds.delete(messageId), SEEN_TTL_MS);
    return false;
  }

  // --- Active round check (suppresses Layer 2 during coordination) ---
  function hasActiveRound(): boolean {
    for (const round of rounds.values()) {
      if (!round.resolved) return true;
    }
    return false;
  }

  // --- Write-side dedup: tracks stimuli we've already responded to ---
  const RESPONDED_TTL_MS = 600_000; // 10 min
  const respondedTo = new Set<string>();

  function alreadyRespondedTo(speaker: string, content: string): boolean {
    const key = `${speaker}:${content.slice(0, 120)}`;
    if (respondedTo.has(key)) return true;
    respondedTo.add(key);
    setTimeout(() => respondedTo.delete(key), RESPONDED_TTL_MS);
    return false;
  }

  // --- Layer 2 concurrency guard ---
  const MAX_LAYER2_INFLIGHT = 2;
  let layer2Inflight = 0;

  async function callGatewayGuarded(prompt: string, timeoutMs: number): Promise<string | null> {
    if (layer2Inflight >= MAX_LAYER2_INFLIGHT) {
      log.warn(`Layer 2 call dropped — ${layer2Inflight} already in flight`);
      return null;
    }
    layer2Inflight++;
    try {
      return await opts.callGateway(prompt, timeoutMs);
    } finally {
      layer2Inflight--;
    }
  }

  // --- Response validation ---
  const ERROR_PATTERNS = [
    /^_?\[.*error.*\]_?$/i,
    /^_?\[.*timeout.*\]_?$/i,
    /^_?\[.*failed.*\]_?$/i,
    /no response/i,
    /^[\s\n]*$/,
  ];

  function isValidResponse(response: string | null): response is string {
    if (!response || response.trim().length === 0) return false;
    if (response.trim().length < 3) return false;
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.test(response.trim())) return false;
    }
    return true;
  }

  // --- Micro-proposal generation ---

  async function generateMicroProposal(
    triggerContent: string,
    coordHistory: string,
    recentResponses: string,
    register: RegisterState | undefined,
  ): Promise<MicroProposal | null> {
    let registerContext = "";
    if (register && register.lastResponder) {
      const anglesFormatted = register.recentAngles
        .map((a) => `${a.agent}: "${a.angle}"`)
        .join(", ");
      registerContext = `\n[Context: Last responder was ${register.lastResponder}. Recent angles: ${anglesFormatted}. Topic: ${register.topic}.]`;
    }

    const historySection = coordHistory ? `\n${coordHistory}` : "";
    const responsesSection = recentResponses ? `\n${recentResponses}` : "";

    const prompt = `You are coordinating with another AI agent on how to respond to a user message.
Assess this message and express what you would say about it.

User message: "${triggerContent.slice(0, 500)}"${registerContext}${historySection}${responsesSection}

Respond with ONLY a JSON object:
{"angle": "<your unique angle/perspective>", "confidence": <0.0-1.0>, "covers": ["<topic1>", "<topic2>"], "solo_sufficient": <true/false>, "builds_on_other": <true/false>}

confidence: How strongly do you feel YOUR perspective adds unique value? 0.0 = nothing to add, 1.0 = essential perspective.
solo_sufficient: Could a single focused response fully address this, or do multiple perspectives genuinely help?
builds_on_other: Would your response be meaningfully better if you could read the other agent's response first? true = you'd build on their arguments.`;

    // Try Haiku first (fast, cheap), fall back to gateway if unavailable
    let content = await opts.callHaiku(prompt);
    if (!content) {
      log.warn("Haiku call returned null — falling back to gateway for micro-proposal");
      content = await opts.callGateway(prompt, 8000);
    }
    if (!content) return null;

    try {
      const match = content.match(/\{[\s\S]*?\}/);
      if (!match) {
        return {
          angle: content.slice(0, 100),
          confidence: 0.5,
          covers: [],
          solo_sufficient: true,
        };
      }
      const parsed = JSON.parse(match[0]);
      return {
        angle: parsed.angle || content.slice(0, 100),
        confidence: typeof parsed.confidence === "number"
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
        covers: Array.isArray(parsed.covers) ? parsed.covers : [],
        solo_sufficient: parsed.solo_sufficient !== false,
        builds_on_other: parsed.builds_on_other === true,
      };
    } catch {
      return {
        angle: content.slice(0, 100),
        confidence: 0.5,
        covers: [],
        solo_sufficient: true,
      };
    }
  }

  // --- Round resolution ---

  async function resolveRound(round: MicroRound): Promise<void> {
    if (round.resolved) return;
    round.resolved = true;
    clearTimeout(round.timeoutId);

    if (!round.myProposal || !round.otherProposal || !round.otherName) {
      log.error(`resolveRound called with incomplete state — dispatching fail-open`);
      if (opts.onDispatchDecision) {
        try {
          await opts.onDispatchDecision({
            roundId: round.roundId,
            triggerMessageId: round.triggerMessageId,
            shouldRespond: true,
            sourceChatId: round.sourceChatId || undefined,
          });
        } catch (e: any) {
          log.error(`Fail-open dispatch failed: ${e.message}`);
        }
      }
      return;
    }

    const result = coordinationFilter(
      round.myProposal,
      round.otherProposal,
      botName,
      round.otherName,
    );

    const iWin = result.winner === botName;
    const similarity = angleSimilarity(round.myProposal, round.otherProposal);

    log.info(
      `RESOLVED: mode=${result.mode}, winner=${result.winner}${result.runnerUp ? `, runnerUp=${result.runnerUp}` : ""}, reason="${result.reason}", angleSimilarity=${similarity.toFixed(2)}`,
    );

    // Post resolved message to #coordination (for logging/history)
    await postToCoordination(
      JSON.stringify({
        protocol: COORDINATION_PROTOCOL_VERSION,
        round_id: round.roundId,
        kind: "resolved",
        mode: result.mode,
        winner: result.winner,
        runner_up: result.runnerUp || null,
        reason: result.reason,
        my_proposal: round.myProposal,
        other_proposal: round.otherProposal,
        source_chat_id: round.sourceChatId || null,
      }),
    );

    if (!opts.onDispatchDecision) return;

    const historySection = round.coordHistory ? `\n${round.coordHistory}` : "";
    const responsesSection = round.recentResponses ? `\n${round.recentResponses}` : "";

    // --- SOLO dispatch ---
    if (result.mode === "solo") {
      if (iWin) {
        const otherAngle = round.otherProposal
          ? `, ${round.otherName}'s angle: "${round.otherProposal.angle}"`
          : "";

        const synthesizeCtx = `[Coordination resolved.${historySection}${responsesSection}\nYour angle: "${round.myProposal.angle}"${otherAngle}. You were selected to respond (${result.reason}).]`;

        try {
          await opts.onDispatchDecision({
            roundId: round.roundId,
            triggerMessageId: round.triggerMessageId,
            shouldRespond: true,
            synthesizeContext: synthesizeCtx,
            proposal: round.myProposal,
            sourceChatId: round.sourceChatId || undefined,
          });
        } catch (e: any) {
          log.error(`Winner dispatch failed: ${e.message}`);
        }
      } else {
        try {
          await opts.onDispatchDecision({
            roundId: round.roundId,
            triggerMessageId: round.triggerMessageId,
            shouldRespond: false,
            cancelPending: true,
          });
        } catch (e: any) {
          log.error(`Loser cancel failed: ${e.message}`);
        }
      }
      return;
    }

    // --- PARALLEL dispatch ---
    if (result.mode === "parallel") {
      const myAngle = round.myProposal.angle;
      const otherAngle = round.otherProposal!.angle;
      const otherCovers = round.otherProposal!.covers.join(", ");

      if (iWin) {
        const synthesizeCtx = `[Coordination resolved: PARALLEL.${historySection}${responsesSection}\nYour angle: "${myAngle}". ${round.otherName}'s angle: "${otherAngle}", covering ${otherCovers}. You were selected as primary. Respond to the user — your perspectives complement each other.]`;

        try {
          await opts.onDispatchDecision({
            roundId: round.roundId,
            triggerMessageId: round.triggerMessageId,
            shouldRespond: true,
            synthesizeContext: synthesizeCtx,
            proposal: round.myProposal,
            sourceChatId: round.sourceChatId || undefined,
          });
        } catch (e: any) {
          log.error(`PARALLEL winner dispatch failed: ${e.message}`);
        }
      } else {
        const synthesizeCtx = `[Coordination resolved: PARALLEL.${historySection}${responsesSection}\nYour angle: "${myAngle}". ${round.otherName}'s angle: "${otherAngle}", covering ${otherCovers}. Both agents responding — focus on your unique angle.]`;

        try {
          await opts.onDispatchDecision({
            roundId: round.roundId,
            triggerMessageId: round.triggerMessageId,
            shouldRespond: true,
            synthesizeContext: synthesizeCtx,
            proposal: round.myProposal,
            sourceChatId: round.sourceChatId || undefined,
          });
        } catch (e: any) {
          log.error(`PARALLEL runner-up dispatch failed: ${e.message}`);
        }
      }
      return;
    }

    // --- SYNTHESIS dispatch ---
    if (result.mode === "synthesis") {
      if (iWin) {
        // Winner dispatches first, normally
        const synthesizeCtx = `[Coordination resolved: SYNTHESIS (you go first).${historySection}${responsesSection}\nYour angle: "${round.myProposal.angle}". ${round.otherName} will build on your response.]`;

        try {
          await opts.onDispatchDecision({
            roundId: round.roundId,
            triggerMessageId: round.triggerMessageId,
            shouldRespond: true,
            synthesizeContext: synthesizeCtx,
            proposal: round.myProposal,
            sourceChatId: round.sourceChatId || undefined,
          });
        } catch (e: any) {
          log.error(`SYNTHESIS winner dispatch failed: ${e.message}`);
        }
      } else {
        // Runner-up: don't respond yet, enter waiting state
        try {
          await opts.onDispatchDecision({
            roundId: round.roundId,
            triggerMessageId: round.triggerMessageId,
            shouldRespond: false,
            proposal: round.myProposal,
            sourceChatId: round.sourceChatId || undefined,
            waitForResponse: {
              roundId: round.roundId,
              winnerName: result.winner,
              myProposal: round.myProposal,
              otherProposal: round.otherProposal!,
            },
          });
        } catch (e: any) {
          log.error(`SYNTHESIS runner-up wait setup failed: ${e.message}`);
        }
      }
      return;
    }
  }

  // --- Round handlers ---

  async function handleTimeout(roundId: string): Promise<void> {
    const round = rounds.get(roundId);
    if (!round || round.resolved) return;

    log.warn(`Round ${roundId} timeout — fail-open dispatch`);
    round.resolved = true;

    if (opts.onDispatchDecision) {
      try {
        await opts.onDispatchDecision({
          roundId,
          triggerMessageId: round.triggerMessageId,
          shouldRespond: true,
          sourceChatId: round.sourceChatId || undefined,
        });
      } catch (e: any) {
        log.error(`Timeout dispatch failed: ${e.message}`);
      }
    }
  }

  async function handleRoundStart(parsed: any): Promise<void> {
    const roundId = parsed.round_id;

    if (rounds.has(roundId)) {
      log.info(`Round ${roundId} already in progress — skipping duplicate round_start`);
      return;
    }

    log.info(`Round ${roundId} started — generating micro-proposal`);

    const timeoutId = setTimeout(() => handleTimeout(roundId), ROUND_TIMEOUT_MS);
    const round: MicroRound = {
      roundId,
      triggerContent: parsed.trigger_content || "",
      triggerMessageId: parsed.trigger_message_id || null,
      sourceChatId: parsed.source_chat_id || null,
      myProposal: null,
      otherProposal: null,
      otherName: null,
      coordHistory: "",
      recentResponses: "",
      timeoutId,
      resolved: false,
    };
    rounds.set(roundId, round);

    // Cleanup timer — garbage collect round state
    setTimeout(() => rounds.delete(roundId), ROUND_CLEANUP_MS);

    // Load coordination history + recent bot responses in parallel
    const historyResults = await Promise.allSettled([
      opts.loadHistory?.(roundId) ?? Promise.resolve(""),
      parsed.source_chat_id
        ? (opts.loadRecentResponses?.(parsed.source_chat_id) ?? Promise.resolve(""))
        : Promise.resolve(""),
    ]);

    const coordHistory = historyResults[0].status === "fulfilled" ? historyResults[0].value : "";
    const recentResponses = historyResults[1].status === "fulfilled" ? historyResults[1].value : "";
    if (historyResults[0].status === "rejected") log.warn(`History load failed: ${historyResults[0].reason}`);
    if (historyResults[1].status === "rejected") log.warn(`Recent responses load failed: ${historyResults[1].reason}`);

    const currentRound = rounds.get(roundId);
    if (!currentRound || currentRound.resolved) return;
    currentRound.coordHistory = coordHistory;
    currentRound.recentResponses = recentResponses;

    if (coordHistory) log.info(`Loaded coordination history (${coordHistory.length} chars)`);
    if (recentResponses) log.info(`Loaded recent responses (${recentResponses.length} chars)`);

    // Read state register for turn-taking context
    const register = parsed.source_chat_id
      ? opts.getRegister?.(parsed.source_chat_id)
      : undefined;

    // Generate micro-proposal
    const proposal = await generateMicroProposal(
      currentRound.triggerContent,
      coordHistory,
      recentResponses,
      register,
    );

    if (!proposal) {
      log.error("Failed to generate micro-proposal — dispatching immediately (fail-open)");
      rounds.delete(roundId);
      clearTimeout(timeoutId);

      if (opts.onDispatchDecision) {
        try {
          await opts.onDispatchDecision({
            roundId,
            triggerMessageId: parsed.trigger_message_id || null,
            shouldRespond: true,
            sourceChatId: parsed.source_chat_id || undefined,
          });
        } catch (e: any) {
          log.error(`Fail-open dispatch failed: ${e.message}`);
        }
      }
      return;
    }

    // Check round is still active (may have been resolved by timeout during proposal gen)
    const activeRound = rounds.get(roundId);
    if (!activeRound || activeRound.resolved) return;
    activeRound.myProposal = proposal;

    // Post micro_propose to #coordination
    await postToCoordination(
      JSON.stringify({
        protocol: COORDINATION_PROTOCOL_VERSION,
        round_id: roundId,
        kind: "micro_propose",
        proposal,
        source_chat_id: activeRound.sourceChatId || null,
      }),
    );
    log.info(
      `MICRO_PROPOSE: angle="${proposal.angle}" confidence=${proposal.confidence.toFixed(2)} covers=[${proposal.covers.join(", ")}]`,
    );

    // If the other bot's micro_propose arrived while we were generating ours, resolve now
    if (activeRound.otherProposal && activeRound.otherName && !activeRound.resolved) {
      log.info(`Processing queued micro_propose from ${activeRound.otherName}`);
      await resolveRound(activeRound);
    }
  }

  async function handleMicroPropose(speaker: string, parsed: any): Promise<void> {
    const roundId = parsed.round_id;
    const round = rounds.get(roundId);

    if (!round || round.resolved) return;

    const otherProposal: MicroProposal = parsed.proposal || {
      angle: "",
      confidence: 0.5,
      covers: [],
      solo_sufficient: true,
    };
    round.otherProposal = otherProposal;
    round.otherName = speaker;
    log.info(
      `${speaker} MICRO_PROPOSE: angle="${otherProposal.angle}" confidence=${otherProposal.confidence.toFixed(2)}`,
    );

    // If our own proposal isn't ready yet, just store theirs
    if (!round.myProposal) {
      log.info(`Queued ${speaker}'s micro_propose — waiting for our own proposal`);
      return;
    }

    // Both proposals ready — resolve
    await resolveRound(round);
  }

  // --- Main message handler ---

  async function handleMessage(msg: ParsedCoordinationMessage): Promise<void> {
    // Dedup
    if (isDuplicate(msg.id)) {
      log.info(`skipped: duplicate id=${msg.id.slice(0, 8)}`);
      return;
    }

    const { speaker, parsed } = msg;

    // --- Layer 1: v2 micro-proposal protocol ---

    // round_start from system → generate micro-proposal
    if (parsed?.intent?.type === "round_start") {
      await handleRoundStart(parsed);
      return;
    }

    // micro_propose from other agent
    if (parsed?.kind === "micro_propose" && parsed?.round_id) {
      await handleMicroPropose(speaker, parsed);
      return;
    }

    // resolved — log only (each bot resolves locally)
    if (parsed?.kind === "resolved" && parsed?.round_id) {
      log.info(`${speaker} resolved round ${parsed.round_id}: ${parsed.reason || ""}`);
      return;
    }

    // --- v1 compatibility: silently skip obsolete message kinds ---
    if (parsed?.kind === "propose" || parsed?.kind === "accept" ||
        parsed?.kind === "counter" || parsed?.kind === "ready") {
      log.info(`Skipping v1 message kind: ${parsed.kind}`);
      return;
    }

    // --- Layer 2: General inter-agent comms (pass-through) ---

    // AgentMessage (question/inform/delegate/status/flag)
    if (
      parsed?.kind &&
      ["question", "inform", "delegate", "status", "flag"].includes(parsed.kind)
    ) {
      if (parsed.to && parsed.to !== botName) {
        return;
      }
      if (hasActiveRound()) {
        log.info(`AgentMessage from ${speaker} deferred — active round in progress`);
        return;
      }

      const prefix = parsed.to === botName ? `[${speaker} to you` : `[${speaker}`;
      const kindLabel =
        parsed.kind === "question" ? "asks" : parsed.kind === "flag" ? "flags" : "says";
      const depth = parsed.depth || 0;

      if (alreadyRespondedTo(speaker, parsed.content || "")) {
        log.info(`AgentMessage from ${speaker} skipped — already responded to this stimulus`);
        return;
      }

      log.info(
        `AgentMessage from ${speaker}: ${parsed.kind} (depth=${depth}) — ${parsed.content?.slice(0, 80)}`,
      );

      const response = await callGatewayGuarded(`${prefix} ${kindLabel}]: ${parsed.content}`, 30000);

      if (
        isValidResponse(response) &&
        parsed.expects_reply !== false &&
        depth < MAX_COORDINATION_DEPTH
      ) {
        await postToCoordination(
          JSON.stringify({
            protocol: COORDINATION_PROTOCOL_VERSION,
            kind: "inform",
            to: speaker,
            topic: parsed.topic || undefined,
            content: response,
            expects_reply: depth + 1 < MAX_COORDINATION_DEPTH - 1,
            depth: depth + 1,
            source_chat_id: parsed.source_chat_id || null,
          }),
        );
        log.info(`Reply posted (depth=${depth + 1}, ${response.length} chars)`);
      } else if (!isValidResponse(response)) {
        log.info("Empty/error gateway response — not posting reply");
      } else {
        log.info(`Response not posted (depth=${depth} >= cap or no reply expected)`);
      }
      return;
    }

    // Resolution signals
    if (parsed?.kind === "resolution") {
      log.info(`${speaker} ${parsed.signal}: ${parsed.summary || ""}`);
      if (!hasActiveRound()) {
        await callGatewayGuarded(
          `[${speaker} signals ${parsed.signal}${parsed.summary ? `: ${parsed.summary}` : ""}]`,
          30000,
        );
      }
      return;
    }

    // Free-form negotiation (legacy kind:"negotiate")
    if (parsed?.kind === "negotiate") {
      if (hasActiveRound()) {
        log.info(`Negotiate from ${speaker} deferred — active round in progress`);
        return;
      }

      const depth = parsed.depth || 0;

      if (alreadyRespondedTo(speaker, parsed.content || "")) {
        log.info(`Negotiate from ${speaker} skipped — already responded to this stimulus`);
        return;
      }

      log.info(`${speaker} negotiating (depth=${depth}): ${parsed.content?.slice(0, 80)}`);

      const response = await callGatewayGuarded(
        `[Coordination — ${speaker}]: ${parsed.content}`,
        30000,
      );

      if (isValidResponse(response) && depth < MAX_COORDINATION_DEPTH) {
        await postToCoordination(
          JSON.stringify({
            protocol: COORDINATION_PROTOCOL_VERSION,
            kind: "negotiate",
            content: response,
            to: speaker,
            depth: depth + 1,
            source_chat_id: parsed.source_chat_id || null,
          }),
        );
        log.info(`Negotiate reply posted (depth=${depth + 1}, ${response.length} chars)`);
      } else if (!isValidResponse(response)) {
        log.info("Empty/error gateway response — not posting negotiate reply");
      }
      return;
    }

    // Any other structured protocol message → forward as context
    if (parsed && (parsed.protocol === COORDINATION_PROTOCOL_VERSION || parsed.protocol === "dyad-coord-v1")) {
      if (!hasActiveRound()) {
        await callGatewayGuarded(
          `[Coordination from ${speaker}]: ${JSON.stringify(parsed).slice(0, 300)}`,
          30000,
        );
      }
      return;
    }

    // Unparseable free-form message
    if (!parsed) {
      if (!hasActiveRound()) {
        await callGatewayGuarded(`[Coordination from ${speaker}]: ${msg.content}`, 30000);
      }
      return;
    }

    // Catch-all
    log.info(`UNMATCHED: kind=${parsed?.kind} — message fell through all handlers`);
  }

  // --- Cleanup ---

  function cleanup(): void {
    for (const round of rounds.values()) {
      clearTimeout(round.timeoutId);
    }
    rounds.clear();
    seenMessageIds.clear();
    respondedTo.clear();
  }

  return {
    handleMessage,
    hasActiveRound,
    cleanup,
  };
}
