# CC Task: Coordination Protocol Fixes (Round 2)

**Author:** Ren + Noa (synthesized from live debugging session with Joshua, Feb 16 2026)  
**Plugin:** `/Users/joshua/projects/dyad/dyad-channel/`  
**Current HEAD:** `0bdb888` (fix: add UPDATE event subscription for reinvoke support)

---

## Context

Joshua tested the Dyad coordination protocol live for ~3 hours. We identified 7 issues through direct observation (some triggered live). Three were fixed in `76d5a88` and `b43c2c8`. This task covers the remaining issues and improvements.

## Files to Modify

| File | What changes |
|------|-------------|
| `src/coordination.ts` | Both-defer fallback, skip overlap for simple messages, fast-path for solo_sufficient, surface-to-chat intent |
| `src/channel.ts` | Proposal failure fail-open, polling fallback for Realtime misses, SIGUSR1 outbound race guard |
| `src/supabase-bus.ts` | Polling fallback (belt-and-suspenders for Realtime) |
| `src/types-coordination.ts` | New intent types (`surface`) |

---

## Issues (Priority Order)

### P0: Both-Defer Silent Drop ⚠️ HAPPENED LIVE

**What:** Both agents independently chose `defer` → both got `shouldRespond: false` → nobody responded → message silently dropped.  
**When:** Round at 6:29 PM — Ren: "I've claimed the last 3 rounds — Noa's turn" / Noa: "I've been deferring this session — identical angles, one ack is enough"  
**Root cause:** No fallback when all agents defer. Each bot decides independently with no tiebreaker.

**Fix:** In `coordination.ts` `lockRound()`, after generating final intent:
- If intent is `defer` or `abstain`, wait 3s grace period
- Check if the other agent's READY message also has `defer`/`abstain`
- If both deferred: force-claim with scope "fallback — both deferred"
- Deterministic tiebreaker: bot with lexicographically lower `botName` force-claims

**Acceptance criteria:**
- [ ] Send a simple message when both bots have been alternating claims → one MUST respond
- [ ] Logs show "both-defer fallback triggered" when it fires
- [ ] No silent drops in 10 consecutive simple messages

### P1: Proposal Failure → 30s Ghost Delay

**What:** If `generateProposal()` returns null (gateway timeout/empty), the round is abandoned but `pendingDispatches` in `channel.ts` is NOT cleaned up. Message sits for 30s until fallback timeout fires.  
**Root cause:** `coordination.ts` deletes the round and clears its timeout, but has no way to signal back to `channel.ts` to release the pending dispatch.

**Fix:** When `generateProposal` returns null, call `onDispatchDecision` with `shouldRespond: true` (fail-open):
```typescript
if (!proposal) {
  log.error("Failed to generate proposal — fail-open dispatch");
  rounds.delete(roundId);
  clearTimeout(timeoutId);
  // NEW: fail-open instead of silent abandon
  if (opts.onDispatchDecision) {
    await opts.onDispatchDecision({
      roundId,
      triggerMessageId: parsed.trigger_message_id || null,
      shouldRespond: true,
      synthesizeContext: "[Coordination failed — responding independently]",
    });
  }
  return;
}
```

**Acceptance criteria:**
- [ ] Simulated gateway timeout → response dispatches within 2s, not 30s
- [ ] Logs show "fail-open dispatch" not "skipping round"

### P2: Skip Overlap Resolution for Simple Messages

**What:** Every coordination round does 3-4 gateway calls (proposal, overlap check, counter/accept, final intent) = 10-15s overhead. For "?" or "testing" this is absurd.  
**Root cause:** No fast-path for messages where `solo_sufficient: true` on both proposals.

**Fix:** In `handlePropose()`, before running overlap detection:
```typescript
// Fast-path: if both proposals have solo_sufficient, skip overlap resolution
if (round.myProposal.solo_sufficient && otherProposal.solo_sufficient) {
  log.info("Both solo_sufficient — skipping overlap, immediate ACCEPT");
  await postToCoordination(JSON.stringify({
    protocol: COORDINATION_PROTOCOL_VERSION,
    round_id: roundId,
    kind: "accept",
  }));
  await lockRound(round);
  return;
}
```

Also add `solo_sufficient` to the Proposal type in `types-coordination.ts`.

**Acceptance criteria:**
- [ ] Simple messages complete coordination in <5s (vs current 10-15s)
- [ ] Complex messages still go through full overlap resolution

### P3: Supabase Realtime Polling Fallback

**What:** Realtime subscription silently misses INSERT events. Joshua's 7:17 PM message was never received by either bot despite both being connected.  
**Root cause:** Supabase Realtime is not 100% reliable. No detection mechanism for single missed events (staleness watchdog only fires after 10 minutes of total silence).

