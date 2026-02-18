# CC Task: Complete Dyad Channel Plugin

## Objective
Complete the Dyad channel plugin so it replaces the standalone sidecar processes. The scaffold is already in place — the work is enhancing `supabase-bus.ts` with coordination protocol support and wiring everything together.

## Current State
- Plugin scaffold exists at `/Users/joshua/projects/dyad/dyad-channel/`
- Files: `index.ts`, `src/channel.ts`, `src/supabase-bus.ts`, `src/types.ts`, `src/token.ts`, `src/config-schema.ts`, `src/runtime.ts`
- The scaffold already handles basic human messages (`claude_request`) via Supabase Realtime
- Missing: coordination protocol (Layer 1 + Layer 2), staleness watchdog, reconnection, API posting

## Reference Code
- **Sidecar to port from**: `/Users/joshua/projects/dyad/dyadai-repo/lib/coordination/sidecar.ts` (379 lines)
- **Coordination types**: `/Users/joshua/projects/dyad/dyadai-repo/lib/coordination/types.ts`
- **Reference channel plugin (Nostr)**: `/opt/homebrew/lib/node_modules/openclaw/extensions/nostr/`

## What to Build

### 1. New file: `src/coordination.ts` (~250 lines)
Port the coordination protocol from the sidecar into a standalone module:

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

Port from sidecar:
- `RoundState` interface and `rounds` Map
- `handleRoundStart`, `handlePropose`, `handleAccept`, `handleCounter`, `handleReady`, `handleTimeout`, `lockRound`
- `generateProposal`, `generateCounterOrAccept`, `generateFinalIntent`
- `coversOverlap` mechanical diff
- `isValidResponse` filter
- Dedup tracking (`seenMessageIds`)
- Constants: `ROUND_TIMEOUT_MS=12000`, `ROUND_CLEANUP_MS=30000`, `MAX_COORDINATION_DEPTH` (import from types or define as 6)
- `COORDINATION_PROTOCOL_VERSION` (import from types or define as "1.0")

### 2. Update `src/supabase-bus.ts`
Enhance the existing bus to:

a) **Subscribe to coordination channel** — second Realtime subscription filtered by `chat_id=eq.<coordChatId>` on INSERT
b) **Add staleness watchdog** — detect stale subscriptions (2 min silence) and reconnect
c) **Add keepalive** — periodic DB query to keep connection warm (60s interval)
d) **Add reconnection** — on CHANNEL_ERROR or TIMED_OUT, retry after 5s
e) **Route coordination messages** through `onCoordinationMessage` callback
f) **Add `sendCoordination(content: string)`** method to `DyadBusHandle` — POST to `${apiUrl}/api/v2/bot/message` with bot token auth
g) **Add crash protection** — catch unhandled errors in handlers

Update `DyadBusOptions` to add:
```typescript
coordChatId?: string;       // #coordination chat UUID
apiUrl?: string;             // e.g. https://dyadai.vercel.app
botToken?: string;           // raw hex bot token for API auth
botName?: string;            // e.g. "Ren"
onCoordinationMessage?: (msg: DyadCoordinationMessage) => Promise<void>;
```

Update `DyadBusHandle` to add:
```typescript
sendCoordination: (content: string) => Promise<void>;
```

### 3. Update `src/channel.ts`
In `gateway.startAccount`:
- Create a `CoordinationHandler` instance
- Wire `onCoordinationMessage` to route through the handler
- For Layer 2 agent dialogue (AgentMessages), forward to gateway session via `runtime.channel.reply.handleInboundMessage`
- Use `callGateway` that calls the OpenClaw gateway at `localhost:<port>` (get port from runtime or config)

**IMPORTANT**: The gateway calls for coordination should use the OpenClaw gateway's `/v1/chat/completions` endpoint with the gateway token. The bot calls `itself` — the sidecar pattern used env vars `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_TOKEN`. In the plugin context, we need to call the local gateway. Check if `runtime` provides a way to invoke the agent session directly (preferred) or if we need to use the gateway HTTP API.

