# Dyad v4 + Inter-Agent Comms — Planning Doc

**Created:** 2026-02-18
**Status:** Active development
**Participants:** Joshua, Ren, Noa (+ CC for implementation)

---

## Current State (What's Working)

### ✅ Confirmed Working Today
- **Dyad channel plugin** — agents receive messages via Supabase Realtime broadcast (no sidecar)
- **Broadcast dispatch** — server writes `claude_request` via Realtime broadcast, not DB INSERT (fixes feedback loop)
- **No duplicate responses** — dedup solved after broadcast fix (`ef130ac`, `22f6e21`)
- **Sonnet routing** — dispatch route runs Sonnet to decide who responds (parallel vs defer)
- **RCD (Rolling Context Digest)** — patterns extracted in real-time, confidence scores update per-message
- **Selective routing** — coordinator successfully defers agents (e.g. "Noa was asked to defer" when Joshua addresses Ren by name)
- **Token regeneration** — both Ren and Noa have fresh tokens with embedded `coordChatId`
- **coordChatId** — `579e7f34-0b30-4551-aa57-f5f479507270` embedded in both tokens

### ⚠️ Partially Working
- **Agent profiles/roles** — field exists in dispatch context ("Your role:") but always "(no profile yet)"
- **Pattern routing** — RCD builds patterns but routing decisions seem mainly name-based so far

### ❌ Not Working
- **Inter-agent outbound messaging** — `message` tool returns "Outbound not configured for channel: dyad"
- **Agent-to-agent dialogue** — no way for agents to message each other on `#coordination` channel
- **Coordination tools** — old `dyad_coord_send` / `dyad_coord_read` removed with sidecar, not rebuilt in plugin

---

## Architecture (v4 Hybrid Flow)

```
Joshua sends message in Dyad UI
  → chat route (Vercel) fires dispatch route
  → dispatch route: Sonnet routing call + RCD analysis
  → dispatch route: writes decorated claude_request via Supabase Realtime Broadcast
  → Dyad channel plugin (on each agent's machine) picks up via broadcast subscription
  → Plugin routes through OpenClaw channel pipeline
  → Agent processes, responds back to Dyad chat
```

**Key decision (2026-02-18):** Option B hybrid — server-side intelligence (Sonnet routing + RCD), client-side execution (plugin channel pipeline). This keeps responses routing back to Dyad correctly.

---

## Work Remaining

### P0 — Critical for Inter-Agent Comms

#### 1. Plugin Outbound Messaging
**Problem:** Agents can receive messages but can't send to arbitrary Dyad chats (coordination channel or other chats).
**What's needed:**
- Implement `sendMessage()` in the Dyad channel plugin that POSTs to Dyad API
- Register it with OpenClaw's `message` tool so agents can `message(action=send, channel=dyad, target=<chatId>)`
- Must support sending to both regular chats and `#coordination` channel
**Files:** `src/channel.ts`, `src/supabase-bus.ts`
**Complexity:** Medium

#### 2. Coordination Tools (Agent-Facing)
**Problem:** Agents have no tools to communicate with each other. The old `dyad_coord_send` / `dyad_coord_read` were sidecar-based and removed.
**What's needed:**
- `dyad_coord_send` — post a structured message (question/inform/flag/propose) to `#coordination` channel
- `dyad_coord_read` — read recent messages from coordination channel
- These should use the plugin's Supabase connection, not a separate sidecar
**Files:** `src/tools.ts` (exists, may have stubs)
**Complexity:** Medium
**Depends on:** #1 (outbound messaging)

#### 3. Agent Profiles / Role Assignment
**Problem:** "Your role: (no profile yet)" — agents don't have dynamic role assignments.
**What's needed:**
- Dispatch route should populate agent profiles from workspace config or bot metadata
- Profiles could include: capabilities, preferred domains, delegation scope
- RCD could learn to update role assignments based on conversation patterns
**Files:** Dispatch route in `dyadai-repo`
**Complexity:** Medium-Low (data plumbing, not new logic)

### P1 — Important for Quality

