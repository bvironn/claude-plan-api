# claude-plan-api

Use your Claude Max/Pro subscription as an OpenAI-compatible API.

One file. Zero dependencies. Runs with Bun.

## What it does

```
Your app → localhost:3456 → api.anthropic.com
(OpenAI format)               (Claude subscription)
```

Accepts OpenAI-format requests, converts them to Anthropic Messages API, injects the required OAuth headers and billing metadata, and returns responses in OpenAI format. Streaming supported.

## Why

Claude Max gives you flat-rate access to all Claude models. This gateway lets you use that subscription from any app, framework, or tool that speaks the OpenAI API format — chatbots, agents, scripts, whatever.

## Requirements

- [Bun](https://bun.sh) runtime
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview) installed and authenticated
- Active Claude Max or Pro subscription

## Setup

### 1. Install Claude Code & authenticate

```bash
npm install -g @anthropic-ai/claude-code
claude
# complete OAuth login, then exit
```

### 2. Clone & run

```bash
git clone https://github.com/bvironn/claude-plan-api.git
cd claude-plan-api
bun run src/index.ts
```

### 3. Test

```bash
# health
curl http://localhost:3456/health

# models
curl http://localhost:3456/v1/models

# chat
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# streaming
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### 4. Run as service (optional)

```bash
sudo cp claude-plan-api.service /etc/systemd/system/
# edit ExecStart path if needed
sudo systemctl daemon-reload
sudo systemctl enable --now claude-plan-api
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT` | `3456` | Port to listen on (or pass as first arg) |
| `CREDENTIALS_PATH` | `~/.claude/.credentials.json` | Path to Claude OAuth credentials |

## Models

| ID | Model |
|----|-------|
| `claude-sonnet-4-6` | Sonnet 4.6 (default) |
| `claude-opus-4-6` | Opus 4.6 |
| `claude-sonnet-4-5` | Sonnet 4.5 |
| `claude-opus-4-5` | Opus 4.5 |
| `claude-haiku-4-5` | Haiku 4.5 |
| `claude-opus-4-1` | Opus 4.1 |
| `claude-opus-4` | Opus 4 |
| `claude-sonnet-4` | Sonnet 4 |

Aliases: `sonnet`, `opus`, `haiku`

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/v1/models` | List models |
| `POST` | `/v1/chat/completions` | Chat completion |

## Features

- **OpenAI-compatible** — drop-in replacement for any OpenAI client
- **All Claude models** — Opus, Sonnet, Haiku across all versions
- **Streaming SSE** — full support including tool use
- **Tool use** — OpenAI function calling format converted to Anthropic tools
- **Auto token refresh** — proactive + reactive on 401
- **Retry with backoff** — 429/529 rate limit handling
- **Zero dependencies** — just Bun + one TypeScript file
- **CORS enabled** — works from browser apps

## Using with OpenAI SDK

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "not-needed",
  baseURL: "http://localhost:3456/v1",
});

const response = await client.chat.completions.create({
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "Hello!" }],
});
```

## Using with Vercel AI SDK

```typescript
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const claude = createOpenAI({
  apiKey: "not-needed",
  baseURL: "http://localhost:3456/v1",
});

const { text } = await generateText({
  model: claude("claude-sonnet-4-6"),
  prompt: "Hello!",
});
```

## Tool name mapping

If you send tools with custom names and Anthropic rejects them, add mappings in `TOOL_NAME_MAP` at the top of `src/index.ts`:

```typescript
const TOOL_NAME_MAP: Record<string, string> = {
  my_search: "WebSearch",
  my_read: "Read",
};
```

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `OAuth authentication is currently not supported` | Missing beta flag | Update to latest version |
| `Invalid bearer token` | Token expired | Gateway auto-refreshes, but if refresh token expired run `claude` again |
| `You're out of extra usage` | Tool name rejected | Add tool name mapping (see above) |

## Disclaimer

Using Claude subscription OAuth tokens outside of Claude Code may violate Anthropic's Terms of Service. Use at your own risk.

## License

MIT
