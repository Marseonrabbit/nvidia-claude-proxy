// Enhanced environment configurations for Claude Code agent support
const DEFAULT_MAX_TOKENS = 131072;
const DEFAULT_API_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_OPUS_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const DEFAULT_SONNET_MODEL = 'qwen/qwen3-next-80b-a3b-instruct';
const DEFAULT_HAIKU_MODEL = 'z-ai/glm-4.7';
const DEFAULT_FALLBACK_MODEL = 'qwen/qwen3-next-80b-a3b-instruct';
const DEFAULT_TOOL_MODEL = 'moonshotai/kimi-k2-instruct-0905';
const DEFAULT_MAX_UPSTREAM_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 300;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 3600000;
const MAX_RETRY_DELAY_MS = 15000;
const RETRYABLE_UPSTREAM_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524]);
const DEBUG = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEBUG === 'true');

// Models known to have robust MCP/tool support - UPDATED
const TOOL_CAPABLE_MODELS = new Set([
  'moonshotai/kimi-k2.5',
  'moonshotai/kimi-k2-instruct-0905',
  'minimaxai/minimax-m2.7',
  'minimax/minimax-01',
  'qwen/qwen3-next-80b-a3b-instruct',
  'nvidia/nemotron-3-super-120b-a12b',
  'z-ai/glm-4.7',
  'deepseek-ai/deepseek-v3',
  'deepseek-ai/deepseek-r1',
  'google/gemma-4-31b-it',
  'meta/llama-3.3-70b-instruct',
  'nvidia/llama-3.1-nemotron-70b-instruct',
]);

// Enhanced tool/MCP error patterns for better agent support
const TOOL_ERROR_PATTERNS = [
  /tool.*not.*support/i,
  /does not support function calling/i,
  /function calling.*not enabled/i,
  /tool.*choice.*invalid/i,
  /invalid.*tool.*choice/i,
  /tool_use.*failed/i,
  /mcp.*error/i,
  /tool.*call.*error/i,
  /.*tool.*calling.*disabled.* /i,
  /model.*cannot.*use.*tools/i,
  /tools.*not.*available/i,
  /this model does not support tools/i,
  /tool.*implementation.*error/i,
  /streaming.*tool.*call.*not.*supported/i,
  /maximum.*context.*length/i,
  /context.*limit.*reached/i,
  /too.*many.*tokens/i,
  /agent.*not.*allowed/i,
  /permission.*denied.*tool/i,
  /tool.*access.*forbidden/i,
];
EOF 2>&1
