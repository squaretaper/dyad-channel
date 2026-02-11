# CC Task: Complete Dyad Channel Plugin

## Status: COMPLETE

All planned work has been implemented and tested. The plugin fully replaces the standalone sidecar processes. See "Implementation Notes" below for deviations from the original plan.

---

## Objective
Complete the Dyad channel plugin so it replaces the standalone sidecar processes. The scaffold is already in place — the work is enhancing `supabase-bus.ts` with coordination protocol support and wiring everything together.

## Original State (Before)
- Plugin scaffold exists at `/Users/joshua/projects/dyad/dyad-channel/`
- Files: `index.ts`, `src/channel.ts`, `src/supabase-bus.ts`, `src/types.ts`, `src/token.ts`, `src/config-schema.ts`, `src/runtime.ts`
- The scaffold already handles basic human messages (`claude_request`) via Supabase Realtime
- Missing: coordination protocol (Layer 1 + Layer 2), staleness watchdog, reconnection, API posting

## Reference Code
- **Sidecar to port from**: `/Users/joshua/projects/dyad/dyadai-repo/lib/coordination/sidecar.ts` (379 lines)
- **Coordination types**: `/Users/joshua/projects/dyad/dyadai-repo/lib/coordination/types.ts`
- **Reference channel plugin (Nostr)**: `/opt/homebrew/lib/node_modules/openclaw/extensions/nostr/`

## What Was Built

### 1. `src/coordination.ts` -- DONE
Ported the coordination protocol from the sidecar into a standalone module (~650 lines).

```typescript
export interface CoordinationHandler {
  handleMessage(msg: ParsedCoordinationMessage): Promise<void>;
  hasActiveRound(): boolean;
  cleanup(): void;
}

export function createCoordinationHandler(opts: {
  botName: string;
  callGateway: (prompt: string, timeoutMs: number) => Promise<string | null>;
  postToCoordination: (content: string) => Promise<void>;
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}): CoordinationHandler;
```

Ported from sidecar:
- [x] `RoundState` interface and `rounds` Map
- [x] `handleRoundStart`, `handlePropose`, `handleAccept`, `handleCounter`, `handleReady`, `handleTimeout`, `lockRound`
- [x] `generateProposal`, `generateCounterOrAccept`, `generateFinalIntent`
- [x] `coversOverlap` mechanical diff
- [x] `isValidResponse` filter
- [x] Dedup tracking (`seenMessageIds`)
- [x] Constants: `ROUND_TIMEOUT_MS=12000`, `ROUND_CLEANUP_MS=30000`, `MAX_COORDINATION_DEPTH` (imported from types-coordination)
- [x] `COORDINATION_PROTOCOL_VERSION` (imported from types-coordination)
- [x] `DispatchDecision` interface + `onDispatchDecision` callback (signals claim/defer to channel.ts)
- [x] `triggerMessageId` tracking through round state (links coordination rounds back to the message that triggered them)

### 2. `src/supabase-bus.ts` -- DONE

- [x] Subscribe to coordination channel — second Realtime subscription filtered by `chat_id=eq.<coordChatId>` on INSERT
- [x] Staleness watchdog — 10-minute silence threshold triggers reconnect (checked every 30s)
- [x] Keepalive — periodic DB query every 60s to keep connection warm
- [x] Reconnection — on CHANNEL_ERROR or TIMED_OUT, retry after 5s
- [x] Route coordination messages through `onCoordinationMessage` callback
- [x] `sendCoordination(content: string)` — **direct Supabase insert** (see Implementation Notes)
- [x] Crash protection — try/catch around all handlers
- [x] Dual-layer dedup on message subscription: ID-based (60s TTL) + content-based `${chat_id}:${user_id}:${content.slice(0,80)}` (5s TTL)
- [x] Dual-layer dedup on coordination subscription: ID-based (60s TTL) + content-based `${round_id}:${kind}:${speaker}` (10s TTL)
- [x] Bot auth sign-in via `supabase.auth.signInWithPassword` using credentials from composite token

### 3. `src/channel.ts` -- DONE

