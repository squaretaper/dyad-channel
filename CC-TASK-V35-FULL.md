# CC Task: Upgrade v2.0 SOLO-only → v3.5 Full (SOLO + PARALLEL + SYNTHESIS)

## Context

v2.0 (`767de08`) implements SOLO-only coordination: Haiku micro-proposals + deterministic filter → one agent responds. Now we need the other two dispatch modes.

**Planning doc:** `~/clawd/projects/dyad/coordination-protocol-planning-v2-synthesized.md` — read sections "Synthesis Pathway (v2.0): Proposal-Informed Parallel" and "Deep Synthesis Mode (v2.5): Sequential Build-On" for the full spec.

## What exists (v2.0 — don't break these)

- `coordinationFilter()` in `coordination.ts` — pure logic, always returns `mode: "solo"` with a winner
- `MicroProposal` in `types-coordination.ts` — has `angle`, `confidence`, `covers`, `solo_sufficient`
- `DispatchMode` type — currently `"solo"` only
- `FilterResult` — has `mode`, `winner`, `reason`, `proposals`
- `resolveRound()` — handles SOLO dispatch (winner responds, loser cancels)
- `onDispatchDecision` callback in `channel.ts` — dispatches winner's response with `synthesizeContext`
- `angleSimilarity()` — keyword Jaccard, already exists
- State register (`RegisterState`) — in-memory per-chat, injected into Haiku prompt
- `callHaiku()` and `callGateway()` — both available
- Layer 2 (AgentMessage, negotiate, resolution) — MUST remain untouched

## Changes needed

### 1. types-coordination.ts

```typescript
// Expand DispatchMode
export type DispatchMode = "solo" | "parallel" | "synthesis";

// Add to MicroProposal
export interface MicroProposal {
  angle: string;
  confidence: number;
  covers: string[];
  solo_sufficient: boolean;
  builds_on_other?: boolean;  // NEW: opt-in signal for synthesis mode
}

// Expand FilterResult
export interface FilterResult {
  mode: DispatchMode;          // now "solo" | "parallel" | "synthesis"
  winner: string;              // primary responder (all modes)
  runnerUp?: string;           // NEW: second responder (parallel/synthesis)
  reason: string;
  proposals: Record<string, MicroProposal>;
}

// Add filter threshold constants
export const CONFIDENCE_GAP_THRESHOLD = 0.3;
export const ANGLE_OVERLAP_THRESHOLD = 0.5;
export const HIGH_CONFIDENCE_THRESHOLD = 0.5;
export const LOW_CONFIDENCE_THRESHOLD = 0.3;
export const SYNTHESIS_CONFIDENCE_THRESHOLD = 0.7;
```

### 2. coordination.ts — Upgrade `coordinationFilter()`

Replace the current SOLO-only filter with the full routing logic from the planning doc:

```
if confidence_gap > 0.3:
    SOLO → higher confidence wins

elif both.confidence > 0.5 and angle_overlap < 0.5:
    PARALLEL → both respond (different angles, genuine complement)

elif both.confidence > 0.7 and angle_overlap >= 0.5 and (either builds_on_other):
    SYNTHESIS → sequential build-on (same angle, complex, opt-in)

elif both.confidence > 0.5 and angle_overlap >= 0.5:
    SOLO → higher confidence (overlapping angles, avoid duplication)

elif both.confidence < 0.3:
    SOLO → higher confidence (neither has strong conviction)

else:
    SOLO → higher confidence (default)
```

`winner` = higher confidence (or lexicographic tiebreaker). `runnerUp` = the other bot.

### 3. coordination.ts — Upgrade `resolveRound()`

Currently only handles SOLO. Needs three paths:

**SOLO (existing):** Winner dispatches, loser cancels. No change needed.

**PARALLEL (new):** BOTH agents dispatch. Each gets the other's micro-proposal injected as context:
```
synthesizeContext for winner: "[Coordination resolved: PARALLEL. Your angle: {myAngle}. {otherName}'s angle: {otherAngle}, covering {otherCovers}. You were selected as primary. Respond to the user — your perspectives complement each other.]"

synthesizeContext for runner-up: "[Coordination resolved: PARALLEL. Your angle: {myAngle}. {otherName}'s angle: {otherAngle}, covering {otherCovers}. Both agents responding — focus on your unique angle.]"
```
Both get `shouldRespond: true`. No `cancelPending` for either.

