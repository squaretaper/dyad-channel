# @dyad/openclaw-channel

OpenClaw channel plugin for [Dyad](https://dyadai.com) AI workspaces. Chat with your OpenClaw agent through Dyad — no tunnels, no port forwarding, works behind NAT.

## Quick Start

### 1. Install the plugin

```bash
openclaw extension install github:squaretaper/dyad-channel
```

Or manually — clone directly into the extensions directory:
```bash
git clone https://github.com/squaretaper/dyad-channel.git ~/.openclaw/extensions/dyad
```

> **Note:** Do not use a symlink — the global extensions scanner uses `readdirSync` with `withFileTypes`, which sees symlinks as symlinks (not directories) and skips them. If you're developing locally, add the path to your `openclaw.yaml` instead:
> ```yaml
> plugins:
>   load:
>     paths:
>       - /absolute/path/to/dyad-channel
> ```

### 2. Get a bot token from Dyad

1. Open [dyadai.com](https://dyadai.com) and go to your workspace
2. Go to **Profile** > **Bot Management**
3. Click **Create Bot** — copy the base64 token it gives you

### 3. Add to `openclaw.yaml`

```yaml
channels:
  dyad:
    token: "<paste your base64 bot token here>"
```

### 4. Restart

```bash
openclaw gateway restart
```

That's it. Messages in your Dyad workspace now route to your OpenClaw agent.

## Multi-Agent Coordination (Optional)

For workspaces with two bots, the plugin supports structured negotiation — agents propose what they'll cover, diff for overlap, and divide work automatically.

Each bot needs its own OpenClaw instance. Add coordination fields to each bot's `openclaw.yaml`:

```yaml
channels:
  dyad:
    token: "<base64 bot token>"
    coordChatId: "<#coordination chat UUID>"
    botName: "<display name in Dyad>"
    botToken: "<hex API token from Dyad>"
    gatewayToken: "<your OPENCLAW_GATEWAY_TOKEN>"
```

Both bots must share the same `coordChatId` — that's the `#coordination` chat in your Dyad workspace (visible in the URL when you open it).

Coordination activates automatically when `coordChatId`, `botToken`, and `gatewayToken` are all set.

## All Config Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `token` | yes | — | Base64 bot token from Dyad |
| `enabled` | no | `true` | Enable/disable channel |
| `coordChatId` | no | — | UUID of `#coordination` chat |
| `botName` | no | `"Bot"` | Display name (must match Dyad) |
| `botToken` | no | — | Hex API token from Dyad |
| `gatewayToken` | no | — | OpenClaw gateway bearer token |
| `apiUrl` | no | `https://dyadai.vercel.app` | Dyad API endpoint |
| `gatewayUrl` | no | `http://localhost:18789` | OpenClaw gateway URL |

## License

MIT
