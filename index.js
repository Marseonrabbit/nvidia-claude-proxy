// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_MAX_TOKENS = 131072;
const DEFAULT_API_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_OPUS_MODEL = 'minimaxai/minimax-m2.7';
const DEFAULT_SONNET_MODEL = 'qwen/qwen3-next-80b-a3b-instruct';
const DEFAULT_HAIKU_MODEL = 'moonshotai/kimi-k2.6';
const DEFAULT_FALLBACK_MODEL = 'qwen/qwen3-next-80b-a3b-instruct';
const DEFAULT_TOOL_MODEL = 'moonshotai/kimi-k2-instruct-0905';
const DEFAULT_MAX_UPSTREAM_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 150; // FIX: reduced from 300ms for faster retries
const DEFAULT_UPSTREAM_TIMEOUT_MS = 3600000; // 1 hour
const MAX_RETRY_DELAY_MS = 15000;

// FIX: Removed 429 from this set — it has its own dedicated retry guard below.
// Keeping 429 here caused double-retries (special guard + generic check both fired).
const RETRYABLE_UPSTREAM_STATUS = new Set([408, 409, 425, 500, 502, 503, 504, 520, 522, 524]);

const DEBUG = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEBUG === 'true');

// FIX: Expanded to include all models present in settings.json customModels
// so tool calls are never silently rerouted away from user-selected models.
const TOOL_CAPABLE_MODELS = new Set([
  'moonshotai/kimi-k2.5',
  'moonshotai/kimi-k2.6',
  'minimaxai/minimax-m2.7',           // FIX: was dropped in enhanced_config — restored
  'moonshotai/kimi-k2-instruct-0905',
  'minimaxai/minimax-m2.7',
  'minimax/minimax-01',
  'qwen/qwen3-next-80b-a3b-instruct',
  'qwen/qwen2.5-72b-instruct',
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'z-ai/glm-5.1',                   // FIX: added — present in settings.json customModels
  'deepseek-ai/deepseek-v3',
  'deepseek-ai/deepseek-r1',
  'minimaxai/minimax-m2.7',
  'google/gemma-2-27b-it',
  'google/gemma-2-9b-it',
  'meta/llama-3.1-405b-instruct',
  'meta/llama-3.1-70b-instruct',
  'meta/llama-3.1-8b-instruct',
  'meta/llama-3.2-1b-instruct',
  'meta/llama-3.2-3b-instruct',
  'meta/llama-3.3-70b-instruct',
  'mistralai/mistral-large-2-instruct',
  'mistralai/mixtral-8x22b-instruct-v0.1',
]);

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

const RETIRED_OR_UNAVAILABLE_MODELS = new Set([
  'minimaxai/minimax-m2.1',
]);

// FIX: Context-length patterns REMOVED from here. They were causing model-switches
// on token overflow instead of the correct behaviour (reduce max_tokens, retry same model).
// Context errors are handled separately by isContextLengthError().
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
];

const CLAUDE_MD_CONTENT = `# CLAUDE.md — Agentic Coding Assistant Instructions

You are an advanced AI coding assistant operating in agentic mode. You MUST follow these rules strictly to maintain the agentic workflow loop without breaking.

## Core Agentic Flow Rules
1. ALWAYS use tools when available. If tools are provided in the request, you MUST use them to accomplish tasks. NEVER describe what you would do — actually DO it by calling the appropriate tool.
2. NEVER end your turn prematurely. If you have been given a task and tools are available, you must continue calling tools until the task is fully complete. Do NOT stop with a summary of what needs to be done.
3. Tool call format is critical. When calling tools: Always provide valid JSON for tool arguments; Always include all required parameters; Never truncate or abbreviate tool arguments; Never wrap tool calls in markdown code blocks — use the actual tool calling mechanism.
4. After receiving tool results, continue working. When you receive a tool result: Analyze the result; Determine if more actions are needed; Call the next tool if the task isn't complete; Only provide a final text response when ALL work is done.
5. File operations must be precise: Read files before editing them; Use exact content matches when replacing text; Verify changes after making them; Never guess file contents — always read first.
6. Error handling: If a tool call fails: Analyze the error message; Retry with corrected parameters; Try an alternative approach if retry fails; Only report failure after exhausting all options.
`;

// ─── Main Export ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const config = {
      apiKey: env.NVIDIA_API_KEY,
      apiUrl: env.NVIDIA_API_URL || DEFAULT_API_URL,
      authToken: env.AUTH_TOKEN,

      // FIX: ANTHROPIC_MODEL no longer feeds into fallbackModel.
      // It was making fallbackModel === toolModel, so retries had no effect.
      fallbackModel: getPreferredModel(
        env.FALLBACK_MODEL || env.DEFAULT_MODEL || env.NVIDIA_DEFAULT_MODEL ||
        env.CLAUDE_CODE_DEFAULT_MODEL,
        DEFAULT_FALLBACK_MODEL,
      ),
      opusModel: getPreferredModel(
        env.OPUS_MODEL || env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.DEFAULT_OPUS_MODEL ||
        env.CLAUDE_CODE_OPUS_MODEL || DEFAULT_OPUS_MODEL,
        DEFAULT_OPUS_MODEL,
      ),
      sonnetModel: getPreferredModel(
        env.SONNET_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.DEFAULT_SONNET_MODEL ||
        env.CLAUDE_CODE_SONNET_MODEL || DEFAULT_SONNET_MODEL,
        DEFAULT_SONNET_MODEL,
      ),
      haikuModel: getPreferredModel(
        env.HAIKU_MODEL || env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.DEFAULT_HAIKU_MODEL ||
        env.CLAUDE_CODE_HAIKU_MODEL || DEFAULT_HAIKU_MODEL,
        DEFAULT_HAIKU_MODEL,
      ),
      toolModel: getPreferredModel(
        env.TOOL_MODEL || env.NVIDIA_TOOL_MODEL || env.ANTHROPIC_TOOL_MODEL ||
        env.CLAUDE_CODE_TOOL_MODEL || DEFAULT_TOOL_MODEL,
        DEFAULT_TOOL_MODEL,
      ),

      maxUpstreamRetries: normalizeRetryCount(env.NVIDIA_MAX_RETRIES, DEFAULT_MAX_UPSTREAM_RETRIES),
      retryBaseDelayMs: normalizeRetryDelayMs(env.NVIDIA_RETRY_BASE_DELAY_MS, DEFAULT_RETRY_BASE_DELAY_MS),
      upstreamTimeoutMs: normalizeUpstreamTimeoutMs(env.NVIDIA_UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS),

      enableSequentialSubagents: env.CLAUDE_CODE_USE_SEQUENTIAL_SUBAGENTS === 'true',
      enableExperimentalMcpCli: env.ENABLE_EXPERIMENTAL_MCP_CLI === 'true',
      enableClaudeCode: env.ENABLE_CLAUDE_CODE === 'true',
      claudeTimeoutMs: Number(env.CLAUDE_CODE_TIMEOUT_MS) || 300000,
    };

    const url = new URL(request.url);
    const claudeConfig = getClaudeCodeConfig(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: getEnhancedCorsHeaders() });
    }

    const authResult = await authenticateClaudeCodeRequest(request, config, claudeConfig);
    if (!authResult.success) return authResult.response;

    try {
      if (url.pathname === '/v1/messages' && request.method === 'POST') {
        return await handleEnhancedMessages(request, config, claudeConfig);
      }
      if (url.pathname === '/v1/messages/count_tokens' && request.method === 'POST') {
        return await handleCountTokens(request, config);
      }
      if (url.pathname === '/v1/models' && request.method === 'GET') {
        return await handleModels(config);
      }
      if (url.pathname === '/health' || url.pathname === '/') {
        return json({
          status: 'ok',
          version: '2.2',
          agent_support: 'enabled',
          claude_code: claudeConfig.enableClaudeCode,
          mcp_enabled: claudeConfig.enableExperimentalMcpCli,
          sequential_agents: claudeConfig.enableSequentialSubagents,
        });
      }
      return json({ error: { type: 'not_found', message: 'Endpoint not found' } }, 404);
    } catch (error) {
      console.error('Unhandled error:', error);
      return json({
        error: {
          type: 'internal_error',
          message: 'Internal server error',
          details: DEBUG ? error.stack : undefined,
        },
      }, 500);
    }
  },
};