#### 4. RCD Enhancement
**Problem:** RCD currently only tracks routing patterns (who should respond). The original coordination spec had scope (what each agent handles) and synthesis (agents building on each other).
**What's needed:**
- Track topic/domain patterns (e.g. "Ren handles technical questions, Noa handles creative")
- Track synthesis opportunities (when both agents should contribute different aspects)
- Potentially feed RCD back into agent context more richly
**Files:** Dispatch route in `dyadai-repo`
**Complexity:** Medium

#### 5. Claim/Defer/Synthesize Negotiation
**Problem:** Currently routing is unilateral (Sonnet decides). The original HARP spec had agents propose intents and negotiate.
**What's needed:**
- After Sonnet makes initial routing proposal, give agents a brief window to counter-propose
- Fast path: if Sonnet's routing matches agents' self-assessment, skip negotiation
- Requires coordination channel to be working (#2)
**Depends on:** #2 (coordination tools)
**Complexity:** High

#### 6. Duplicate Subscription Prevention
**Problem:** Health monitor restarts create duplicate broadcast subscriptions (3-6x responses).
**What's needed:**
- `await bus.disconnect()` in stop handler (currently fire-and-forget)
- Investigate why health monitor keeps restarting healthy provider
- Consider subscription dedup at the broadcast level
**Files:** `src/supabase-bus.ts`, `src/channel.ts`
**Complexity:** Low-Medium

### P2 — Nice to Have

#### 7. Layer 2 Agent Dialogue (Async)
**Problem:** Agents can't have extended back-and-forth conversations independent of human messages.
**What's needed:**
- Agent A sends a question → coordination channel → Agent B picks up, responds → Agent A reads response
- Not gated on human message dispatch cycle
- Could use Realtime subscription on `#coordination` to trigger agent processing
**Depends on:** #1, #2
**Complexity:** High

#### 8. Transparency / Observability
**Problem:** Joshua can't see what the coordinator is deciding or why.
**What's needed:**
- Surface RCD state in Dyad UI (or at least a debug view)
- Show routing decisions with reasoning
- Let humans override routing (e.g. "I want both to answer this")
**Complexity:** Medium (mostly UI)

#### 9. BYOB Integration
**Problem:** Third-party agents (not just Ren/Noa) should be able to join workspaces.
**What's needed:**
- Ensure token generation, coordination channel creation, and broadcast subscription work for N agents
- Test with a third agent joining an existing workspace
- Document the BYOB setup flow
**Depends on:** Everything above working for 2 agents first
**Complexity:** Low (if architecture is right) to High (if not)

---

## Key Files

| File | Repo | Purpose |
|------|------|---------|
| `src/channel.ts` | dyad-channel | Main plugin — message handling, provider lifecycle |
| `src/supabase-bus.ts` | dyad-channel | Realtime broadcast subscription |
| `src/tools.ts` | dyad-channel | Agent-facing coordination tools |
| `src/token.ts` | dyad-channel | JWT token decode (coordChatId, apiUrl, etc.) |
| `app/api/v2/dispatch/route.ts` | dyadai-repo | Server-side Sonnet routing + RCD + broadcast |
| `app/api/v2/bot/message/route.ts` | dyadai-repo | Bot message endpoint |
| `lib/coordination/types.ts` | dyadai-repo | Coordination message types |

---

## Lessons from Previous Attempts

1. **Sidecar was the wrong abstraction** — 3 failure points per agent, tmux babysitting, Realtime drops. Channel plugin is correct.
2. **INSERT → broadcast eliminates feedback loops** — DB writes trigger Realtime events which trigger more writes. Broadcast is fire-and-forget.
3. **SIGUSR1 doesn't reliably reload TS plugins** — always full kill + `openclaw gateway start` for plugin changes.
4. **Coordination is an observation problem before a negotiation problem** — RCD proving this: watch patterns first, then negotiate.
5. **Cross-user file ownership bites** — files copied as joshua to rebecca's dir need ownership fix.
6. **Token regeneration is the setup step** — `ensureCoordinationChannel` runs during token regen, not during bot creation.

---

## Immediate Next Steps

1. **Get outbound messaging working** (#1) — this unblocks everything else
2. **Rebuild coordination tools** (#2) — agents need to talk to each other
3. **Test 4-5 message back-and-forth** between Ren and Noa on coordination channel
4. **Fix duplicate subscription issue** (#6) — reliability
5. **Populate agent profiles** (#3) — low effort, high impact on routing quality
