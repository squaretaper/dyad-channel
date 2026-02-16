/**
 * Coordination protocol handler for the Dyad channel plugin.
 *
 * Ported from lib/coordination/sidecar.ts — same negotiation logic,
 * but injectable (no Supabase, no process globals). Receives messages
 * from the bus, delegates gateway calls via injected functions.
 *
 * Layer 1: Structured negotiation (PROPOSE -> ACCEPT/COUNTER -> READY)
 *   - Proposals are structured: { angle, covers[], defers[] }
 *   - Mechanical diff: if covers don't overlap, ACCEPT immediately (no LLM call)
 *   - COUNTER only fires on actual overlap in covers fields
 *   - READY includes both proposals so agents know the full division of labor
 *
 * Layer 2: General inter-agent comms (bidirectional pass-through)
 *   - AgentMessage, resolution signals, free-form dialogue all handled
 *   - Suppressed during active coordination rounds to avoid gateway saturation
 */

import {
  COORDINATION_PROTOCOL_VERSION,
  MAX_COORDINATION_DEPTH,
  type Proposal,
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
}

export interface CoordinationHandlerOpts {
  botName: string;
  callGateway: (prompt: string, timeoutMs: number) => Promise<string | null>;
  postToCoordination: (content: string) => Promise<void>;
  onDispatchDecision?: (decision: DispatchDecision) => Promise<void>;
  /** Load previous round outcomes for prompt injection. Returns formatted string or empty. */
  loadHistory?: (excludeRoundId: string) => Promise<string>;
  /** Load recent bot responses from the main chat for cross-agent awareness. */
  loadRecentResponses?: (sourceChatId: string) => Promise<string>;
  log: {
    info(m: string): void;
    warn(m: string): void;
    error(m: string): void;
  };
}

// ============================================================================
// Constants
// ============================================================================

const ROUND_TIMEOUT_MS = 12000;
const ROUND_CLEANUP_MS = 30000;
const SEEN_TTL_MS = 720_000; // 12 min — must exceed staleness watchdog (10 min) to survive reconnection replays

// ============================================================================
// Factory
// ============================================================================