**Fix:** Add a polling fallback in `supabase-bus.ts`:
- Every 5s, query `messages` table for recent `claude_request` rows (last 30s)
- Compare against `processedMessageIds` set
- Any row NOT in the set → inject into `onMessage` callback
- Polling is belt-and-suspenders, not a replacement for Realtime

```typescript
// Polling fallback — catches Realtime misses
intervals.push(
  setInterval(async () => {
    try {
      const since = new Date(Date.now() - 30_000).toISOString();
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
        // processedMessageIds check happens inside onMessage
        // Just re-invoke — the dedup layers will catch true duplicates
        await onMessage({
          chatId: msg.chat_id,
          text: msg.content ?? "",
          userId: msg.user_id,
          messageId: msg.id,
        });
      }
    } catch (e) {
      onError(e as Error, "polling fallback");
    }
  }, 5_000),
);
```

**Acceptance criteria:**
- [ ] Message sent during a Realtime gap is picked up within 5s by polling
- [ ] Polling does NOT cause duplicate processing (dedup layers catch it)
- [ ] No measurable load increase on Supabase (10 rows/5s is negligible)

### P4: SIGUSR1 Outbound Race Condition

**What:** After SIGUSR1 restart, "Outbound not configured for channel: dyad" error. The agent session resumed before the dyad plugin finished re-registering its outbound handler.  
**Root cause:** SIGUSR1 triggers config reload → plugin re-init → but session dispatch runs before `startAccount` completes.

**Fix:** This may need to be addressed in OpenClaw core (plugin startup should gate session resumption). At the plugin level, add a ready guard:
- Track `busReady` boolean in the account scope
- Set `true` only after `startDyadBus` resolves AND first Realtime subscription fires `SUBSCRIBED`
- In `outbound.sendText`, if `!busReady`, wait up to 5s with polling before failing

**Acceptance criteria:**
- [ ] SIGUSR1 restart → first message after restart delivers successfully
- [ ] No "Outbound not configured" errors in logs after restart

### P5: Late Coordination Messages Have No Path to User

**What:** Inter-agent discussion (Layer 2) that happens after chat responses are delivered is invisible to the user. Useful insights from back-channel exchanges are lost.  
**Root cause:** No mechanism for an agent to proactively push a coordination insight to the Dyad chat.

**Fix (future consideration):** Add a `surface` intent to the coordination protocol:
```typescript
// Agent can request surfacing coord insights to user
{
  protocol: "dyad-coord-v2",
  kind: "surface",
  content: "Summary of back-channel discussion...",
  speaker: "Noa",
  trigger_round_id: "original-round-id"  // links back to the triggering message
}
```
Plugin intercepts `surface` messages and creates a `bot_response` in the original chat. Requires careful dedup to avoid spam.

**Acceptance criteria:**
- [ ] Agent sends `surface` intent → message appears in Dyad chat
- [ ] Rate-limited (max 1 surface per original message per agent)
- [ ] User can disable via workspace setting

### P6: Content Dedup Eating Legitimate Retries (FIXED in b43c2c8)

**What:** 30s content dedup window meant that if a message failed silently and the user retried within 30s, the retry was also dropped.  
**Status:** Fixed — reduced to 5s in commit `b43c2c8`. The 5s window catches the ~8ms Supabase duplicate INSERTs without blocking legitimate retries.

---

## Implementation Order

1. **P0** (both-defer fallback) — prevents silent drops, highest user impact
2. **P1** (fail-open on proposal failure) — prevents 30s ghost delays
3. **P2** (skip overlap for simple messages) — reduces latency by 50-70%
4. **P3** (polling fallback) — catches Realtime misses
5. **P4** (SIGUSR1 race guard) — prevents post-restart failures
6. **P5** (surface intent) — future work, lower priority

## Testing

After each fix, test in the live Dyad workspace:
1. Send 10 simple messages ("?", "test", "hi") — verify no silent drops, no dups, <5s response
2. Send 3 complex messages — verify both agents respond with distinct angles
3. Kill one gateway mid-round — verify other agent still responds (fallback path)
4. SIGUSR1 restart — verify first message after restart delivers

## Notes

- All code changes are in the plugin (`/Users/joshua/projects/dyad/dyad-channel/src/`), not OpenClaw core
- P4 may require OpenClaw core changes — flag if plugin-level fix is insufficient
- The coordination session (`dyad:coord`) accumulates context across rounds — monitor for context window bloat
- Run `npx tsc` after changes — plugin uses compiled JS from `dist/`
