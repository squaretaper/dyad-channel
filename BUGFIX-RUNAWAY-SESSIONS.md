# Bug: Runaway Session Spawning

## Problem
Every `callGateway()` invocation creates a unique session via the `/v1/chat/completions` endpoint, generating hundreds of opus-tier sessions during active coordination. Today this spawned **491 sessions** and starved the main Telegram session, requiring multiple gateway reboots.

## Root Cause
**`src/channel.ts` line 182:**
```ts
const sessionId = `dyad:coord:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
```
Every call gets a unique session ID. The comment says "prevent session contamination" but the result is unbounded session creation.

**`src/coordination.ts`** calls `callGateway` ~10 times across different handlers (propose, counter, synthesize, inter-agent dialogue). A single user message can trigger 3-5 gateway calls per agent. With two agents exchanging messages, this compounds exponentially.

## Gateway Config (for context)
```json
{
  "maxConcurrent": 4,        // doesn't apply to plugin HTTP calls
  "subagents.maxConcurrent": 8  // same — not enforced on /v1/chat/completions
}
```
The `maxConcurrent` setting governs native agent runs, NOT sessions spawned by plugins via the HTTP API. So the "cap at 6 conversations" that used to work isn't in play here.

## Fix Requirements

### 1. Session Reuse (primary fix)
Instead of unique session per call, reuse a small pool of session keys scoped to purpose:

```ts
// Option A: One session per coordination round
const sessionId = `dyad:coord:${roundId}`;

// Option B: One long-lived session per coordination type  
const sessionId = `dyad:coord:propose`;  // reuses context across rounds
const sessionId = `dyad:coord:dialogue`; // inter-agent chat

// Option C: Rolling window — reuse session for N minutes, then rotate
const SESSION_TTL_MS = 5 * 60 * 1000;
const sessionId = `dyad:coord:${Math.floor(Date.now() / SESSION_TTL_MS)}`;
```

Trade-off: session reuse means conversation history bleeds between rounds (which is why unique IDs were added). But that bleed is far less costly than 491 sessions.

**Recommendation:** Option A (per-round) for coordination, Option B (long-lived) for inter-agent dialogue. This gives isolation where it matters (round negotiation) and reuse where it doesn't (general chat).

### 2. Concurrency Guard (defense in depth)
Add a semaphore in the plugin to cap active gateway calls:

```ts
// In channel.ts, wrap callGateway
const MAX_CONCURRENT_GATEWAY_CALLS = 3;
let activeGatewayCalls = 0;
const gatewayQueue: Array<() => void> = [];

async function callGatewayThrottled(prompt: string, timeoutMs: number): Promise<string | null> {
  if (activeGatewayCalls >= MAX_CONCURRENT_GATEWAY_CALLS) {
    await new Promise<void>(resolve => gatewayQueue.push(resolve));
  }
  activeGatewayCalls++;
  try {
    return await callGateway(prompt, timeoutMs);
  } finally {
    activeGatewayCalls--;
    gatewayQueue.shift()?.();
  }
}
```

### 3. Session Cleanup (nice to have)
Sessions created by the plugin persist forever. Add cleanup after round resolution:
- Track session IDs created during a coordination round
- After round resolves, mark them for cleanup (or use a TTL header if the gateway supports it)

## Files to Change
- `src/channel.ts` — session ID generation (line 182), add concurrency guard
- `src/coordination.ts` — pass roundId to callGateway for session key scoping
- `src/supabase-bus.ts` — no changes needed (subscription layer is fine)

## Testing
1. Send a message in Dyad workspace
2. Watch `openclaw sessions --active 5 --json` — should see ≤3 coord sessions, not 50+
3. Send 10 messages rapidly — sessions should plateau, not grow linearly
4. Confirm coordination still works (PROPOSE → ACCEPT/COUNTER → READY → dispatch)
