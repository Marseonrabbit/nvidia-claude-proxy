# NVIDIA Anthropic Proxy

A Cloudflare Worker proxy that enables OpenAI-compatible APIs (like NVIDIA NIM) to work with Anthropic API clients such as Claude Code.

## Overview

This proxy translates between Anthropic's API format and OpenAI-compatible APIs, allowing you to use NVIDIA's hosted LLMs (Llama, Minimax, GLM, etc.) with Claude Code or any other Anthropic-compatible client.

## Architecture

```
┌─────────────────┐     Anthropic API Format     ┌──────────────────┐
│                 │ ─────────────────────────────> │                  │
│   Claude Code   │                               │  Cloudflare      │
│   (or any       │                               │  Worker Proxy    │
│   Anthropic     │ <─────────────────────────────│                  │
│   client)       │     Anthropic API Format     │                  │
└─────────────────┘                               └────────┬─────────┘
                                                           │
                                              ┌────────────┴────────────┐
                                              │      Translation        │
                                              │  Anthropic ↔ OpenAI     │
                                              └────────────┬────────────┘
                                                           │
                                                           ▼
                                              ┌─────────────────────────┐
                                              │   NVIDIA NIM API        │
                                              │   (OpenAI-compatible)   │
                                              └─────────────────────────┘
```

## Project Structure

```
nvidia-anthropic-proxy/
├── index.js              # Main Cloudflare Worker code
├── wrangler.toml         # Cloudflare configuration
├── package.json          # Dependencies and scripts
├── setup.sh              # Setup script for secrets
├── models.json           # NVIDIA model definitions
├── .env.example          # Environment variable template
├── .gitignore            # Git ignore rules
├── public/               # Static assets
│   └── demo.webp         # Demo image
└── README.md             # This file
```

## Request Flow

```
Incoming Request
      │
      ▼
┌─────────────────────────────────────────┐
│  1. CORS & Authentication Check       │
│  • Validate AUTH_TOKEN (if configured) │
│  • Handle preflight OPTIONS            │
└─────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────┐
│  2. Route to Handler                   │
│  • POST /v1/messages → handleMessages  │
│  • POST /v1/messages/count_tokens      │
│  • GET  /v1/models → handleModels      │
│  • GET  /health → health check         │
└─────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────┐
│  3. Request Conversion                   │
│  • Anthropic → OpenAI format           │
│  • Convert messages, tools, images     │
│  • Normalize parameters                │
└─────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────┐
│  4. Upstream API Call                  │
│  • Call NVIDIA NIM API                 │
│  • Retry logic with backoff            │
│  • Timeout handling                    │
└─────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────┐
│  5. Response Conversion                │
│  • OpenAI → Anthropic format           │
│  • Handle streaming/non-streaming    │
└─────────────────────────────────────────┘
      │
      ▼
   Response Sent
```

## Key Features

| Feature | Description |
|---------|-------------|
| **Format Translation** | Converts Anthropic API requests/responses to/from OpenAI format |
| **Streaming Support** | Full Server-Sent Events (SSE) streaming conversion |
| **Tool Support** | Tool calling and tool result handling |
| **Image Support** | Multi-modal image content (base64 and URL) |
| **Retry Logic** | Exponential backoff with configurable retries |
| **CORS Enabled** | Cross-origin requests supported |
| **Authentication** | Optional Bearer token or x-api-key auth |
| **Security** | Constant-time token comparison (timing attack safe) |

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ installed
- [NVIDIA API Key](https://build.nvidia.com) - Get from NVIDIA
- Cloudflare account - Will prompt during first deploy

### 1. Clone and Setup

```bash
git clone https://github.com/YOUR_USERNAME/nvidia-anthropic-proxy.git
cd nvidia-anthropic-proxy
npm install
```

### 2. Configure Secrets

```bash
npm run setup
```

This will prompt you for:
- `NVIDIA_API_KEY` - Your NVIDIA API key (required)
- `AUTH_TOKEN` - Optional proxy authentication token

### 3. Deploy

```bash
npm run deploy
```

After deployment, you'll get a Worker URL:
```
https://nvidia-anthropic-proxy.xxx.workers.dev
```

### 4. Configure Claude Code

Edit `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://nvidia-anthropic-proxy.xxx.workers.dev",
    "ANTHROPIC_API_KEY": "your-auth-token-or-any-non-empty-string",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "moonshotai/kimi-k2.5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "minimaxai/minimax-m2.7",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "z-ai/glm-5.1"
  }
}
```

### 5. Start Using

```bash
claude
```

Use `/model` commands to switch between models:
- `/model opus` → Kimi K2.5
- `/model sonnet` → Minimax M2.7
- `/model haiku` → GLM 5.1

## Development

### Local Development

```bash
npm run dev     # Start local development server
npm run tail    # View real-time logs
```

Test locally:
```bash
curl http://localhost:8787/health
```

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `NVIDIA_API_KEY` | Your NVIDIA API key | Yes |
| `AUTH_TOKEN` | Optional auth token for proxy | No |
| `NVIDIA_API_URL` | NVIDIA API endpoint (default: integrate.api.nvidia.com/v1) | No |
| `FALLBACK_MODEL` | Default fallback model | No |
| `OPUS_MODEL` | Model for Opus tier | No |
| `SONNET_MODEL` | Model for Sonnet tier | No |
| `HAIKU_MODEL` | Model for Haiku tier | No |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | POST | Main chat completions endpoint |
| `/v1/messages/count_tokens` | POST | Token counting |
| `/v1/models` | GET | List available models |
| `/health` | GET | Health check |

## Supported Models

The proxy supports all NVIDIA NIM models including:

| Model | Description |
|-------|-------------|
| `moonshotai/kimi-k2.5` | Kimi K2.5 |
| `minimaxai/minimax-m2.7` | Minimax M2.7 |
| `z-ai/glm-5.1` | GLM 5.1 |
| `nvidia/nemotron-3-super-120b-a12b` | Nemotron 3 |
| `meta/llama-3.3-70b-instruct` | Llama 3.3 70B |
| `deepseek-ai/deepseek-v3` | DeepSeek V3 |

See [build.nvidia.com/models](https://build.nvidia.com/models) for full list.

## Scripts

```bash
npm run setup      # Configure secrets
npm run dev        # Start local development
npm run deploy     # Deploy to Cloudflare
npm run tail       # View production logs
```

## Files

| File | Purpose |
|------|---------|
| `index.js` | Main Cloudflare Worker with format conversion logic |
| `wrangler.toml` | Cloudflare Worker configuration |
| `models.json` | NVIDIA model definitions (for reference) |
| `setup.sh` | Interactive setup script |
| `.env.example` | Environment variable template |

## License

MIT License - See [LICENSE](LICENSE) file