Actually, looking at it more carefully — the sidecar calls the gateway to generate coordination responses (proposals, intents, counter-decisions). In the plugin context, we can use `runtime.channel.reply.handleInboundMessage` for human messages, but for coordination protocol prompts (which are internal), we may need to use `runtime.system.enqueueSystemEvent` or call the gateway HTTP API. 

**Simplest approach for MVP**: Store the gateway URL + token in config (or derive from runtime), and call `/v1/chat/completions` like the sidecar does. This keeps coordination prompt handling identical to the sidecar.

### 4. Update `src/config-schema.ts`
Add fields to the Zod schema:
```typescript
coordChatId: z.string().uuid().optional(),  // #coordination channel UUID
apiUrl: z.string().url().optional(),         // Dyad API URL
botToken: z.string().optional(),             // Raw hex bot token
botName: z.string().optional(),              // Agent display name
gatewayUrl: z.string().optional(),           // Local gateway URL (e.g. http://localhost:18789)
gatewayToken: z.string().optional(),         // Gateway auth token
```

### 5. Update `src/types.ts`
Add new fields to `DyadAccountConfig` and `ResolvedDyadAccount`:
```typescript
// DyadAccountConfig
coordChatId?: string;
apiUrl?: string;
botToken?: string;
botName?: string;
gatewayUrl?: string;
gatewayToken?: string;

// ResolvedDyadAccount
coordChatId: string;
apiUrl: string;
botToken: string;
botName: string;
gatewayUrl: string;
gatewayToken: string;
```

### 6. Update `src/token.ts`
Add `apiUrl` field to the token (optional, with default):
```typescript
// DyadBotToken
apiUrl?: string;  // Dyad API URL (default: https://dyadai.vercel.app)
```

### 7. New file: `src/types-coordination.ts`
Define coordination-specific types (adapted from dyadai-repo):
```typescript
export const COORDINATION_PROTOCOL_VERSION = "1.0";
export const MAX_COORDINATION_DEPTH = 6;

export interface Proposal {
  angle: string;
  covers: string[];
  defers: string[];
}

export interface ParsedCoordinationMessage {
  id: string;
  speaker: string;
  content: string;
  parsed: any;
  messageType: string;
}
```

### 8. Update `package.json`
Add dependency:
```json
"@supabase/supabase-js": "^2.45.0"
```

### 9. Update `openclaw.plugin.json`
Ensure configSchema includes the new fields.

## Gateway Communication Pattern

For coordination (generating proposals, intents, counter-decisions), the plugin needs to call the OpenClaw gateway. In the sidecar, this was:

```typescript
fetch(`${GW_URL}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GW_TOKEN}` },
  body: JSON.stringify({
    model: 'openclaw:main',
    user: 'dyad:coord',
    messages: [{ role: 'user', content: prompt }],
  }),
  signal: AbortSignal.timeout(timeoutMs),
});
```

In the plugin, we should replicate this pattern using the configured `gatewayUrl` and `gatewayToken`. The coordination prompts are internal (not user-facing) so they go through the `:coord` session.

## What NOT to Change
- `index.ts` — already correct
- `runtime.ts` — already correct
- `openclaw.plugin.json` basic structure — keep as is

## Testing Strategy
After implementation:
1. Install the plugin: symlink to `~/.openclaw/extensions/dyad`
2. Add config to `openclaw.yaml`:
   ```yaml
   channels:
     dyad:
       token: <base64 bot token>
       coordChatId: "579e7f34-0b30-4551-aa57-f5f479507270"
       apiUrl: "https://dyadai.vercel.app"
       botToken: "23fa6686aa9db565c085ebfacfe61e53c2188a8fb8bc61e7"
       botName: "Ren"
       gatewayUrl: "http://localhost:18789"
       gatewayToken: "ef8d6895..."
   ```
3. Restart OpenClaw gateway
4. Verify: send message in Dyad → agent responds
5. Verify: coordination round fires → intents flow

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

## Priority
This is the highest priority task — Joshua wants it built tonight for the Betaworks demo tomorrow.
