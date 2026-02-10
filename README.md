# @dyad/openclaw-channel

OpenClaw channel plugin for [Dyad](https://dyadai.com) AI workspaces. Connects your OpenClaw agent to Dyad so you can chat with it through the Dyad interface — replacing Telegram, Discord, or any other channel.

## How it works

```
Dyad UI -> Supabase (INSERT claude_request)
               | Realtime INSERT event (outbound WebSocket)
         Dyad Channel Plugin (on your machine)
               | handleInboundMessage()
         OpenClaw Agent Pipeline
               | sendText() callback
         Dyad Channel Plugin
               | Supabase REST INSERT
         Supabase (INSERT bot_response)
               | Realtime
         Dyad UI shows response
```

All connections are **outbound** from your machine. No tunnels, no port forwarding, works behind NAT.

## Installation

### 1. Clone the plugin

```bash
git clone https://github.com/squaretaper/dyad-channel.git
```

### 2. Symlink into OpenClaw extensions

OpenClaw loads channel plugins from its extensions directory. Create a symlink:

```bash
# macOS / Linux
mkdir -p ~/.openclaw/extensions
ln -s $(pwd)/dyad-channel ~/.openclaw/extensions/dyad
```

Verify the symlink:

```bash
ls -la ~/.openclaw/extensions/dyad
# Should point to your cloned dyad-channel directory
```

### 3. Get a bot token from Dyad

1. Open your Dyad workspace
2. Go to **Profile** > **Bot Management**
3. Create a new bot — you'll get a base64-encoded token
4. Copy the token

### 4. Configure OpenClaw

Add the Dyad channel to your `openclaw.yaml`:

```yaml
channels:
  dyad:
    enabled: true
    token: "eyJ...your-base64-bot-token..."
```

### 5. Restart the gateway

```bash
openclaw gateway restart
```

Your agent is now connected to your Dyad workspace. Messages sent in Dyad will be routed to your OpenClaw agent, and responses will appear in the Dyad UI.

### Verify it's working

```bash
openclaw status
```

You should see the Dyad channel listed as `running`.

## Multi-Agent Coordination (Optional)

For workspaces with multiple bots, the plugin supports the Dyad coordination protocol — structured negotiation so agents divide work instead of duplicating it.

### How coordination works

When a user sends a message in a multi-bot workspace:

1. Dyad dispatches a `round_start` to the `#coordination` chat
2. Each agent generates a **PROPOSE** (structured: angle, covers, defers)
3. Agents compare proposals with **mechanical diff** — if no overlap, instant **ACCEPT**
4. If overlap, agents negotiate via **COUNTER** (one round max)
5. Both agents send **READY** with their final division of labor
6. Each agent responds to the user covering only their agreed scope

### Coordination config

Add these fields alongside your basic config:

```yaml
channels:
  dyad:
    enabled: true
    token: "eyJ...your-base64-bot-token..."

    # Coordination fields
    coordChatId: "uuid-of-coordination-chat"   # The #coordination chat ID
    apiUrl: "https://dyadai.vercel.app"         # Dyad API endpoint
    botToken: "hex-api-token"                   # Bot's API auth token
    botName: "Ren"                              # Bot display name (must match Dyad)
    gatewayUrl: "http://localhost:18789"         # Your OpenClaw gateway
    gatewayToken: "your-gateway-bearer-token"   # Gateway auth token
```

**Where to find these values:**

| Field | Where to get it |
|-------|----------------|
| `coordChatId` | The UUID of the `#coordination` chat in your workspace (visible in the URL or via Supabase) |
| `apiUrl` | Your Dyad deployment URL (default: `https://dyadai.vercel.app`) |
| `botToken` | The hex API token generated when you created the bot in Dyad |
| `botName` | The display name you gave the bot in Dyad (e.g. "Ren", "Stimpy") |
| `gatewayUrl` | Your OpenClaw gateway URL (default: `http://localhost:18789`) |
| `gatewayToken` | Your OpenClaw gateway bearer token (from `openclaw.yaml` or `OPENCLAW_GATEWAY_TOKEN` env) |

### Running two agents in one workspace

Each agent needs its own OpenClaw instance and its own Dyad bot token. Example setup for two agents (Ren and Stimpy):

**Agent 1 (Ren) — `openclaw.yaml`:**
```yaml
channels:
  dyad:
    token: "eyJ...ren-bot-token..."
    coordChatId: "shared-coordination-chat-uuid"
    botName: "Ren"
    botToken: "ren-hex-api-token"
    gatewayToken: "ren-gateway-token"
```

**Agent 2 (Stimpy) — `openclaw.yaml`:**
```yaml
channels:
  dyad:
    token: "eyJ...stimpy-bot-token..."
    coordChatId: "shared-coordination-chat-uuid"
    botName: "Stimpy"
    botToken: "stimpy-hex-api-token"
    gatewayToken: "stimpy-gateway-token"
```

Both agents share the same `coordChatId` — that's how they find each other.

## Solo Workspace Mode

Use Dyad as your primary chat surface with a single agent — no coordination needed:

1. Create a personal workspace in Dyad
2. Connect your OpenClaw agent (one token, no coordination fields)
3. Start chatting in Dyad — messages go to your agent
4. Full OpenClaw capabilities: tools, memory, skills, everything

## Configuration Reference

### Basic fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `token` | string | **required** | Base64 bot token from Dyad dashboard |
| `enabled` | boolean | `true` | Enable/disable the channel |
| `name` | string | — | Display name for this account |
| `dmPolicy` | `"open"` \| `"disabled"` | `"open"` | DM access policy |

### Coordination fields (optional)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `coordChatId` | UUID string | — | ID of the `#coordination` chat |
| `apiUrl` | URL string | `https://dyadai.vercel.app` | Dyad API endpoint |
| `botToken` | string | — | Hex API token for bot auth |
| `botName` | string | value of `name` | Bot display name for coordination |
| `gatewayUrl` | URL string | `http://localhost:18789` | OpenClaw gateway URL |
| `gatewayToken` | string | — | Gateway bearer token |

Coordination is only active when `coordChatId`, `botToken`, and `gatewayToken` are all set. Without them, the plugin works as a simple message bridge.

## Architecture

```
index.ts                  Plugin entry point, registers with OpenClaw
src/
  channel.ts              ChannelPlugin implementation + gateway wiring
  supabase-bus.ts         Supabase Realtime subscriptions (messages + coordination)
  coordination.ts         Coordination protocol handler (PROPOSE/ACCEPT/COUNTER/READY)
  types-coordination.ts   Coordination protocol types and constants
  token.ts                Bot token encode/decode (base64url JSON)
  types.ts                Account config resolution
  config-schema.ts        Zod config validation
  runtime.ts              Plugin runtime singleton
```

## Development

```bash
# Install dependencies (requires pnpm in OpenClaw workspace, or symlink manually)
ln -s /opt/homebrew/lib/node_modules/openclaw node_modules/openclaw
npm install --no-package-lock typescript @supabase/supabase-js zod

# Type check
npx tsc --noEmit
```

## License

MIT