- [x] Create `CoordinationHandler` instance when coordEnabled
- [x] Wire `onCoordinationMessage` to route through handler
- [x] `callGateway` calls OpenClaw gateway `/v1/chat/completions` with retry + backoff
- [x] Coordination-aware `onMessage` — holds dispatch when coordination enabled, stores in `pendingDispatches` Map
- [x] `onDispatchDecision` callback wired to coordination handler — resolves pending dispatches (claim -> dispatch with synthesize context, defer -> skip)
- [x] 30s fallback timeout on pending dispatches (dispatches anyway if coordination doesn't resolve)
- [x] Native dispatch pipeline via `dispatchReplyWithBufferedBlockDispatcher` from OpenClaw SDK (~3s response time, replaced slow gateway `/v1/chat/completions` workaround)
- [x] Cleanup on stop: clears pending dispatch timeouts, coordination handler, bus disconnect

### 4. `src/config-schema.ts` -- DONE
### 5. `src/types.ts` -- DONE
### 6. `src/token.ts` -- DONE
### 7. `src/types-coordination.ts` -- DONE
### 8. `package.json` -- DONE
### 9. `openclaw.plugin.json` -- DONE

## Implementation Notes (Deviations from Original Plan)

### sendCoordination: Direct Supabase insert, not API route
The original plan called for posting coordination messages via the Dyad API (`POST /api/v2/bot/message`). In practice, this had workspace_id validation issues. The implemented solution uses **direct Supabase insert** — the bot signs in via `supabase.auth.signInWithPassword` using credentials embedded in the composite token, so RLS allows it to insert as a chat member. This is faster and more reliable.

### Dispatch pipeline: Native SDK, not gateway HTTP
The original plan used the OpenClaw gateway's `/v1/chat/completions` endpoint to generate responses to human messages. The implemented solution uses `dispatchReplyWithBufferedBlockDispatcher` from the OpenClaw SDK — a native dispatch pipeline that runs the agent in-process. This cut response latency from ~8-10s to ~3s. The gateway HTTP endpoint is still used for coordination LLM calls (proposals, intents, counter-decisions) which go through the `:coord` session.

### Dedup: Dual-layer, not single-layer
The original plan assumed single ID-based dedup would suffice. In testing, Supabase Realtime was observed sending multiple notification IDs for the same INSERT (e.g., 5x in 2ms). The implemented solution uses dual-layer dedup on both the message and coordination subscriptions:
- Layer 1: ID-based (60s TTL) — catches exact row re-delivery
- Layer 2: Content-based (5-10s TTL) — catches different notification IDs for the same INSERT

### Pending dispatch pattern (new, not in original plan)
When coordination is enabled, `onMessage` in channel.ts does not dispatch immediately. Instead, it stores a pending dispatch keyed by messageId, and the coordination handler resolves it via the `onDispatchDecision` callback after negotiation completes. A 30s fallback timeout ensures dispatch always happens even if coordination stalls.

### triggerMessageId tracking (new, not in original plan)
`round_start` messages include a `trigger_message_id` field that links the coordination round back to the original human message. This is threaded through `RoundState` and included in the `DispatchDecision` so channel.ts can match coordination outcomes to pending dispatches.

## Gateway Communication Pattern (Coordination LLM Calls)

Coordination LLM calls (proposals, intents, counter-decisions) use the OpenClaw gateway HTTP API, same as the sidecar did:

```typescript
fetch(`${gatewayUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayToken}` },
  body: JSON.stringify({
    model: 'openclaw:main',
    user: 'dyad:coord',
    messages: [{ role: 'user', content: prompt }],
  }),
  signal: AbortSignal.timeout(timeoutMs),
});
```

The coordination prompts are internal (not user-facing) so they go through the `:coord` session. Retry with exponential backoff is included (1 retry, 2x timeout on retry).

## What Was NOT Changed
- `index.ts` — already correct
- `runtime.ts` — already correct
- `openclaw.plugin.json` basic structure — kept as is

## Testing (Verified)
1. Plugin installed via path in `openclaw.yaml` `plugins.load.paths`
2. Config in `openclaw.yaml` under `channels.dyad`
3. Verified: human messages dispatch and respond (~3s via native pipeline)
4. Verified: coordination rounds fire, proposals/accept/ready flow correctly
5. Verified: dispatch decisions resolve pending dispatches (claim -> respond, defer -> skip)

## File Structure (Final)
```
dyad-channel/
├── index.ts                    # Plugin registration (existing, no changes)
├── openclaw.plugin.json        # Plugin manifest (existing, minimal changes)
├── package.json                # Dependencies (add @supabase/supabase-js)
├── tsconfig.json               # TypeScript config (existing, no changes)
├── CC-TASK.md                  # This file
├── README.md                   # Update with setup instructions
└── src/
    ├── channel.ts              # Channel plugin definition (update gateway section)
    ├── config-schema.ts        # Zod schema (add new fields)
    ├── coordination.ts         # NEW: Coordination protocol handler
    ├── runtime.ts              # Runtime singleton (existing, no changes)
    ├── supabase-bus.ts         # Supabase Realtime bus (major update)
    ├── token.ts                # Bot token codec (minor update)
    ├── types.ts                # Account types (update with new fields)
    └── types-coordination.ts   # NEW: Coordination type definitions
```

## Status History
- **Original priority**: Highest — built for Betaworks demo.
- **Completed**: All items implemented across multiple sessions.
- **Sidecar status**: `lib/coordination/sidecar.ts` in dyadai-repo is now dead code, replaced by this plugin.