// ─── Security ─────────────────────────────────────────────────────────────────
function constantTimeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = new TextEncoder().encode(String(a));
  const bufB = new TextEncoder().encode(String(b));
  if (bufA.length !== bufB.length) return false;
  let result = 0;
  for (let i = 0; i < bufA.length; i++) result |= bufA[i] ^ bufB[i];
  return result === 0;
}

function extractAuthToken(request) {
  const apiKey = request.headers.get('x-api-key');
  if (apiKey) return apiKey;
  const auth = request.headers.get('Authorization') || '';
  return auth.replace(/^Bearer\s+/i, '').trim();
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
    'Access-Control-Max-Age': '86400',
  };
}

function getEnhancedCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, PATCH, DELETE',
    'Access-Control-Allow-Headers': [
      'Content-Type', 'Authorization', 'x-api-key', 'anthropic-version',
      'x-claude-code-version', 'x-mcp-cli-version', 'x-agent-id', 'x-session-id',
      'x-permission-token', 'x-enforce-sequential', 'x-max-tokens',
      'x-tool-support', 'x-stream-timeout', 'x-windows-path', 'x-full-access',
    ].join(', '),
    'Access-Control-Expose-Headers': [
      'x-resolved-model', 'x-tool-support', 'x-agent-compatibility',
      'x-request-id', 'x-environment-config', 'x-agent-support-level',
      'x-tool-calls-count', 'x-windows-status', 'x-max-tokens-config', 'x-all-tools-enabled',
    ].join(', '),
    'Access-Control-Max-Age': '86400',
  };
}

// ─── Response Helpers ─────────────────────────────────────────────────────────
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...getCorsHeaders(), ...extraHeaders },
  });
}

