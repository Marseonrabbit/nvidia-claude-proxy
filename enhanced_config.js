// ─── Enhanced Environment Configurations for Claude Code Agent Support ────────
// This file provides config constants. Import into index.js or use as reference
// for Cloudflare Worker env variable defaults.

const DEFAULT_MAX_TOKENS = 131072;
const DEFAULT_API_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_OPUS_MODEL = 'minimaxai/minimax-m2.7';
const DEFAULT_SONNET_MODEL = 'qwen/qwen3-next-80b-a3b-instruct';
const DEFAULT_HAIKU_MODEL = 'moonshotai/kimi-k2.6';
const DEFAULT_FALLBACK_MODEL = 'qwen/qwen3-next-80b-a3b-instruct';
const DEFAULT_TOOL_MODEL = 'moonshotai/kimi-k2-instruct-0905';
const DEFAULT_MAX_UPSTREAM_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 150;   // FIX: reduced from 300ms — faster retry ramp-up
const DEFAULT_UPSTREAM_TIMEOUT_MS = 3600000; // 1 hour
const MAX_RETRY_DELAY_MS = 15000;

const RETRYABLE_UPSTREAM_STATUS = new Set([408, 409, 425, 500, 502, 503, 504, 520, 522, 524]);
// NOTE: 429 intentionally excluded — it has a dedicated single-retry guard in
// callNvidiaApiWithRetry to prevent the double-retry loop that existed before.

const DEBUG = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEBUG === 'true');

// ─── Tool-Capable Models ──────────────────────────────────────────────────────
// Any model NOT in this set will have tool calls rerouted to DEFAULT_TOOL_MODEL.
// Keep this in sync with customModels in settings.json to prevent silent rerouting.
const TOOL_CAPABLE_MODELS = new Set([
  // Moonshot
  'moonshotai/kimi-k2.5',
  'moonshotai/kimi-k2.6',
  'deepseek-ai/deepseek-v4-pro',                    // FIX: restored — used as opus model in settings.json
  'moonshotai/kimi-k2-instruct-0905',

  // MiniMax
  'minimaxai/minimax-m2.7',
  'minimax/minimax-01',

  // Qwen
  'qwen/qwen3-next-80b-a3b-instruct',
  'qwen/qwen2.5-72b-instruct',

  // NVIDIA
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/llama-3.1-nemotron-70b-instruct',

  // Z-AI
  'z-ai/glm-5.1',                            // FIX: added — present in settings.json customModels

  // DeepSeek
  'deepseek-ai/deepseek-v3',
  'deepseek-ai/deepseek-r1',

  // Google
  'minimaxai/minimax-m2.7',
  'google/gemma-2-27b-it',
  'google/gemma-2-9b-it',

  // Meta
  'meta/llama-3.1-405b-instruct',
  'meta/llama-3.1-70b-instruct',
  'meta/llama-3.1-8b-instruct',
  'meta/llama-3.2-1b-instruct',
  'meta/llama-3.2-3b-instruct',
  'meta/llama-3.3-70b-instruct',

  // Mistral
  'mistralai/mistral-large-2-instruct',
  'mistralai/mixtral-8x22b-instruct-v0.1',
]);

// ─── Tool/MCP Error Detection Patterns ───────────────────────────────────────
// FIX: Context-length patterns REMOVED. They belonged here previously but caused
// isToolSupportError() to trigger a model switch on context overflow instead of
// the correct response (reduce max_tokens and retry the same model).
// Context overflow is now handled exclusively by isContextLengthError().
const TOOL_ERROR_PATTERNS = [
  /tool.*not.*support/i,
  /does not support function calling/i,
  /function calling.*not enabled/i,
  /tool.*choice.*invalid/i,
  /invalid.*tool.*choice/i,
  /tool_use.*failed/i,
  /mcp.*error/i,
  /tool.*call.*error/i,
  /tool.*calling.*disabled/i,
  /model.*cannot.*use.*tools/i,
  /tools.*not.*available/i,
  /this model does not support tools/i,
  /tool.*implementation.*error/i,
  /streaming.*tool.*call.*not.*supported/i,
  /agent.*not.*allowed/i,
  /permission.*denied.*tool/i,
  /tool.*access.*forbidden/i,
  // FIX: Removed — these are context errors, not tool errors:
  // /maximum.*context.*length/i,
  // /context.*limit.*reached/i,
  // /too.*many.*tokens/i,
];
// FIX: Removed the orphaned `]);` that was on the line after this array.
// That was a hard syntax error causing the entire file to fail to parse.

// ─── Context Error Detection (separate from tool errors) ─────────────────────
const CONTEXT_ERROR_PATTERNS = [
  /maximum.*context.*length/i,
  /context.*limit.*reached/i,
  /too.*many.*tokens/i,
  /context.*window.*exceeded/i,
];

// ─── Retired / Unavailable Models ────────────────────────────────────────────
const RETIRED_OR_UNAVAILABLE_MODELS = new Set([
  'minimaxai/minimax-m2.1',
]);

// ─── Context Window Estimates ─────────────────────────────────────────────────
const ESTIMATED_MODEL_LIMITS = {
  'meta/llama-3.1': 131072,
  'meta/llama-3.2': 131072,
  'meta/llama-3.3': 131072,
  'mistralai/mistral-large': 131072,
  'qwen/qwen2.5': 131072,
  'qwen/qwen3': 131072,
  'deepseek-ai/deepseek-v3': 131072,
  'z-ai/glm': 131072,
  'moonshotai/kimi': 131072,
  'nvidia/nemotron': 131072,
  'nvidia/llama': 131072,
  'google/gemma': 131072,
  'default': 131072,
};
