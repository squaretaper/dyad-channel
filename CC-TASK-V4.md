# Task: v4 Plugin Surgery — Keep Interagent Comms

## Current State
- `dyad-channel` plugin at `0f84f6f` — all coordination code stripped (v4 pure transport)
- `dyadai-repo` at `42fd4bc` — chat route uses `deferred_to_bot`, v4 router exists but is inert

## What To Do

### 1. Plugin (dyad-channel): Restore ONLY interagent comms tools

Restore `src/tools.ts` from commit `6624c9d` — it has `dyad_coord_send` and `dyad_coord_history` tools.

BUT it imports `COORDINATION_PROTOCOL_VERSION` from `types-coordination.ts` (deleted) and uses `resolveDyadAccount` fields that were removed (`coordChatId`, `apiBotToken`, `apiUrl`).

Fix: Read those 3 fields directly from raw config `ctx.config.channels.dyad` instead of `resolveDyadAccount`. Inline the protocol version constant.

Then wire the tools back into `src/index.ts` (register the tool factories).

### 2. Plugin (dyad-channel): Make onMessage a no-op for dispatch

The plugin should NOT dispatch to the gateway. Server-side dispatch route handles that.
But keep the Supabase Realtime subscription (bus) for receiving messages and sending outbound replies.

### 3. dyadai-repo: Flip chat route back to fire dispatch

Revert `42fd4bc` so the openclaw path fires the dispatch route directly instead of `deferred_to_bot`.

### 4. Verify
- `npx tsc --noEmit` clean in both repos
- DO NOT push without asking

## Key Files
- `~/projects/dyad/dyad-channel/src/tools.ts` (restore from git show 6624c9d:src/tools.ts)
- `~/projects/dyad/dyad-channel/src/index.ts` (wire tools)
- `~/projects/dyad/dyad-channel/src/channel.ts` (onMessage should be no-op for dispatch)
- `~/projects/dyad/dyadai-repo/app/api/v2/chat/route.ts` (revert 42fd4bc)
