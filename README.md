# @dyad/openclaw-channel

OpenClaw channel plugin for [Dyad](https://dyadai.com) AI workspaces. Connects your OpenClaw agent to Dyad so you can chat with it through the Dyad interface — replacing Telegram, Discord, or any other channel.

## How it works

```
Dyad UI → Supabase (INSERT claude_request)
               ↓ Realtime INSERT event (outbound WebSocket)
         Dyad Channel Plugin (on your machine)
               ↓ handleInboundMessage()
         OpenClaw Agent Pipeline
               ↓ sendText() callback
         Dyad Channel Plugin
               ↓ Supabase REST INSERT
         Supabase (INSERT bot_response)
               ↓ Realtime
         Dyad UI shows response
```

All connections are **outbound** from your machine. No tunnels, no port forwarding, works behind NAT.

## Setup

### 1. Get a bot token

Create a bot in your Dyad workspace dashboard. You'll get a base64-encoded token.

### 2. Configure OpenClaw

Add to your OpenClaw config (`openclaw.yaml` or equivalent):

```json
{
  "channels": {
    "dyad": {
      "token": "<your-bot-token>"
    }
  }
}
```

### 3. Restart the gateway

```bash
openclaw gateway restart
```

That's it. Your agent is now connected to your Dyad workspace.

## Solo Workspace Mode

Use Dyad as your primary chat surface with your agent — no Telegram needed:

1. Create a personal workspace in Dyad
2. Connect your OpenClaw agent (one token)
3. Start chatting in Dyad — messages go to your agent
4. Full OpenClaw capabilities: tools, memory, skills, everything

### Chat types

- **Direct (1:1)**: You chatting with your agent solo
- **Group**: Collaborative workspace with multiple humans + agents

## Bot Token Format (MVP)

The token is a base64url-encoded JSON object:

```json
{
  "sub": "<bot_id>",
  "wid": "<workspace_id>",
  "uid": "<bot_user_id>",
  "url": "<supabase_url>",
  "key": "<supabase_anon_key>"
}
```

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `token` | string | required | Bot token from Dyad dashboard |
| `enabled` | boolean | `true` | Enable/disable the channel |
| `name` | string | — | Display name for this account |
| `dmPolicy` | `"open"` \| `"disabled"` | `"open"` | DM access policy |

## Architecture

- **`index.ts`** — Plugin entry point, registers channel with OpenClaw
- **`src/channel.ts`** — ChannelPlugin implementation (follows Nostr pattern)
- **`src/supabase-bus.ts`** — Supabase Realtime connection manager
- **`src/token.ts`** — Bot token encode/decode
- **`src/types.ts`** — Account resolution from config
- **`src/config-schema.ts`** — Zod config validation
- **`src/runtime.ts`** — Plugin runtime reference

## Development

```bash
npm install
npx tsc --noEmit  # Type check
```

## License

MIT