**SYNTHESIS (new):** Sequential build-on. Winner dispatches FIRST. Runner-up waits for winner's response, then dispatches with winner's response injected.

This requires a new field on `DispatchDecision`:
```typescript
export interface DispatchDecision {
  // ... existing fields ...
  waitForResponse?: {           // NEW: synthesis mode — runner-up waits
    roundId: string;
    winnerName: string;
    myProposal: MicroProposal;
    otherProposal: MicroProposal;
  };
}
```

For the winner: dispatch normally with `shouldRespond: true`.
For the runner-up: dispatch with `shouldRespond: false` initially + `waitForResponse` set. The runner-up does NOT cancel — it enters a waiting state.

### 4. channel.ts — Handle PARALLEL and SYNTHESIS dispatch

**PARALLEL:** When `onDispatchDecision` receives TWO `shouldRespond: true` decisions (one for each bot), both dispatch. The existing `dispatched` set prevents double-dispatch per messageId, but in PARALLEL mode both bots legitimately respond. The key insight: each bot runs its own `onDispatchDecision` callback independently — the winner AND the runner-up both get `shouldRespond: true` from their local `resolveRound()`. No change needed to the callback structure, just ensure both paths dispatch.

**SYNTHESIS:** When `onDispatchDecision` receives `waitForResponse`:
1. Dispatch the winner normally (it will call `doDispatch` and write a `response_summary` to Supabase)
2. For the runner-up (this bot, if we lost): set a watcher that polls/subscribes for the winner's `response_summary` in the coordination-history table
3. Once the winner's response is available (or timeout after ~15s), dispatch the runner-up with enhanced context:
```
synthesizeContext: "[Coordination resolved: SYNTHESIS. {winnerName} responded first with: '{winnerResponse}'. Your angle: {myAngle}. Respond to the user — you can extend, challenge, reframe, or add your unique perspective. Don't repeat what was already said.]"
```
4. If timeout waiting for winner's response, fall back to PARALLEL mode (dispatch with proposal-only context)

**The `writeResponseSummary` function already exists** in `coordination-history.ts` — it writes to the response_summaries table after each dispatch. For SYNTHESIS, the runner-up needs to READ this after the winner writes it. Add a `waitForResponseSummary(client, coordChatId, roundId, winnerName, timeoutMs)` function to `coordination-history.ts`.

### 5. coordination.ts — Update Haiku prompt

Add `builds_on_other` to the micro-proposal prompt:

```
Respond with ONLY a JSON object:
{"angle": "<your unique angle>", "confidence": <0.0-1.0>, "covers": ["<topic1>"], "solo_sufficient": <true/false>, "builds_on_other": <true/false>}

builds_on_other: Would your response be meaningfully better if you could read the other agent's response first? true = you'd build on their arguments.
```

### 6. coordination-history.ts — Add `waitForResponseSummary()`

```typescript
export async function waitForResponseSummary(
  client: SupabaseClient,
  coordChatId: string,
  roundId: string,
  speakerName: string,
  timeoutMs: number = 15000,
): Promise<string | null> {
  // Poll every 500ms for up to timeoutMs
  // Query response_summaries table for matching roundId + speaker
  // Return content if found, null if timeout
}
```

### 7. tools.ts / coordination-history.ts — Format new message kinds

Update history formatting to handle `mode: "parallel"` and `mode: "synthesis"` in `resolved` messages.

### 8. Verify: `npx tsc --noEmit`

Must compile clean.

## Critical constraints

- **DO NOT touch Layer 2** (AgentMessage, negotiate, resolution handlers)
- **DO NOT break SOLO mode** — it must continue working exactly as before
- **Gateway model param for Haiku** — already wired via `callHaiku`, don't change
- **Deterministic filter** — both bots must agree on mode + winner + runner-up. Filter uses only proposal data (confidence, angle, covers, builds_on_other, names). NEVER use register state in filter logic.
- **Fail-open** — if anything goes wrong in PARALLEL/SYNTHESIS, fall back to SOLO (winner responds)
- **SYNTHESIS timeout** — if runner-up can't get winner's response within 15s, fall back to PARALLEL context (proposal-only)

## File change order

1. `types-coordination.ts` — expand types
2. `coordination.ts` — upgrade filter + resolveRound + Haiku prompt
3. `coordination-history.ts` — add waitForResponseSummary
4. `channel.ts` — handle PARALLEL/SYNTHESIS in onDispatchDecision
5. `tools.ts` — format new modes in history display
6. `npx tsc --noEmit`