export function createCoordinationHandler(opts: CoordinationHandlerOpts): CoordinationHandler {
  const { botName, callGateway, postToCoordination, log } = opts;

  // --- Per-round negotiation state ---
  interface RoundState {
    phase: "proposed" | "locked";
    myProposal: Proposal;
    otherProposal?: Proposal;
    otherName?: string;
    triggerContent: string;
    triggerMessageId: string | null;
    sourceChatId: string | null;
    roundId: string;
    timeoutId: ReturnType<typeof setTimeout>;
    coordHistory: string;       // previous round context (loaded once per round)
    recentResponses: string;    // what other bots recently said in the main chat
    myFinalIntent?: FinalIntent;      // stored after lockRound generates intent
    otherFinalIntent?: FinalIntent;   // stored when other bot's READY is received
  }

  const rounds = new Map<string, RoundState>();

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

  // --- Active round check (suppresses Layer 2 during negotiation) ---
  function hasActiveRound(): boolean {
    for (const round of rounds.values()) {
      if (round.phase !== "locked") return true;
    }
    return false;
  }

  // --- Write-side dedup: tracks stimuli we've already responded to ---
  // Keyed on stimulus content (speaker + content hash), not response content
  // (which varies per LLM call). Prevents replayed messages from triggering
  // duplicate responses after reconnection.
  const RESPONDED_TTL_MS = 600_000; // 10 min
  const respondedTo = new Set<string>();

  function alreadyRespondedTo(speaker: string, content: string): boolean {
    const key = `${speaker}:${content.slice(0, 120)}`;
    if (respondedTo.has(key)) return true;
    respondedTo.add(key);
    setTimeout(() => respondedTo.delete(key), RESPONDED_TTL_MS);
    return false;
  }

  // --- Layer 2 concurrency guard (prevents gateway saturation) ---
  const MAX_LAYER2_INFLIGHT = 2;
  let layer2Inflight = 0;

  /** Guarded gateway call for Layer 2 — returns null if at capacity or on error. */
  async function callGatewayGuarded(prompt: string, timeoutMs: number): Promise<string | null> {
    if (layer2Inflight >= MAX_LAYER2_INFLIGHT) {
      log.warn(`Layer 2 call dropped — ${layer2Inflight} already in flight`);
      return null;
    }
    layer2Inflight++;
    try {
      return await callGateway(prompt, timeoutMs);
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

  // --- Mechanical proposal diffing ---
  function coversOverlap(myCovers: string[], theirCovers: string[]): string[] {
    const normalize = (s: string) =>
      new Set(
        s
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 1),
      );
    const overlapping: string[] = [];

    for (const mine of myCovers) {
      const myWords = normalize(mine);
      for (const theirs of theirCovers) {
        const theirWords = normalize(theirs);
        const common = [...myWords].filter((w) => theirWords.has(w));
        if (common.length > 0 && common.length / Math.min(myWords.size, theirWords.size) >= 0.5) {
          overlapping.push(`"${mine}" <-> "${theirs}"`);
        }
      }
    }

    return overlapping;
  }

  // --- Gateway prompt helpers ---

  async function generateProposal(roundStart: any, coordHistory: string, recentResponses: string): Promise<Proposal | null> {
    const historySection = coordHistory ? `\n${coordHistory}\n` : "";
    const responsesSection = recentResponses ? `\n${recentResponses}\n` : "";

    const prompt = `[COORDINATION — assess and propose. Respond with JSON only, no other text]
Message from user: "${(roundStart.trigger_content || "").slice(0, 500)}"
${historySection}${responsesSection}
First assess: does this message benefit from multiple agent perspectives, or would a single focused response be better?

Respond with a structured proposal:
{"angle": "<your angle>", "covers": ["<topic 1>", ...], "defers": ["<topics for other agent>"], "solo_sufficient": <true if one good response would fully address this>}

If solo_sufficient is true, still propose your angle — but be prepared to defer if the other agent's angle is stronger.`;

    const content = await callGateway(prompt, 15000);
    if (!content) return null;

    try {
      const match = content.match(/\{[\s\S]*?\}/);
      if (!match) return { angle: content.slice(0, 100), covers: [], defers: [] };
      const parsed = JSON.parse(match[0]);
      return {
        angle: parsed.angle || content.slice(0, 100),
        covers: Array.isArray(parsed.covers) ? parsed.covers : [],
        defers: Array.isArray(parsed.defers) ? parsed.defers : [],
        solo_sufficient: parsed.solo_sufficient === true,
      };
    } catch {
      return { angle: content.slice(0, 100), covers: [], defers: [] };
    }
  }

  async function generateCounterOrAccept(
    round: RoundState,
    otherName: string,
    otherProposal: Proposal,
    overlap: string[],
  ): Promise<{ accept: boolean; revisedProposal?: Proposal }> {
    const prompt = `[COORDINATION — resolve overlap. Respond with JSON only, no other text]
Message: "${round.triggerContent.slice(0, 300)}"
Your proposal: angle="${round.myProposal.angle}", covers=[${round.myProposal.covers.join(", ")}]
${otherName}'s proposal: angle="${otherProposal.angle}", covers=[${otherProposal.covers.join(", ")}]
Overlapping areas: ${overlap.join(", ")}

Either accept as-is or revise your covers to avoid overlap:
- {"decision": "accept"} — overlap is minor, proceed as-is
- {"decision": "counter", "angle": "<revised>", "covers": ["<non-overlapping topics>"], "defers": ["<what you leave>"]}`;

    const content = await callGateway(prompt, 8000);
    if (!content) return { accept: true };

    try {
      const match = content.match(/\{[\s\S]*?\}/);
      if (!match) return { accept: true };
      const parsed = JSON.parse(match[0]);
      if (parsed.decision === "counter" && parsed.angle) {
        return {
          accept: false,
          revisedProposal: {
            angle: parsed.angle,
            covers: Array.isArray(parsed.covers) ? parsed.covers : round.myProposal.covers,
            defers: Array.isArray(parsed.defers) ? parsed.defers : round.myProposal.defers,
          },
        };
      }
      return { accept: true };
    } catch {
      return { accept: true };
    }
  }

  interface FinalIntent {
    type: "claim" | "synthesize" | "defer" | "abstain";
    scope?: string;
    with?: string;
    to?: string;
    reason?: string;
    topic?: string;
  }

  async function generateFinalIntent(round: RoundState): Promise<FinalIntent> {
    const otherContext =
      round.otherName && round.otherProposal
        ? `\n${round.otherName}'s angle: "${round.otherProposal.angle}", covers: [${round.otherProposal.covers.join(", ")}]`
        : "";

    const bothSoloSufficient =
      round.myProposal.solo_sufficient &&
      round.otherProposal?.solo_sufficient;
    const soloNote = bothSoloSufficient
      ? "\nBoth agents assessed that a single response would suffice."
      : "";

    const historySection = round.coordHistory ? `\n${round.coordHistory}\n` : "";
    const responsesSection = round.recentResponses ? `\n${round.recentResponses}\n` : "";

    const prompt = `[COORDINATION — choose your final intent. Respond with JSON only, no other text]
User message: "${round.triggerContent.slice(0, 300)}"
${historySection}${responsesSection}Your angle: "${round.myProposal.angle}", covers: [${round.myProposal.covers.join(", ")}]${otherContext}
${soloNote}

- CLAIM: you respond from your angle
- DEFER: the other agent's angle covers this well enough alone
- SYNTHESIZE: both angles needed, weave together
- ABSTAIN: not well-suited to contribute

Choose ONE:
- {"type":"claim","scope":"..."}
- {"type":"defer","to":"${round.otherName || "other"}","reason":"..."}
- {"type":"synthesize","with":"${round.otherName || "other"}","topic":"..."}
- {"type":"abstain","reason":"..."}`;

    const content = await callGateway(prompt, 8000);
    if (!content) return { type: "claim", scope: round.myProposal.angle };

    try {
      const match = content.match(/\{[\s\S]*?\}/);
      if (!match) return { type: "claim", scope: round.myProposal.angle };
      const parsed = JSON.parse(match[0]);
      if (["claim", "defer", "synthesize", "abstain"].includes(parsed.type)) {
        return parsed;
      }
      return { type: "claim", scope: round.myProposal.angle };
    } catch {
      return { type: "claim", scope: round.myProposal.angle };
    }
  }

  // --- Negotiation handlers ---

  async function lockRound(round: RoundState): Promise<void> {
    if (round.phase === "locked") return;
    round.phase = "locked";
    clearTimeout(round.timeoutId);

    const intent: FinalIntent = await generateFinalIntent(round);
    round.myFinalIntent = intent;

    const summary = round.otherName
      ? `${botName}: ${round.myProposal.angle} (${round.myProposal.covers.join(", ")}), ${round.otherName}: ${round.otherProposal?.angle || "unspecified"} (${round.otherProposal?.covers.join(", ") || ""})`
      : `${round.myProposal.angle} (${round.myProposal.covers.join(", ")})`;

    await postToCoordination(
      JSON.stringify({
        protocol: COORDINATION_PROTOCOL_VERSION,
        round_id: round.roundId,
        kind: "ready",
        intent: intent || { type: "claim", scope: round.myProposal.angle },
        my_proposal: round.myProposal,
        other_proposal: round.otherProposal || undefined,
        summary,
        source_chat_id: round.sourceChatId || null,
      }),
    );
    log.info(`READY (LOCKED): intent=${intent?.type || "claim"}, summary="${summary}"`);

    // Signal dispatch decision — plugin uses this to dispatch or suppress
    const finalIntent: FinalIntent = intent || { type: "claim", scope: round.myProposal.angle };
    let shouldRespond = finalIntent.type === "claim" || finalIntent.type === "synthesize";
    let cancelPending = false;

    // Both-defer detection: if we're deferring and already know the other bot's intent
    // (their READY arrived before we locked — e.g. we locked via handleReady), check
    // for both-defer scenario and use alphabetical tiebreaker.
    if (!shouldRespond && round.otherFinalIntent) {
      const otherDeferred = round.otherFinalIntent.type === "defer" || round.otherFinalIntent.type === "abstain";
      if (otherDeferred) {
        if (botName < (round.otherName || "")) {
          log.warn(`Both deferred (lockRound) — ${botName} wins tiebreaker, overriding to CLAIM`);
          shouldRespond = true;
        } else {
          log.info(`Both deferred (lockRound) — ${round.otherName} wins tiebreaker, confirming defer`);
          cancelPending = true;
        }
      }
    }

    if (opts.onDispatchDecision) {
      const historySection = round.coordHistory ? `\n${round.coordHistory}` : "";
      const responsesSection = round.recentResponses ? `\n${round.recentResponses}` : "";
      const synthesizeCtx = shouldRespond
        ? `[Coordination round completed.${historySection}${responsesSection}\nYour angle: "${round.myProposal.angle}"${
            round.otherName
              ? `, ${round.otherName}'s angle: "${round.otherProposal?.angle || "unspecified"}"`
              : ""
          }. Division: ${summary}]`
        : undefined;

      try {
        await opts.onDispatchDecision({
          roundId: round.roundId,
          triggerMessageId: round.triggerMessageId,
          shouldRespond,
          synthesizeContext: synthesizeCtx,
          cancelPending,
        });
      } catch (e: any) {
        log.error(`onDispatchDecision failed: ${e.message}`);
      }
    }
  }

  async function handleTimeout(roundId: string): Promise<void> {
    const round = rounds.get(roundId);
    if (!round || round.phase === "locked") return;

    log.warn(`Round ${roundId} timeout — auto-READY`);
    await lockRound(round);
  }

  async function handleRoundStart(parsed: any): Promise<void> {
    const roundId = parsed.round_id;

    // Dedup: skip if we're already handling this round (covers Realtime re-delivery
    // with different notification IDs but same round_id)
    if (rounds.has(roundId)) {
      log.info(`Round ${roundId} already in progress — skipping duplicate round_start`);
      return;
    }

    log.info(`Round ${roundId} started — generating PROPOSE`);

    // Create round state BEFORE gateway call so incoming PROPOSEs aren't dropped
    const placeholder: Proposal = { angle: "", covers: [], defers: [] };
    const timeoutId = setTimeout(() => handleTimeout(roundId), ROUND_TIMEOUT_MS);
    rounds.set(roundId, {
      phase: "proposed",
      myProposal: placeholder,
      triggerContent: parsed.trigger_content || "",
      triggerMessageId: parsed.trigger_message_id || null,
      sourceChatId: parsed.source_chat_id || null,
      roundId,
      timeoutId,
      coordHistory: "",
      recentResponses: "",
    });

    // Load coordination history + recent bot responses in parallel.
    // Promise.allSettled: partial failures don't block the round.
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

    // Store in round state for use in later prompts (generateFinalIntent, synthesizeContext)
    const currentRound = rounds.get(roundId);
    if (currentRound) {
      currentRound.coordHistory = coordHistory;
      currentRound.recentResponses = recentResponses;
    }

    if (coordHistory) log.info(`Loaded coordination history (${coordHistory.length} chars)`);
    if (recentResponses) log.info(`Loaded recent responses (${recentResponses.length} chars)`);

    const proposal = await generateProposal(parsed, coordHistory, recentResponses);
    if (!proposal) {
      log.error("Failed to generate proposal — dispatching immediately (fail-open)");
      rounds.delete(roundId);
      clearTimeout(timeoutId);

      // Fail-open: dispatch immediately when proposal generation fails.
      // Without this, pendingDispatches would sit for 30s until the timeout fires.
      if (opts.onDispatchDecision) {
        try {
          await opts.onDispatchDecision({
            roundId,
            triggerMessageId: parsed.trigger_message_id || null,
            shouldRespond: true,
          });
        } catch (e: any) {
          log.error(`Fail-open dispatch failed: ${e.message}`);
        }
      }
      return;
    }

    // Cleanup timer starts AFTER proposal generation so slow proposals
    // don't race with the 30s window
    setTimeout(() => rounds.delete(roundId), ROUND_CLEANUP_MS);

    // Update round state with actual proposal
    const round = rounds.get(roundId);
    if (round) {
      round.myProposal = proposal;
    }

    // Post structured PROPOSE
    await postToCoordination(
      JSON.stringify({
        protocol: COORDINATION_PROTOCOL_VERSION,
        round_id: roundId,
        kind: "propose",
        proposal,
        source_chat_id: round?.sourceChatId || null,
      }),
    );
    log.info(
      `PROPOSE: angle="${proposal.angle}" covers=[${proposal.covers.join(", ")}] defers=[${proposal.defers.join(", ")}]`,
    );

    // If the other agent's PROPOSE arrived while we were generating ours, process it now
    if (round && round.otherProposal && round.phase === "proposed") {
      log.info(
        `Processing queued PROPOSE from ${round.otherName} (arrived during our gateway call)`,
      );
      await handlePropose(round.otherName!, {
        round_id: roundId,
        proposal: round.otherProposal,
      });
    }
  }

  async function handlePropose(speaker: string, parsed: any): Promise<void> {
    const roundId = parsed.round_id;
    const round = rounds.get(roundId);

    if (!round || round.phase === "locked") return;

    const otherProposal: Proposal = parsed.proposal || {
      angle: parsed.scope || "",
      covers: [],
      defers: [],
    };
    round.otherProposal = otherProposal;
    round.otherName = speaker;
    log.info(
      `${speaker} PROPOSE: angle="${otherProposal.angle}" covers=[${otherProposal.covers.join(", ")}]`,
    );

    // If our own proposal isn't ready yet (placeholder), just store theirs
    if (!round.myProposal.angle) {
      log.info(`Queued ${speaker}'s PROPOSE — waiting for our own proposal to finish generating`);
      return;
    }

    // Mechanical diff: check covers overlap
    const overlap = coversOverlap(round.myProposal.covers, otherProposal.covers);

    if (overlap.length === 0) {
      // No overlap — ACCEPT immediately, no LLM call needed
      await postToCoordination(
        JSON.stringify({
          protocol: COORDINATION_PROTOCOL_VERSION,
          round_id: roundId,
          kind: "accept",
          source_chat_id: round.sourceChatId || null,
        }),
      );
      log.info("ACCEPT — no covers overlap (mechanical diff)");
      await lockRound(round);
    } else {
      // Overlap detected — call gateway to resolve
      log.info(`Overlap detected: ${overlap.join(", ")} — calling gateway for resolution`);
      const decision = await generateCounterOrAccept(round, speaker, otherProposal, overlap);

      if (decision.accept) {
        await postToCoordination(
          JSON.stringify({
            protocol: COORDINATION_PROTOCOL_VERSION,
            round_id: roundId,
            kind: "accept",
            source_chat_id: round.sourceChatId || null,
          }),
        );
        log.info("ACCEPT — gateway resolved overlap");
        await lockRound(round);
      } else if (decision.revisedProposal) {
        round.myProposal = decision.revisedProposal;
        await postToCoordination(
          JSON.stringify({
            protocol: COORDINATION_PROTOCOL_VERSION,
            round_id: roundId,
            kind: "counter",
            proposal: decision.revisedProposal,
            source_chat_id: round.sourceChatId || null,
          }),
        );
        log.info(
          `COUNTER: angle="${decision.revisedProposal.angle}" covers=[${decision.revisedProposal.covers.join(", ")}]`,
        );
      }
    }
  }

  async function handleAccept(speaker: string, parsed: any): Promise<void> {
    const roundId = parsed.round_id;
    const round = rounds.get(roundId);

    if (!round || round.phase === "locked") return;

    log.info(`${speaker} ACCEPT`);
    await lockRound(round);
  }

  async function handleCounter(speaker: string, parsed: any): Promise<void> {
    const roundId = parsed.round_id;
    const round = rounds.get(roundId);

    if (!round || round.phase === "locked") return;

    const otherProposal: Proposal = parsed.proposal || {
      angle: parsed.scope || "",
      covers: [],
      defers: [],
    };
    round.otherProposal = otherProposal;
    round.otherName = speaker;
    log.info(
      `${speaker} COUNTER: angle="${otherProposal.angle}" covers=[${otherProposal.covers.join(", ")}]`,
    );

    // Accept the counter (max one counter round to stay within time budget)
    await postToCoordination(
      JSON.stringify({
        protocol: COORDINATION_PROTOCOL_VERSION,
        round_id: roundId,
        kind: "accept",
        source_chat_id: round.sourceChatId || null,
      }),
    );
    log.info("ACCEPT counter — locking");
    await lockRound(round);
  }

  async function handleReady(speaker: string, parsed: any): Promise<void> {
    const roundId = parsed.round_id;
    const round = rounds.get(roundId);

    if (!round) return;

    log.info(`${speaker} READY: ${parsed.summary || ""}`);

    // Store other bot's final intent for both-defer detection
    if (parsed.intent) {
      round.otherFinalIntent = parsed.intent;
    }

    if (round.phase !== "locked") {
      await lockRound(round);
    } else {
      // Already locked — check for both-defer or we-deferred-they-claimed scenarios.
      // This branch fires for the bot that locked first (via timeout or ACCEPT)
      // and then receives the other bot's READY afterward.
      const myDeferred = round.myFinalIntent &&
        (round.myFinalIntent.type === "defer" || round.myFinalIntent.type === "abstain");

      if (myDeferred && parsed.intent && opts.onDispatchDecision) {
        const otherDeferred = parsed.intent.type === "defer" || parsed.intent.type === "abstain";

        if (otherDeferred) {
          // Both deferred — tiebreaker: alphabetically first bot claims
          if (botName < speaker) {
            log.warn(`Both deferred (handleReady) — ${botName} wins tiebreaker, dispatching`);
            const historySection = round.coordHistory ? `\n${round.coordHistory}` : "";
            const responsesSection = round.recentResponses ? `\n${round.recentResponses}` : "";
            try {
              await opts.onDispatchDecision({
                roundId: round.roundId,
                triggerMessageId: round.triggerMessageId,
                shouldRespond: true,
                synthesizeContext: `[Both agents initially deferred. Responding as fallback.${historySection}${responsesSection}\nMessage: "${round.triggerContent.slice(0, 300)}"]`,
              });
            } catch (e: any) {
              log.error(`Both-defer tiebreaker dispatch failed: ${e.message}`);
            }
          } else {
            log.info(`Both deferred (handleReady) — ${speaker} wins tiebreaker, confirming our defer`);
            try {
              await opts.onDispatchDecision({
                roundId: round.roundId,
                triggerMessageId: round.triggerMessageId,
                shouldRespond: false,
                cancelPending: true,
              });
            } catch (e: any) {
              log.error(`Defer confirmation failed: ${e.message}`);
            }
          }
        } else {
          // We deferred, they claimed — confirm our defer (they'll handle it)
          log.info(`${speaker} claimed — confirming our defer`);
          try {
            await opts.onDispatchDecision({
              roundId: round.roundId,
              triggerMessageId: round.triggerMessageId,
              shouldRespond: false,
              cancelPending: true,
            });
          } catch (e: any) {
            log.error(`Defer confirmation failed: ${e.message}`);
          }
        }
      }
    }
  }

  // --- Main message handler ---

  async function handleMessage(msg: ParsedCoordinationMessage): Promise<void> {
    // Dedup
    if (isDuplicate(msg.id)) {
      log.info(`skipped: duplicate id=${msg.id.slice(0, 8)}`);
      return;
    }

    const { speaker, parsed } = msg;

    // --- Layer 1: Structured negotiation ---

    // OPEN: round_start from system -> generate PROPOSE
    if (parsed?.intent?.type === "round_start") {
      await handleRoundStart(parsed);
      return;
    }

    // PROPOSE from other agent
    if (parsed?.kind === "propose" && parsed?.round_id) {
      await handlePropose(speaker, parsed);
      return;
    }

    // ACCEPT from other agent
    if (parsed?.kind === "accept" && parsed?.round_id) {
      await handleAccept(speaker, parsed);
      return;
    }

    // COUNTER from other agent
    if (parsed?.kind === "counter" && parsed?.round_id) {
      await handleCounter(speaker, parsed);
      return;
    }

    // READY from other agent
    if (parsed?.kind === "ready" && parsed?.round_id) {
      await handleReady(speaker, parsed);
      return;
    }

    // --- Layer 2: General inter-agent comms (pass-through) ---

    // AgentMessage (question/inform/delegate/status/flag)
    if (
      parsed?.kind &&
      ["question", "inform", "delegate", "status", "flag"].includes(parsed.kind)
    ) {
      // Only process messages directed at us or broadcast (no "to" field)
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

      // Write-side dedup: skip if we've already responded to this stimulus
      if (alreadyRespondedTo(speaker, parsed.content || "")) {
        log.info(`AgentMessage from ${speaker} skipped — already responded to this stimulus`);
        return;
      }

      log.info(
        `AgentMessage from ${speaker}: ${parsed.kind} (depth=${depth}) — ${parsed.content?.slice(0, 80)}`,
      );

      const response = await callGatewayGuarded(`${prefix} ${kindLabel}]: ${parsed.content}`, 30000);

      // Post reply back to #coordination if expects_reply and under depth cap
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

    // Resolution signals (context injection — response discarded intentionally)
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

    // Any other structured protocol message -> forward as context (skip during active rounds)
    if (parsed && parsed.protocol === COORDINATION_PROTOCOL_VERSION) {
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