// ─── Route Handlers ───────────────────────────────────────────────────────────
async function handleModels(config) {
  try {
    if (!config.apiKey) {
      return json({ error: { type: 'authentication_error', message: 'NVIDIA_API_KEY not configured' } }, 500);
    }
    const res = await fetch(`${config.apiUrl}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error('NVIDIA models API error:', res.status, errorText);
      return json({ error: { type: 'api_error', message: 'Failed to fetch models' } }, res.status);
    }
    const data = await res.json();
    const anthropicModels = (data.data || []).map(m => ({
      type: 'model',
      id: m.id,
      display_name: m.id,
      created_at: m.created ? new Date(m.created * 1000).toISOString() : new Date().toISOString(),
    }));
    return json({
      data: anthropicModels,
      has_more: false,
      first_id: anthropicModels.length > 0 ? anthropicModels[0].id : null,
      last_id: anthropicModels.length > 0 ? anthropicModels[anthropicModels.length - 1].id : null,
    });
  } catch (err) {
    console.error('Models endpoint error:', err);
    return json({ error: { type: 'api_error', message: 'Failed to retrieve models' } }, 500);
  }
}

async function handleCountTokens(request, config) {
  try {
    const body = await request.json();
    let totalTokens = 0;
    if (body.messages && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg.content) {
          if (typeof msg.content === 'string') {
            totalTokens += Math.ceil(msg.content.length / 4);
          } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) {
                totalTokens += Math.ceil(block.text.length / 4);
              }
            }
          }
        }
      }
    }
    totalTokens = Math.max(1, Math.ceil(totalTokens * 1.15));
    return json({ input_tokens: totalTokens, output_tokens: 0 });
  } catch (err) {
    console.error('Count tokens error:', err);
    return json({ error: { type: 'api_error', message: 'Failed to count tokens' } }, 500);
  }
}

// ─── Main Message Handler ─────────────────────────────────────────────────────
async function handleMessages(request, config) {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  try {
    if (!config.apiKey) {
      logError(requestId, new Error('NVIDIA_API_KEY not configured'), { endpoint: '/v1/messages' });
      return json({ error: { type: 'authentication_error', message: 'NVIDIA_API_KEY not configured' } }, 500);
    }

    const requestBody = await request.json();
    logRequest(requestId, 'POST', '/v1/messages', {
      model: requestBody.model,
      stream: requestBody.stream,
      messageCount: requestBody.messages?.length || 0,
    });

    if (!requestBody.model) {
      return json({ error: { type: 'invalid_request_error', message: 'Missing required field: model' } }, 400);
    }
    if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
      return json({ error: { type: 'invalid_request_error', message: 'Missing or invalid messages field' } }, 400);
    }

    const requiresToolSupport = requestNeedsToolSupport(requestBody);
    let resolvedModel = resolveRequestedModel(requestBody.model, config, { requiresToolSupport });

    const estimatedPromptTokens = estimateRequestTokens(requestBody);
    const modelLimit = getModelContextLimit(resolvedModel);
    let requestedMaxTokens = normalizeMaxTokens(requestBody.max_tokens, modelLimit);

    if (estimatedPromptTokens + requestedMaxTokens > modelLimit) {
      const originalMax = requestedMaxTokens;
      requestedMaxTokens = Math.max(1024, modelLimit - estimatedPromptTokens - 500);
      logRequest(requestId, 'OPTIMIZE', 'context_pre_adjustment', {
        estimatedPrompt: estimatedPromptTokens,
        originalMax,
        adjustedMax: requestedMaxTokens,
        modelLimit,
      });
    }

    let openaiRequest = convertAnthropicToOpenAI(requestBody, resolvedModel, requestedMaxTokens);
    logRequest(requestId, 'CONVERT', 'anthropic->openai', {
      requestedModel: requestBody.model,
      resolvedModel,
      requiresToolSupport,
      estimatedPromptTokens,
      maxTokens: requestedMaxTokens,
      messageCount: openaiRequest.messages.length,
      hasTools: !!openaiRequest.tools,
    });

    if (requestBody.stream) {
      return handleStreamWithBackgroundFetch(openaiRequest, config, requestId, requestBody.model, {
        resolvedModel,
        requiresToolSupport,
        estimatedInputTokens: estimatedPromptTokens, // FIX: pass estimate for message_start
      });
    }

    let upstreamResult = await callNvidiaApiWithRetry(openaiRequest, config, requestId);
    let nvidiaResponse = upstreamResult.response;
    let errorText = upstreamResult.errorText;

    if (!nvidiaResponse.ok) {
      const isContextError = isContextLengthError(errorText);
      const retryModel = getFallbackRetryModel({
        status: nvidiaResponse.status,
        errorText,
        requestedModel: requestBody.model,
        resolvedModel,
        fallbackModel: config.fallbackModel,
        toolModel: config.toolModel,
        requiresToolSupport,
      });

      if (retryModel || isContextError) {
        logRequest(requestId, 'NVIDIA', 'retry_recovery', {
          reason: isContextError ? 'context_overflow' : 'model_failure',
          fromModel: resolvedModel,
          toModel: retryModel || resolvedModel,
        });
        if (retryModel) resolvedModel = retryModel;
        let retryMaxTokens = openaiRequest.max_tokens;
        if (isContextError) retryMaxTokens = Math.min(retryMaxTokens, 1024);

        openaiRequest = { ...openaiRequest, model: resolvedModel, max_tokens: retryMaxTokens };
        upstreamResult = await callNvidiaApiWithRetry(openaiRequest, config, requestId);
        nvidiaResponse = upstreamResult.response;
        errorText = upstreamResult.errorText;

        if (nvidiaResponse.ok) {
          logRequest(requestId, 'NVIDIA', 'retry_success', { resolvedModel, max_tokens: retryMaxTokens });
        }
      }

      if (!nvidiaResponse.ok) {
        logError(requestId, new Error(`NVIDIA API error: ${nvidiaResponse.status}`), {
          status: nvidiaResponse.status,
          requestedModel: requestBody.model,
          resolvedModel,
          response: errorText.slice(0, 500),
        });
        return json({
          error: {
            type: 'api_error',
            message: `NVIDIA API request failed: ${nvidiaResponse.status}`,
            details: buildUpstreamErrorDetails({ status: nvidiaResponse.status, errorText, resolvedModel, requiresToolSupport }),
          },
        }, nvidiaResponse.status, {
          'Retry-After': nvidiaResponse.headers.get('Retry-After') || '',
          'retry-after-ms': nvidiaResponse.headers.get('retry-after-ms') || '',
        });
      }
    }

    logRequest(requestId, 'NVIDIA', 'response_received', { stream: false });
    return await handleNonStreamResponse(nvidiaResponse, requestBody.model, requestId);
  } catch (error) {
    logError(requestId, error, { endpoint: '/v1/messages' });
    return json({ error: { type: 'internal_error', message: 'Internal error processing message' } }, 500);
  }
}

// ─── Streaming Handler ────────────────────────────────────────────────────────
function handleStreamWithBackgroundFetch(openaiRequest, config, requestId, requestedModel, options) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let resolvedModel = options.resolvedModel;

  // Keep-alive ping — NOT cleared until inside finalizeMessage so pings continue
  // during the entire stream processing phase, not just until upstream responds.
  const pingInterval = setInterval(async () => {
    try {
      await writer.write(encoder.encode(`event: ping\ndata: {"type": "ping"}\n\n`));
    } catch {
      clearInterval(pingInterval);
    }
  }, 5000);

  (async () => {
    try {
      // FIX: Send message_start with a real token estimate instead of zeros.
      // Claude Code uses input_tokens for context budget decisions.
      const estimatedInputTokens = options.estimatedInputTokens ||
        Math.ceil(JSON.stringify(openaiRequest.messages).length / 3.8) + 200;

      const initialMessageStart = {
        type: 'message_start',
        message: {
          id: `msg_${requestId}`,
          type: 'message',
          role: 'assistant',
          model: requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: estimatedInputTokens, output_tokens: 0 },
        },
      };
      await writer.write(encoder.encode(`event: message_start\ndata: ${JSON.stringify(initialMessageStart)}\n\n`));

      let upstreamResult = await callNvidiaApiWithRetry(openaiRequest, config, requestId);
      let nvidiaResponse = upstreamResult.response;
      let errorText = upstreamResult.errorText;

      if (!nvidiaResponse.ok) {
        const isContextError = isContextLengthError(errorText);
        const retryModel = getFallbackRetryModel({
          status: nvidiaResponse.status,
          errorText,
          requestedModel,
          resolvedModel,
          fallbackModel: config.fallbackModel,
          toolModel: config.toolModel,
          requiresToolSupport: options.requiresToolSupport,
        });

        if (retryModel || isContextError) {
          logRequest(requestId, 'NVIDIA', 'retry_recovery', {
            stream: true,
            reason: isContextError ? 'context_overflow' : 'model_failure',
          });
          if (retryModel) resolvedModel = retryModel;
          let retryMaxTokens = openaiRequest.max_tokens;
          if (isContextError) retryMaxTokens = Math.min(retryMaxTokens, 1024);

          openaiRequest = { ...openaiRequest, model: resolvedModel, max_tokens: retryMaxTokens };
          upstreamResult = await callNvidiaApiWithRetry(openaiRequest, config, requestId);
          nvidiaResponse = upstreamResult.response;
          errorText = upstreamResult.errorText;
        }

        if (!nvidiaResponse.ok) {
          clearInterval(pingInterval);
          logError(requestId, new Error(`NVIDIA API error: ${nvidiaResponse.status}`), {
            status: nvidiaResponse.status, requestedModel, resolvedModel,
            response: errorText.slice(0, 500),
          });
          const errorJson = JSON.stringify({
            type: 'error',
            error: {
              type: 'api_error',
              message: `NVIDIA API request failed: ${nvidiaResponse.status}`,
              details: buildUpstreamErrorDetails({
                status: nvidiaResponse.status, errorText, resolvedModel,
                requiresToolSupport: options.requiresToolSupport,
              }),
            },
          });
          await writer.write(encoder.encode(`event: error\ndata: ${errorJson}\n\n`));
          await writer.close();
          return;
        }
      }

      // FIX: Do NOT clear pingInterval here. Pass it into processNvidiaStreamBody
      // so it stays alive during stream processing and is cleared in finalizeMessage.
      logRequest(requestId, 'NVIDIA', 'response_received', { stream: true });
      await processNvidiaStreamBody(nvidiaResponse, requestedModel, requestId, writer, encoder, pingInterval);
    } catch (error) {
      clearInterval(pingInterval);
      logError(requestId, error, { endpoint: 'backgroundFetch' });
      const errorJson = JSON.stringify({
        type: 'error',
        error: { type: 'internal_error', message: 'Internal error processing message' },
      });
      try {
        await writer.write(encoder.encode(`event: error\ndata: ${errorJson}\n\n`));
        await writer.close();
      } catch (_e) { /* ignore write-after-close */ }
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...getCorsHeaders(),
    },
  });
}

// ─── Anthropic → OpenAI Conversion ───────────────────────────────────────────
function convertAnthropicToOpenAI(anthropicRequest, resolvedModel, maxTokens) {
  const messages = [];
  const toolState = createToolState();
  const hasTools = Array.isArray(anthropicRequest.tools) && anthropicRequest.tools.length > 0;

  let systemText = extractSystemText(anthropicRequest.system);

  // FIX: Only inject CLAUDE.md for actual agentic (tool-using) requests.
  // Injecting it unconditionally caused models to attempt tool calls when
  // none were available, stalling non-agentic conversations.
  if (hasTools && !systemText.includes('Agentic Coding Assistant Instructions')) {
    systemText = CLAUDE_MD_CONTENT + '\n\n' + systemText;
  }

  if (systemText.trim()) {
    messages.push({ role: 'system', content: systemText.trim() });
  }

  for (const msg of anthropicRequest.messages) {
    if (msg.role === 'user') {
      const userMessages = convertUserMessage(msg, toolState);
      messages.push(...userMessages);
    } else if (msg.role === 'assistant') {
      const assistantMessage = convertAssistantMessage(msg, toolState);
      if (assistantMessage) messages.push(assistantMessage);
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      messages.push({
        role: 'tool',
        tool_call_id: String(msg.tool_call_id),
        content: normalizeToolResultContent(msg.content, false),
      });
    }
  }

  // FIX: Use 0.2 temperature for tool turns — deterministic argument generation
  // reduces malformed JSON retries and speeds up the agentic loop.
  const defaultTemp = hasTools ? 0.2 : 1.0;

  return {
    model: resolvedModel,
    messages,
    max_tokens: maxTokens,
    temperature: Math.min(Math.max(anthropicRequest.temperature ?? defaultTemp, 0), 2),
    top_p: anthropicRequest.top_p,
    stream: !!anthropicRequest.stream,
    ...(hasTools && {
      tools: anthropicRequest.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.input_schema || { type: 'object', properties: {} },
        },
      })),
    }),
    ...(anthropicRequest.tool_choice && {
      tool_choice: convertToolChoice(anthropicRequest.tool_choice),
    }),
    ...(anthropicRequest.stop_sequences?.length && {
      stop: anthropicRequest.stop_sequences,
    }),
    ...((resolvedModel.includes('glm') || resolvedModel.includes('deepseek-r1')) && {
      chat_template_kwargs: { enable_thinking: true, clear_thinking: false },
    }),
  };
}

function normalizeMaxTokens(maxTokens, modelLimit = 131072) {
  if (maxTokens === undefined || maxTokens === null) return DEFAULT_MAX_TOKENS;
  const parsed = Number(maxTokens);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_TOKENS;
  return Math.min(Math.floor(parsed), modelLimit - 1000);
}

// ─── NVIDIA API Client ────────────────────────────────────────────────────────
async function callNvidiaApi(openaiRequest, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
  try {
    return await fetch(`${config.apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(openaiRequest),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function callNvidiaApiWithRetry(openaiRequest, config, requestId) {
  let attempt = 0;

  while (true) {
    let response;
    try {
      response = await callNvidiaApi(openaiRequest, config);
    } catch (error) {
      const isAbort = error?.name === 'AbortError' ||
        String(error?.message || '').toLowerCase().includes('aborted');
      const errorText = isAbort
        ? 'Upstream NVIDIA request timed out'
        : String(error?.message || error || 'Upstream NVIDIA request failed');

      logError(requestId, error, { function: 'callNvidiaApiWithRetry', attempt: attempt + 1 });

      if (attempt >= config.maxUpstreamRetries) {
        return {
          response: new Response(JSON.stringify({ error: { message: errorText } }), {
            status: 524,
            headers: { 'Content-Type': 'application/json' },
          }),
          errorText,
          attempts: attempt,
        };
      }
      const retryDelayMs = Math.min(
        computeRetryDelayMs(new Response(null, { status: 524 }), attempt, config.retryBaseDelayMs),
        MAX_RETRY_DELAY_MS,
      );
      await sleep(retryDelayMs);
      attempt += 1;
      continue;
    }

    if (response.ok) {
      return { response, errorText: '', attempts: attempt };
    }

    const errorText = await safeReadResponseText(response);

    // FIX: 429 is no longer in RETRYABLE_UPSTREAM_STATUS, so this is the ONLY
    // place 429 is handled. One retry at most, then give up fast.
    if (response.status === 429 && attempt < 1) {
      logRequest(requestId, 'NVIDIA', 'rate_limited_retry', { attempt: attempt + 1 });
      const retryDelayMs = computeRetryDelayMs(response, attempt, config.retryBaseDelayMs);
      await sleep(retryDelayMs);
      attempt += 1;
      continue;
    }

    if (!RETRYABLE_UPSTREAM_STATUS.has(response.status) || attempt >= config.maxUpstreamRetries) {
      return { response, errorText, attempts: attempt };
    }

    const retryDelayMs = computeRetryDelayMs(response, attempt, config.retryBaseDelayMs);
    logRequest(requestId, 'NVIDIA', 'retry_wait', {
      attempt: attempt + 1,
      status: response.status,
      delayMs: retryDelayMs,
    });
    await sleep(retryDelayMs);
    attempt += 1;
  }
}

function computeRetryDelayMs(response, attempt, baseDelayMs) {
  const headerDelayMs = parseRetryAfterMs(response.headers);
  if (headerDelayMs !== null) return Math.min(headerDelayMs, MAX_RETRY_DELAY_MS);
  return Math.min(baseDelayMs * (2 ** attempt), MAX_RETRY_DELAY_MS);
}

function parseRetryAfterMs(headers) {
  const retryAfterMs = headers?.get?.('retry-after-ms');
  if (retryAfterMs) {
    const parsed = Number.parseFloat(retryAfterMs);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.ceil(parsed);
  }
  const retryAfter = headers?.get?.('retry-after');
  if (!retryAfter) return null;
  const asSeconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return Math.ceil(asSeconds * 1000);
  const asDateMs = Date.parse(retryAfter) - Date.now();
  if (Number.isFinite(asDateMs) && asDateMs > 0) return Math.ceil(asDateMs);
  return null;
}

async function safeReadResponseText(response) {
  try { return await response.text(); } catch { return ''; }
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Model Resolution ─────────────────────────────────────────────────────────
function resolveRequestedModel(requestedModel, config, options = {}) {
  const { requiresToolSupport = false } = options;
  const model = String(requestedModel || '').trim();
  const normalized = model.toLowerCase();

  let resolved = model;
  if (isAnthropicFamilyModel(normalized, 'opus')) {
    resolved = config.opusModel;
  } else if (isAnthropicFamilyModel(normalized, 'sonnet')) {
    resolved = config.sonnetModel;
  } else if (isAnthropicFamilyModel(normalized, 'haiku')) {
    resolved = config.haikuModel;
  }

  if (isRetiredOrUnavailableModel(resolved)) {
    resolved = config.fallbackModel;
  }

  if (requiresToolSupport && config.toolModel && !isModelToolCapable(resolved)) {
    logRequest('MODEL', 'SELECT', 'tool_routing', {
      from: resolved,
      to: config.toolModel,
      reason: 'tool_support_required',
    });
    return config.toolModel;
  }

  return resolved;
}

function getFallbackRetryModel({ status, errorText, requestedModel, resolvedModel, fallbackModel, toolModel, requiresToolSupport }) {
  const text = String(errorText || '').toLowerCase();

  if (status === 429) {
    const rateLimitFallback = getRateLimitFallbackModel({ resolvedModel, fallbackModel, toolModel, requiresToolSupport });
    if (rateLimitFallback) {
      logRequest('RETRY', 'MODEL', 'rate_limit_retry', {
        requestedModel,
        from: resolvedModel,
        to: rateLimitFallback,
        status,
      });
      return rateLimitFallback;
    }
  }

  // Tool errors → retry with a dedicated tool-capable model
  if (requiresToolSupport && toolModel && resolvedModel !== toolModel && isToolSupportError(status, text)) {
    logRequest('RETRY', 'MODEL', 'tool_error_retry', { from: resolvedModel, to: toolModel, status });
    return toolModel;
  }

  if (!fallbackModel || (status !== 404 && status !== 410)) return null;
  if (resolvedModel === fallbackModel) return null;

  // FIX: Replaced `text.includes('model')` which matched practically every error.
  // Now only triggers on unambiguous model-availability error phrases.
  const modelLikelyUnavailable =
    text.includes('404 page not found') ||
    text.includes('end of life') ||
    text.includes('model not found') ||
    text.includes('model unavailable') ||
    text.includes('no such model') ||
    isRetiredOrUnavailableModel(resolvedModel);

  return modelLikelyUnavailable ? fallbackModel : null;
}

function getRateLimitFallbackModel({ resolvedModel, fallbackModel, toolModel, requiresToolSupport }) {
  const candidates = [fallbackModel, toolModel];
  const normalizedResolved = String(resolvedModel || '').trim().toLowerCase();

  for (const candidate of candidates) {
    const normalizedCandidate = String(candidate || '').trim().toLowerCase();
    if (!normalizedCandidate || normalizedCandidate === normalizedResolved) continue;
    if (requiresToolSupport && !isModelToolCapable(normalizedCandidate)) continue;
    return candidate;
  }

  return null;
}

// FIX: The original code had three bare `startsWith('claude-opus')` etc. branches
// that completely ignored the `family` parameter, causing ALL claude- models
// to match ALL families simultaneously. Now each branch correctly uses `family`.
function isAnthropicFamilyModel(normalizedModel, family) {
  if (!normalizedModel) return false;
  return (
    normalizedModel === family ||
    normalizedModel.startsWith(`claude-${family}`) ||
    normalizedModel.startsWith(`claude-3-${family}`) ||
    normalizedModel.startsWith(`claude-3-5-${family}`) ||
    normalizedModel.startsWith(`claude-3-7-${family}`) ||
    normalizedModel.includes(`-${family}-`)
  );
}

function isRetiredOrUnavailableModel(model) {
  return RETIRED_OR_UNAVAILABLE_MODELS.has(String(model || '').trim().toLowerCase());
}

// ─── Claude Code Helpers ──────────────────────────────────────────────────────
function isClaudeCodeRequest(request) {
  const userAgent = request.headers.get('User-Agent') || '';
  const headers = request.headers;
  return (
    userAgent.includes('Claude') || userAgent.includes('claude-code') || userAgent.includes('Anthropic') ||
    headers.has('x-claude-code-version') || headers.has('x-mcp-cli-version') ||
    headers.has('x-agent-id') || headers.has('x-session-id') || headers.has('anthropic-version')
  );
}

function getClaudeCodeConfig(env) {
  return {
    enableSequentialSubagents: env.CLAUDE_CODE_USE_SEQUENTIAL_SUBAGENTS === 'true',
    enableExperimentalMcpCli: env.ENABLE_EXPERIMENTAL_MCP_CLI === 'true',
    enableClaudeCode: env.ENABLE_CLAUDE_CODE === 'true',
    claudeTimeoutMs: Number(env.CLAUDE_CODE_TIMEOUT_MS) || 300000,
    memoryDir: env.CLAUDE_CODE_MEMORY_DIR || './.claude/memory',
    enableFullToolAccess: env.ENABLE_FULL_TOOL_ACCESS === 'true',
    windowsPathSupport: env.ENABLE_WINDOWS_PATH_SUPPORT === 'true',
  };
}

// FIX: Removed process.version / process.platform / process.arch — these do
// not exist in Cloudflare Workers and caused a hard ReferenceError crash on
// every response when ENABLE_CLAUDE_CODE=true.
function addAgentCompatibilityHeaders(response, config, claudeConfig) {
  const enhancedHeaders = new Headers(response.headers);
  enhancedHeaders.set('x-agent-support-level', claudeConfig.enableClaudeCode ? 'full' : 'basic');
  enhancedHeaders.set('x-tool-support-enabled', 'true');
  enhancedHeaders.set('x-mcp-enabled', claudeConfig.enableExperimentalMcpCli ? 'true' : 'false');
  enhancedHeaders.set('x-sequential-subagents', claudeConfig.enableSequentialSubagents ? 'true' : 'false');
  enhancedHeaders.set('x-windows-path-support', claudeConfig.windowsPathSupport ? 'enabled' : 'disabled');
  enhancedHeaders.set('x-full-tool-access', claudeConfig.enableFullToolAccess ? 'enabled' : 'disabled');
  return new Response(response.body, { status: response.status, headers: enhancedHeaders });
}

async function authenticateClaudeCodeRequest(request, config, claudeConfig) {
  const authToken = extractAuthToken(request);
  const isClaudeCode = isClaudeCodeRequest(request);

  if (!config.apiKey && !config.authToken) {
    if (DEBUG && isClaudeCode) {
      console.warn('WARNING: Allowing unauthenticated Claude Code request in debug mode');
      return { success: true };
    }
    return {
      success: false,
      response: json({ error: { type: 'authentication_error', message: 'Missing NVIDIA_API_KEY or AUTH_TOKEN' } }, 500),
    };
  }

  if (config.apiKey && !config.apiKey.trim()) {
    return {
      success: false,
      response: json({ error: { type: 'authentication_error', message: 'Invalid NVIDIA_API_KEY' } }, 401),
    };
  }

  if (config.authToken && !config.authToken.trim()) {
    return {
      success: false,
      response: json({ error: { type: 'authentication_error', message: 'Invalid AUTH_TOKEN' } }, 401),
    };
  }

  return { success: true };
}

async function handleEnhancedMessages(request, config, claudeConfig) {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  try {
    const response = await handleMessages(request, config);
    if (claudeConfig.enableClaudeCode) {
      return addAgentCompatibilityHeaders(response, config, claudeConfig);
    }
    return response;
  } catch (error) {
    logError(requestId, error, { endpoint: '/v1/messages (enhanced)' });
    const errorResponse = json({ error: { type: 'internal_error', message: 'Internal error processing message' } }, 500);
    if (claudeConfig.enableClaudeCode) {
      return addAgentCompatibilityHeaders(errorResponse, config, claudeConfig);
    }
    return errorResponse;
  }
}

// ─── Normalizers ──────────────────────────────────────────────────────────────
function getPreferredModel(model, fallback) {
  const candidate = String(model || '').trim();
  if (!candidate) return fallback;
  if (isRetiredOrUnavailableModel(candidate)) return fallback;
  return candidate;
}

function normalizeRetryCount(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 0), 5);
}

function normalizeRetryDelayMs(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 100), 10000);
}

// FIX: Hard cap raised from 120,000ms (2 min) to 3,600,000ms (1 hr) to match
// DEFAULT_UPSTREAM_TIMEOUT_MS. The old cap caused silent timeouts on long
// agentic tasks whenever an operator explicitly set NVIDIA_UPSTREAM_TIMEOUT_MS.
function normalizeUpstreamTimeoutMs(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 10000), 3600000);
}

// ─── Tool Support Detection ───────────────────────────────────────────────────
function requestNeedsToolSupport(anthropicRequest) {
  if (Array.isArray(anthropicRequest.tools) && anthropicRequest.tools.length > 0) return true;
  if (anthropicRequest.tool_choice && anthropicRequest.tool_choice.type !== 'none') return true;
  if (!Array.isArray(anthropicRequest.messages)) return false;
  for (const msg of anthropicRequest.messages) {
    if (msg?.role === 'tool') return true;
    if (!Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      if (!block?.type) continue;
      if (block.type === 'tool_use' || block.type === 'tool_result') return true;
    }
  }
  return false;
}

function isModelToolCapable(model) {
  return TOOL_CAPABLE_MODELS.has(String(model || '').trim().toLowerCase());
}

function isToolSupportError(status, text) {
  if (!text) return false;
  for (const pattern of TOOL_ERROR_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  const toolErrorStatuses = [400, 404, 422, 501, 503];
  if (toolErrorStatuses.includes(status) && (
    text.includes('tool') || text.includes('function') ||
    text.includes('mcp') || text.includes('calling')
  )) return true;
  return false;
}

function isContextLengthError(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return (
    t.includes('context length') ||
    t.includes('limit reached') ||
    t.includes('too many tokens') ||
    (t.includes('maximum') && t.includes('tokens') && t.includes('requested'))
  );
}

// ─── Tool State ───────────────────────────────────────────────────────────────
function createToolState() {
  return { pendingToolCallIds: [], nextSyntheticToolId: 0 };
}

function resolveToolCallId(id, toolState) {
  const normalized = firstNonEmptyString(id);
  if (normalized) return normalized;
  toolState.nextSyntheticToolId += 1;
  return `call_proxy_${Date.now()}_${toolState.nextSyntheticToolId}`;
}

function trackPendingToolCall(toolCallId, toolState) {
  if (!toolCallId) return;
  toolState.pendingToolCallIds.push(toolCallId);
}

function resolveToolResultCallId(block, toolState) {
  const explicitId = firstNonEmptyString(block.tool_use_id, block.tool_call_id, block.id);
  if (explicitId) {
    const idx = toolState.pendingToolCallIds.indexOf(explicitId);
    if (idx >= 0) toolState.pendingToolCallIds.splice(idx, 1);
    return explicitId;
  }
  const nextPending = toolState.pendingToolCallIds.shift();
  if (nextPending) return nextPending;
  return resolveToolCallId('', toolState);
}

function normalizeToolResultContent(content, isError) {
  let result;
  if (typeof content === 'string') {
    result = content;
  } else if (Array.isArray(content)) {
    result = content
      .map(part => (part?.type === 'text' && typeof part.text === 'string') ? part.text : safeJSONStringify(part))
      .join('\n');
  } else {
    result = safeJSONStringify(content ?? '');
  }
  if (isError && result && !result.toLowerCase().startsWith('tool error')) {
    return `Tool error: ${result}`;
  }
  return result;
}

// ─── Message Conversion ───────────────────────────────────────────────────────
function convertUserMessage(msg, toolState) {
  const messages = [];
  const userContent = [];

  if (typeof msg.content === 'string') return [{ role: 'user', content: msg.content }];
  if (!Array.isArray(msg.content)) return [];

  for (const block of msg.content) {
    if (!block || !block.type) continue;
    if (block.type === 'tool_result') {
      if (userContent.length > 0) {
        messages.push({ role: 'user', content: [...userContent] });
        userContent.length = 0;
      }
      const toolCallId = resolveToolResultCallId(block, toolState);
      const resultContent = normalizeToolResultContent(block.content, !!block.is_error);
      messages.push({ role: 'tool', tool_call_id: toolCallId, content: resultContent });
    } else if (block.type === 'text') {
      userContent.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      const imageContent = convertImageBlock(block);
      if (imageContent) userContent.push(imageContent);
    }
  }

  if (userContent.length > 0) messages.push({ role: 'user', content: userContent });
  return messages.length > 0 ? messages : [{ role: 'user', content: '' }];
}

function convertAssistantMessage(msg, toolState) {
  const textContent = [];
  const toolCalls = [];

  if (typeof msg.content === 'string') return { role: 'assistant', content: msg.content };
  if (!Array.isArray(msg.content)) return null;

  for (const block of msg.content) {
    if (!block || !block.type) continue;
    if (block.type === 'text') {
      textContent.push(block.text);
    } else if (block.type === 'thinking') {
      textContent.push(`[Thinking: ${block.thinking}]`);
    } else if (block.type === 'tool_use') {
      const toolCallId = resolveToolCallId(block.id, toolState);
      const toolName = firstNonEmptyString(block.name, `tool_${toolCalls.length}`);
      trackPendingToolCall(toolCallId, toolState);
      toolCalls.push({
        id: toolCallId,
        type: 'function',
        function: { name: toolName, arguments: safeJSONStringify(block.input ?? {}) },
      });
    }
  }

  const response = { role: 'assistant' };
  if (textContent.length > 0) response.content = textContent.join('\n');
  if (toolCalls.length > 0) response.tool_calls = toolCalls;
  return Object.keys(response).length > 1 ? response : null;
}

function convertImageBlock(block) {
  if (!block.source) return null;
  const { source } = block;
  if (source.type === 'base64') {
    try {
      if (typeof atob === 'function') atob(source.data);
      else if (typeof Buffer !== 'undefined') Buffer.from(source.data, 'base64').toString();
    } catch (err) {
      console.warn('Invalid base64 image data:', err.message);
      return null;
    }
    return {
      type: 'image_url',
      image_url: { url: `data:${source.media_type || 'image/jpeg'};base64,${source.data}` },
    };
  }
  if (source.type === 'url') {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

function convertToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  return undefined;
}

// ─── Non-Streaming Response ───────────────────────────────────────────────────
async function handleNonStreamResponse(nvidiaResponse, model, requestId) {
  try {
    const data = await nvidiaResponse.json();
    logRequest(requestId, 'RESPONSE', 'parse_complete', {
      hasChoices: !!data.choices,
      finishReason: data.choices?.[0]?.finish_reason,
    });

    if (!data.choices || !data.choices[0]) {
      logError(requestId, new Error('Invalid NVIDIA response'), { response: data });
      return json({ error: { type: 'api_error', message: 'Invalid response from NVIDIA API' } }, 500);
    }

    const choice = data.choices[0];
    const message = choice.message;
    const content = [];

    if (message.reasoning_content) {
      content.push({ type: 'thinking', thinking: message.reasoning_content });
    }

    if (message.content) {
      content.push({ type: 'text', text: message.content });
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      logRequest(requestId, 'RESPONSE', 'tool_calls', { count: message.tool_calls.length });
      for (const toolCall of message.tool_calls) {
        const toolName = toolCall.function?.name || 'unknown_tool';
        try {
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolName,
            input: safeParseJSON(toolCall.function?.arguments || '{}'),
          });
        } catch (err) {
          logError(requestId, err, { function: 'parseToolCall', toolName });
          content.push({ type: 'text', text: `[Tool error: Failed to parse arguments for ${toolName}]` });
        }
      }
    } else if (message.content) {
      // FIX: Old check matched `"name":` in any prose/JSON snippet, injecting phantom
      // tool calls. Now requires BOTH `"tool_use"` AND `"input"` to be present,
      // which is the actual structure of a serialized Anthropic tool_use block.
      const couldBeToolCall = message.content.includes('"tool_use"') && message.content.includes('"input"');
      if (couldBeToolCall) {
        const detectedTools = tryExtractToolsFromText(message.content);
        if (detectedTools.length > 0) {
          logRequest(requestId, 'REPAIR', 'text_tool_calls', { count: detectedTools.length });
          content.push(...detectedTools);
        }
      }
    }

    if (choice.finish_reason === 'content_filter') {
      content.push({ type: 'text', text: '[Content filtered - please adjust your request]' });
    }

    let stopReason = 'end_turn';
    if (choice.finish_reason === 'length') stopReason = 'max_tokens';
    if (choice.finish_reason === 'tool_calls' || message.tool_calls?.length) stopReason = 'tool_use';
    if (choice.finish_reason === 'content_filter') stopReason = 'end_turn';

    logRequest(requestId, 'RESPONSE', 'complete', {
      stopReason,
      contentBlocks: content.length,
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
    });

    return json({
      id: data.id || `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: content.length > 0 ? content : [{ type: 'text', text: '' }],
      model,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: data.usage?.prompt_tokens || 0,
        output_tokens: data.usage?.completion_tokens || 0,
      },
    });
  } catch (err) {
    logError(requestId, err, { endpoint: 'handleNonStreamResponse' });
    return json({ error: { type: 'api_error', message: 'Failed to process response' } }, 500);
  }
}

// ─── Streaming Response Processor ─────────────────────────────────────────────
// FIX: Now accepts `pingInterval` so it can be cleared inside finalizeMessage,
// keeping keep-alive pings active for the entire duration of stream processing.
async function processNvidiaStreamBody(nvidiaResponse, model, requestId, writer, encoder, pingInterval) {
  if (!nvidiaResponse.body) {
    clearInterval(pingInterval);
    logError(requestId, new Error('No response stream'), { endpoint: 'processNvidiaStreamBody' });
    const errJson = JSON.stringify({ error: { type: 'api_error', message: 'No response stream' } });
    await writer.write(encoder.encode(`event: error\ndata: ${errJson}\n\n`));
    await writer.close();
    return;
  }

  const streamState = {
    messageId: `msg_${Date.now()}`,
    nextBlockIndex: 0,
    currentBlock: null,
    toolStates: new Map(),
    finalStopReason: null,
    messageClosed: false,
    hasError: false,
  };

  const sendEvent = async (eventType, data) => {
    if (streamState.hasError) return;
    try {
      await writer.write(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch (err) {
      logError(requestId, err, { function: 'sendEvent', eventType });
      streamState.hasError = true;
    }
  };

  const closeBlock = async () => {
    if (streamState.currentBlock) {
      await sendEvent('content_block_stop', {
        type: 'content_block_stop',
        index: streamState.currentBlock.index,
      });
      streamState.currentBlock = null;
    }
  };

  const openBlock = async (blockType, blockData) => {
    await closeBlock();
    const index = streamState.nextBlockIndex++;
    streamState.currentBlock = { type: blockType, index };
    await sendEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: blockData,
    });
    return index;
  };

  // FIX: clearInterval moved here. Pings now stay alive through the entire
  // stream processing, preventing connection drops on long tool outputs.
  const finalizeMessage = async (stopReason, outputTokens) => {
    if (streamState.messageClosed || streamState.hasError) return;
    clearInterval(pingInterval);
    await closeBlock();
    await sendEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason || streamState.finalStopReason || 'end_turn' },
      usage: { output_tokens: outputTokens },
    });
    await sendEvent('message_stop', { type: 'message_stop' });
    streamState.messageClosed = true;
  };

  try {
    logRequest(requestId, 'STREAM', 'start', { model });
    const reader = nvidiaResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let chunkCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines[lines.length - 1];

      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line || line === ':') continue;

        if (line === '[DONE]' || line === 'data: [DONE]') {
          logRequest(requestId, 'STREAM', 'done', { chunks: chunkCount });
          await finalizeMessage(streamState.finalStopReason, chunkCount);
          await writer.close();
          return;
        }

        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6);
          if (dataStr === '[DONE]') continue;
          try {
            const chunkData = JSON.parse(dataStr);
            await processStreamChunk(chunkData, streamState, openBlock, closeBlock, sendEvent, requestId);
            chunkCount++;
          } catch (err) {
            logError(requestId, err, { function: 'parseChunk', preview: dataStr.slice(0, 100) });
          }
        }
      }
    }

    await finalizeMessage(streamState.finalStopReason, chunkCount);
    await writer.close();
    logRequest(requestId, 'STREAM', 'complete', { chunks: chunkCount });
  } catch (error) {
    clearInterval(pingInterval);
    logError(requestId, error, { function: 'streamHandler' });
    streamState.hasError = true;
    try { await writer.abort(error); } catch (_e) { /* ignore */ }
  }
}

// ─── Stream Chunk Processor ───────────────────────────────────────────────────
async function processStreamChunk(chunk, state, openBlock, closeBlock, sendEvent, requestId = '') {
  if (!chunk.choices || !chunk.choices[0]) return;

  const choice = chunk.choices[0];
  const delta = choice.delta || {};
  const finishReason = choice.finish_reason;

  if (delta.reasoning_content) {
    if (state.currentBlock?.type !== 'thinking') {
      await openBlock('thinking', { type: 'thinking', thinking: '' });
    }
    await sendEvent('content_block_delta', {
      type: 'content_block_delta',
      index: state.currentBlock.index,
      delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
    });
  }

  if (delta.content) {
    if (state.currentBlock?.type !== 'text') {
      await openBlock('text', { type: 'text', text: '' });
    }
    await sendEvent('content_block_delta', {
      type: 'content_block_delta',
      index: state.currentBlock.index,
      delta: { type: 'text_delta', text: delta.content },
    });
  }

  if (delta.tool_calls && delta.tool_calls.length > 0) {
    for (const toolCall of delta.tool_calls) {
      const toolIndex = toolCall.index ?? 0;
      let toolState = state.toolStates.get(toolIndex);

      if (!toolState) {
        // FIX: Buffer tool state — do NOT emit content_block_start yet.
        // The real id/name may not arrive on the first delta. Emitting a
        // synthetic ID now causes an ID mismatch that orphans all tool results.
        toolState = {
          id: null,
          name: null,
          argsBuffer: '',
          blockStarted: false,
          blockIndex: null,
          pendingArgChunks: [],
        };
        state.toolStates.set(toolIndex, toolState);
      }

      // Accumulate id and name as they arrive across deltas
      if (toolCall.id) toolState.id = toolCall.id;
      if (toolCall.function?.name) toolState.name = toolCall.function.name;

      // Only open the block once we have BOTH a confirmed real id AND name
      if (!toolState.blockStarted && toolState.id && toolState.name) {
        toolState.blockStarted = true;
        toolState.blockIndex = state.nextBlockIndex++;
        await closeBlock();
        await sendEvent('content_block_start', {
          type: 'content_block_start',
          index: toolState.blockIndex,
          content_block: {
            type: 'tool_use',
            id: toolState.id,
            name: toolState.name,
            input: {},
          },
        });
        state.currentBlock = { type: 'tool_use', index: toolState.blockIndex };
        logRequest(requestId, 'STREAM', 'tool_start', { name: toolState.name, id: toolState.id });

        // Flush any argument chunks that arrived before block was opened
        for (const chunk of toolState.pendingArgChunks) {
          await sendEvent('content_block_delta', {
            type: 'content_block_delta',
            index: toolState.blockIndex,
            delta: { type: 'input_json_delta', partial_json: chunk },
          });
        }
        toolState.pendingArgChunks = [];
      }

      if (toolCall.function?.arguments) {
        toolState.argsBuffer += toolCall.function.arguments;
        if (toolState.blockStarted) {
          await sendEvent('content_block_delta', {
            type: 'content_block_delta',
            index: toolState.blockIndex,
            delta: { type: 'input_json_delta', partial_json: toolCall.function.arguments },
          });
        } else {
          // Block not yet open — buffer the args until id+name both arrive
          toolState.pendingArgChunks.push(toolCall.function.arguments);
        }
      }
    }
  }

  if (finishReason) {
    await closeBlock();
    state.finalStopReason = mapFinishReason(finishReason);
    logRequest(requestId, 'STREAM', 'finish', {
      reason: finishReason,
      stopReason: state.finalStopReason,
      toolCount: state.toolStates.size,
    });
  }
}

function mapFinishReason(finishReason) {
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'tool_calls') return 'tool_use';
  return 'end_turn';
}

// ─── Utility Functions ────────────────────────────────────────────────────────
function safeParseJSON(str) {
  if (typeof str !== 'string') return str;
  try { return JSON.parse(str); } catch { return str; }
}

function safeJSONStringify(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value ?? {}); } catch { return String(value ?? ''); }
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return '';
}

function extractSystemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system.trim();
  if (Array.isArray(system)) {
    return system
      .filter(block => block && block.type === 'text' && block.text)
      .map(block => block.text)
      .join('\n\n')
      .trim();
  }
  return '';
}

function buildUpstreamErrorDetails({ status, errorText, resolvedModel, requiresToolSupport }) {
  const text = String(errorText || '');
  const details = [];
  if (status) details.push(`HTTP ${status}`);
  if (requiresToolSupport) {
    if (!isModelToolCapable(resolvedModel)) {
      details.push(`Model '${resolvedModel}' may not support tools/MCP. Consider setting TOOL_MODEL to '${DEFAULT_TOOL_MODEL}'`);
    } else if (isToolSupportError(status, text.toLowerCase())) {
      details.push(`Tool/MCP error detected - model '${resolvedModel}' failed to process tools`);
    }
  }
  if (text && text.length > 0) {
    const truncatedError = text.slice(0, 150).replace(/\n/g, ' ').trim();
    details.push(`Upstream: ${truncatedError}${text.length > 150 ? '...' : ''}`);
  }
  return details.join(' | ') || 'Unknown upstream error';
}

function estimateRequestTokens(request) {
  let tokens = 200;
  if (request.system) {
    const text = extractSystemText(request.system);
    tokens += Math.ceil(text.length / 3.8);
  }
  if (request.messages) {
    for (const msg of request.messages) {
      tokens += 4;
      if (typeof msg.content === 'string') {
        tokens += Math.ceil(msg.content.length / 3.8);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            tokens += Math.ceil(block.text.length / 3.8);
          } else if (block.type === 'tool_use' || block.type === 'tool_result') {
            tokens += 100;
            tokens += Math.ceil(safeJSONStringify(block).length / 3.8);
          }
        }
      }
    }
  }
  return tokens;
}

function getModelContextLimit(model) {
  const normalized = String(model || '').toLowerCase();
  for (const [key, limit] of Object.entries(ESTIMATED_MODEL_LIMITS)) {
    if (key !== 'default' && normalized.startsWith(key)) return limit;
  }
  return ESTIMATED_MODEL_LIMITS.default;
}

function tryExtractToolsFromText(text) {
  const tools = [];
  try {
    const codeBlockRegex = /```(?:json|tool_use)?\s*([\s\S]*?)```/g;
    let blockMatch;
    while ((blockMatch = codeBlockRegex.exec(text)) !== null) {
      const content = blockMatch[1].trim();
      try {
        const parsed = JSON.parse(content);
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        for (const cand of candidates) {
          if (cand.name && cand.input) {
            tools.push({
              type: 'tool_use',
              id: `call_repaired_${Date.now()}_${tools.length}`,
              name: cand.name,
              input: cand.input,
            });
          }
        }
      } catch (_e) { /* ignore non-JSON code blocks */ }
    }

    if (tools.length === 0) {
      const jsonRegex = /\{(?:[^{}]|\{[^{}]*\})*\}/g;
      let match;
      while ((match = jsonRegex.exec(text)) !== null) {
        try {
          const parsed = JSON.parse(match[0]);
          if (parsed.name && parsed.input) {
            tools.push({
              type: 'tool_use',
              id: `call_repaired_${Date.now()}_${tools.length}`,
              name: parsed.name,
              input: parsed.input,
            });
          }
        } catch (_e) { /* ignore */ }
      }
    }
  } catch (err) {
    console.error('Error in tryExtractToolsFromText:', err);
  }
  return tools;
}

function logRequest(requestId, method, path, details = {}) {
  if (DEBUG) {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), requestId, method, path, ...details }));
  }
}

function logError(requestId, error, context = {}) {
  if (DEBUG) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId,
      error: error.message || String(error),
      stack: error.stack,
      ...context,
    }));
  }
}
