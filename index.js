const DEFAULT_MAX_TOKENS = 131072; // Unlimited context window (max supported by most modern models)
const DEFAULT_API_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_OPUS_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const DEFAULT_SONNET_MODEL = 'qwen/qwen3-next-80b-a3b-instruct'; // Replaced minimax because it's not responding
const DEFAULT_HAIKU_MODEL = 'z-ai/glm-4.7';
const DEFAULT_FALLBACK_MODEL = 'qwen/qwen3-next-80b-a3b-instruct';
const DEFAULT_TOOL_MODEL = 'moonshotai/kimi-k2-instruct-0905';
const DEFAULT_MAX_UPSTREAM_RETRIES = 2; // Reduced from 3 to fail faster if dead
const DEFAULT_RETRY_BASE_DELAY_MS = 300; // Slightly increased for better 429 handling
const DEFAULT_UPSTREAM_TIMEOUT_MS = 3600000; // 1 hour timeout for unlimited response times
const MAX_RETRY_DELAY_MS = 15000;
// 429 (rate limit) and specific 4xx - now including 429 for limited retries
const RETRYABLE_UPSTREAM_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524]);
const DEBUG = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEBUG === 'true');

// Models known to have robust MCP/tool support
const TOOL_CAPABLE_MODELS = new Set([
  'moonshotai/kimi-k2.5',
  'moonshotai/kimi-k2-instruct-0905',
  'minimaxai/minimax-m2.7',
  'minimax/minimax-01', // Added current NVIDIA Minimax model
  'qwen/qwen3-next-80b-a3b-instruct',
  'nvidia/nemotron-3-super-120b-a12b',
  'qwen/qwen3-next-80b-a3b-instruct',
  'z-ai/glm-4.7',
  'deepseek-ai/deepseek-v3',
  'deepseek-ai/deepseek-r1',
]);


// Estimated context limits for proactive token management
const ESTIMATED_MODEL_LIMITS = {
  'meta/llama-3.1': 131072,
  'meta/llama-3.2': 131072,
  'meta/llama-3.3': 131072,
  'mistralai/mistral-large': 131072,
  'qwen/qwen2.5': 131072,
  'deepseek-ai/deepseek-v3': 131072,
  'z-ai/glm': 131072,
  'default': 131072
};

const RETIRED_OR_UNAVAILABLE_MODELS = new Set([
  'minimaxai/minimax-m2.1',
  // Removed minimax-m2.7 from retired list to give it another chance with longer timeouts
]);


// Tool/MCP error patterns for detection
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
  /.*maximum.*context.*length.*/i,
  /.*context.*limit.*reached.*/i,
  /.*too.*many.*tokens.*/i,
];

/**
 * Enhanced NVIDIA NIM Anthropic API Proxy
 * Converts Anthropic API format to NVIDIA OpenAI-compatible format
 */
export default {
  async fetch(request, env) {
    // Enhanced environment variables with CLAUDE_CODE support
    const config = {
      // Standard NVIDIA configurations
      apiKey: env.NVIDIA_API_KEY,
      apiUrl: env.NVIDIA_API_URL || DEFAULT_API_URL,
      authToken: env.AUTH_TOKEN,

      // Model configurations with CLAUDE_CODE fallbacks
      fallbackModel: getPreferredModel(
        env.FALLBACK_MODEL || env.DEFAULT_MODEL || env.NVIDIA_DEFAULT_MODEL ||
        env.CLAUDE_CODE_DEFAULT_MODEL || env.ANTHROPIC_MODEL,
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
        env.SONNET_MODEL || env.CLAUDE_CODE_TOOL_MODEL || DEFAULT_TOOL_MODEL,
        DEFAULT_TOOL_MODEL,
      ),

      // Request handling settings
      maxUpstreamRetries: normalizeRetryCount(env.NVIDIA_MAX_RETRIES, DEFAULT_MAX_UPSTREAM_RETRIES),
      retryBaseDelayMs: normalizeRetryDelayMs(env.NVIDIA_RETRY_BASE_DELAY_MS, DEFAULT_RETRY_BASE_DELAY_MS),
      upstreamTimeoutMs: normalizeUpstreamTimeoutMs(env.NVIDIA_UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS),

      // CLAUDE_CODE specific settings
      enableSequentialSubagents: env.CLAUDE_CODE_USE_SEQUENTIAL_SUBAGENTS === 'true',
      enableExperimentalMcpCli: env.ENABLE_EXPERIMENTAL_MCP_CLI === 'true',
      enableClaudeCode: env.ENABLE_CLAUDE_CODE === 'true',
      claudeTimeoutMs: Number(env.CLAUDE_CODE_TIMEOUT_MS) || 300000,
    };

    const url = new URL(request.url);
    const claudeConfig = getClaudeCodeConfig(env);

    // Enhanced CORS handling for agent support
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: getEnhancedCorsHeaders(),
      });
    }

    // Enhanced authentication check with logging and CLAUDE_CODE support
    const authResult = await authenticateClaudeCodeRequest(request, config, claudeConfig);
    if (!authResult.success) {
      return authResult.response;
    }

    // Route handling with enhanced logging
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
          version: '2.1',
          agent_support: 'enabled',
          claude_code: claudeConfig.enableClaudeCode,
          mcp_enabled: claudeConfig.enableExperimentalMcpCli,
          sequential_agents: claudeConfig.enableSequentialSubagents
        });
      }

      return json({ error: { type: 'not_found', message: 'Endpoint not found' } }, 404);
    } catch (error) {
      console.error('Unhandled error:', error);
      return json({
        error: {
          type: 'internal_error',
          message: 'Internal server error',
          details: DEBUG ? error.stack : undefined
        }
      }, 500);
    }
  },
};

/**
 * Security utility: Constant-time comparison to prevent timing attacks
 */
function constantTimeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = new TextEncoder().encode(String(a));
  const bufB = new TextEncoder().encode(String(b));
  if (bufA.length !== bufB.length) return false;
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

/**
 * Extract authentication token from request headers
 */
function extractAuthToken(request) {
  const apiKey = request.headers.get('x-api-key');
  if (apiKey) return apiKey;
  const auth = request.headers.get('Authorization') || '';
  return auth.replace(/^Bearer\s+/i, '').trim();
}

/**
 * Get CORS headers for responses
 */
function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Enhanced CORS headers for agent support with full tool access
 */
function getEnhancedCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, PATCH, DELETE',
    'Access-Control-Allow-Headers': [
      'Content-Type',
      'Authorization',
      'x-api-key',
      'anthropic-version',
      'x-claude-code-version',
      'x-mcp-cli-version',
      'x-agent-id',
      'x-session-id',
      'x-permission-token',
      'x-enforce-sequential',
      'x-max-tokens',
      'x-tool-support',
      'x-stream-timeout',
      'x-windows-path',
      'x-full-access'
    ].join(', '),
    'Access-Control-Expose-Headers': [
      'x-resolved-model',
      'x-tool-support',
      'x-agent-compatibility',
      'x-request-id',
      'x-environment-config',
      'x-agent-support-level',
      'x-tool-calls-count',
      'x-windows-status',
      'x-max-tokens-config',
      'x-all-tools-enabled'
    ].join(', '),
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * JSON response helper with optional headers
 */
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(),
      ...extraHeaders,
    },
  });
}

/**
 * Fetch models from NVIDIA API and convert to Anthropic format
 */
async function handleModels(config) {
  try {
    if (!config.apiKey) {
      return json({ error: { type: 'authentication_error', message: 'NVIDIA_API_KEY not configured' } }, 500);
    }

    const res = await fetch(`${config.apiUrl}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error('NVIDIA models API error:', res.status, errorText);
      return json({ error: { type: 'api_error', message: 'Failed to fetch models' } }, res.status);
    }

    const data = await res.json();

    // Transform OpenAI-style models response to Anthropic style
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

/**
 * Count tokens endpoint - estimates token count for messages
 */
async function handleCountTokens(request, config) {
  try {
    const body = await request.json();

    // Simple token estimation: approximately 4 chars per token
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

    // Add buffer for system prompt, formatting, etc.
    totalTokens = Math.max(1, Math.ceil(totalTokens * 1.15));

    return json({
      input_tokens: totalTokens,
      output_tokens: 0,
    });
  } catch (err) {
    console.error('Count tokens error:', err);
    return json({ error: { type: 'api_error', message: 'Failed to count tokens' } }, 500);
  }
}

/**
 * Main message handler - converts Anthropic request to NVIDIA format
 * Supports both streaming and non-streaming responses
 */
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

    // Validate required fields
    if (!requestBody.model) {
      logError(requestId, new Error('Missing model field'), { body: requestBody });
      return json({ error: { type: 'invalid_request_error', message: 'Missing required field: model' } }, 400);
    }
    if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
      logError(requestId, new Error('Invalid messages field'), { messages: requestBody.messages });
      return json({ error: { type: 'invalid_request_error', message: 'Missing or invalid messages field' } }, 400);
    }

    // Convert Anthropic format to OpenAI format (with model alias resolution)
    const requiresToolSupport = requestNeedsToolSupport(requestBody);
    let resolvedModel = resolveRequestedModel(requestBody.model, config, { requiresToolSupport });

    // Proactive context management: estimate tokens and adjust max_tokens if needed
    const estimatedPromptTokens = estimateRequestTokens(requestBody);
    const modelLimit = getModelContextLimit(resolvedModel);

    let requestedMaxTokens = normalizeMaxTokens(requestBody.max_tokens, modelLimit);

    // If prompt + max_tokens exceeds model limit, lower max_tokens immediately
    if (estimatedPromptTokens + requestedMaxTokens > modelLimit) {
      const originalMax = requestedMaxTokens;
      requestedMaxTokens = Math.max(1024, modelLimit - estimatedPromptTokens - 500); // 500 token safety buffer
      logRequest(requestId, 'OPTIMIZE', 'context_pre_adjustment', {
        estimatedPrompt: estimatedPromptTokens,
        originalMax,
        adjustedMax: requestedMaxTokens,
        modelLimit
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

    // If streaming, return stream immediately with background fetch and pings
    if (requestBody.stream) {
      return handleStreamWithBackgroundFetch(openaiRequest, config, requestId, requestBody.model, {
        resolvedModel,
        requiresToolSupport
      });
    }

    // Call NVIDIA API with bounded retries for transient upstream errors. (Non-streaming)
    let upstreamResult = await callNvidiaApiWithRetry(openaiRequest, config, requestId);
    let nvidiaResponse = upstreamResult.response;
    let errorText = upstreamResult.errorText;

    if (!nvidiaResponse.ok) {
      // Retry once with fallback model or reduced tokens for common failures.
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

        if (retryModel) {
          resolvedModel = retryModel;
        }

        let retryMaxTokens = openaiRequest.max_tokens;
        if (isContextError) {
          // Drastic reduction to attempt recovery from prompt+output > limit
          retryMaxTokens = Math.min(retryMaxTokens, 1024);
        }

        openaiRequest = {
          ...openaiRequest,
          model: resolvedModel,
          max_tokens: retryMaxTokens
        };

        upstreamResult = await callNvidiaApiWithRetry(openaiRequest, config, requestId);
        nvidiaResponse = upstreamResult.response;
        errorText = upstreamResult.errorText;

        if (nvidiaResponse.ok) {
          logRequest(requestId, 'NVIDIA', 'retry_success', {
            resolvedModel,
            max_tokens: retryMaxTokens
          });
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
            details: buildUpstreamErrorDetails({
              status: nvidiaResponse.status,
              errorText,
              resolvedModel,
              requiresToolSupport,
            }),
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

/**
 * Handle streaming natively with keep-alive pings to prevent 524 timeouts on Cloudflare Workers
 */
function handleStreamWithBackgroundFetch(openaiRequest, config, requestId, requestedModel, options) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let resolvedModel = options.resolvedModel;

  // Start ping interval (every 5 seconds) to maintain connection indefinitely
  const pingInterval = setInterval(async () => {
    try {
      await writer.write(encoder.encode(`event: ping\ndata: {"type": "ping"}\n\n`));
    } catch {
      clearInterval(pingInterval);
    }
  }, 5000);

  // Background execution of fetch and stream processing
  (async () => {
    try {
      // Send initial message_start immediately to satisfy client "first byte" timeouts
      const initialMessageStart = {
        type: 'message_start',
        message: {
          id: `msg_synthetic_${requestId}`,
          type: 'message',
          role: 'assistant',
          model: requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      };
      await writer.write(encoder.encode(`event: message_start\ndata: ${JSON.stringify(initialMessageStart)}\n\n`));

      let upstreamResult = await callNvidiaApiWithRetry(openaiRequest, config, requestId);
      let nvidiaResponse = upstreamResult.response;
      let errorText = upstreamResult.errorText;

      if (!nvidiaResponse.ok) {
        // Retry logic for streaming
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

          if (retryModel) {
            resolvedModel = retryModel;
          }

          let retryMaxTokens = openaiRequest.max_tokens;
          if (isContextError) {
            retryMaxTokens = Math.min(retryMaxTokens, 1024);
          }

          openaiRequest = {
            ...openaiRequest,
            model: resolvedModel,
            max_tokens: retryMaxTokens
          };

          upstreamResult = await callNvidiaApiWithRetry(openaiRequest, config, requestId);
          nvidiaResponse = upstreamResult.response;
          errorText = upstreamResult.errorText;
        }

        if (!nvidiaResponse.ok) {
          clearInterval(pingInterval);
          logError(requestId, new Error(`NVIDIA API error: ${nvidiaResponse.status}`), {
            status: nvidiaResponse.status,
            requestedModel,
            resolvedModel,
            response: errorText.slice(0, 500),
          });
          const errorDetails = buildUpstreamErrorDetails({
            status: nvidiaResponse.status,
            errorText,
            resolvedModel,
            requiresToolSupport: options.requiresToolSupport,
          });
          const errorJson = JSON.stringify({
            type: 'error',
            error: {
              type: 'api_error',
              message: `NVIDIA API request failed: ${nvidiaResponse.status}`,
              details: errorDetails
            }
          });
          clearInterval(pingInterval);
          await writer.write(encoder.encode(`event: error\ndata: ${errorJson}\n\n`));
          await writer.close();
          return;
        }
      }

      clearInterval(pingInterval);

      logRequest(requestId, 'NVIDIA', 'response_received', { stream: true });

      // Process the successful stream
      await processNvidiaStreamBody(nvidiaResponse, requestedModel, requestId, writer, encoder);
    } catch (error) {
      clearInterval(pingInterval);
      logError(requestId, error, { endpoint: 'backgroundFetch' });
      const errorJson = JSON.stringify({
        type: 'error',
        error: { type: 'internal_error', message: 'Internal error processing message' }
      });
      try {
        await writer.write(encoder.encode(`event: error\ndata: ${errorJson}\n\n`));
        await writer.close();
      } catch (e) { }
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

/**
 * Convert Anthropic request format to OpenAI format for NVIDIA API
 */
function convertAnthropicToOpenAI(anthropicRequest, resolvedModel, maxTokens) {
  const messages = [];
  const toolState = createToolState();

  // Handle system prompt (can be string or array of blocks)
  if (anthropicRequest.system) {
    const systemText = extractSystemText(anthropicRequest.system);
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  // Process each message in the conversation
  for (const msg of anthropicRequest.messages) {
    // Handle user messages (can contain text, images, and tool results)
    if (msg.role === 'user') {
      const userMessages = convertUserMessage(msg, toolState);
      messages.push(...userMessages);
    }
    // Handle assistant messages (can contain text and tool_use)
    else if (msg.role === 'assistant') {
      const assistantMessage = convertAssistantMessage(msg, toolState);
      if (assistantMessage) {
        messages.push(assistantMessage);
      }
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      // Preserve explicit OpenAI-style tool messages if clients send mixed formats.
      messages.push({
        role: 'tool',
        tool_call_id: String(msg.tool_call_id),
        content: normalizeToolResultContent(msg.content, false),
      });
    }
  }

  return {
    model: resolvedModel,
    messages,
    max_tokens: maxTokens,
    temperature: Math.min(Math.max(anthropicRequest.temperature ?? 1.0, 0), 2),
    top_p: anthropicRequest.top_p,
    stream: !!anthropicRequest.stream,
    ...(anthropicRequest.tools?.length && {
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
      chat_template_kwargs: { enable_thinking: true, clear_thinking: false }
    }),
  };
}

/**
 * Normalize max_tokens without imposing an artificial upper cap.
 */
function normalizeMaxTokens(maxTokens, modelLimit = 131072) {
  if (maxTokens === undefined || maxTokens === null) {
    return DEFAULT_MAX_TOKENS;
  }

  const parsed = Number(maxTokens);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_TOKENS;
  }

  // Allow unlimited context window - use the model's full capacity
  return Math.min(Math.floor(parsed), modelLimit - 1000);
}

/**
 * Execute NVIDIA chat completion request.
 */
async function callNvidiaApi(openaiRequest, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.upstreamTimeoutMs); // Configurable upstream timeout
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
      const isAbort = error?.name === 'AbortError' || String(error?.message || '').toLowerCase().includes('aborted');
      const errorText = isAbort ? 'Upstream NVIDIA request timed out' : String(error?.message || error || 'Upstream NVIDIA request failed');

      logError(requestId, error, {
        function: 'callNvidiaApiWithRetry',
        attempt: attempt + 1,
        retryable: true,
      });

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

      const retryDelayMs = Math.min(computeRetryDelayMs(new Response(null, { status: 524 }), attempt, config.retryBaseDelayMs), MAX_RETRY_DELAY_MS);
      logRequest(requestId, 'NVIDIA', 'retry_wait', {
        attempt: attempt + 1,
        status: 524,
        delayMs: retryDelayMs,
        reason: isAbort ? 'timeout' : 'network_error',
      });
      await sleep(retryDelayMs);
      attempt += 1;
      continue;
    }

    if (response.ok) {
      return { response, errorText: '', attempts: attempt };
    }

    const errorText = await safeReadResponseText(response);

    // Limited retry for rate limits (429)
    if (response.status === 429 && attempt < 1) {
      logRequest(requestId, 'NVIDIA', 'rate_limited_retry', { attempt: attempt + 1 });
      const retryDelayMs = computeRetryDelayMs(response, attempt, config.retryBaseDelayMs);
      await sleep(retryDelayMs);
      attempt += 1;
      continue;
    }


    // Skip retry if not retryable or max retries reached
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
  if (headerDelayMs !== null) {
    return Math.min(headerDelayMs, MAX_RETRY_DELAY_MS);
  }

  const exponential = baseDelayMs * (2 ** attempt);
  return Math.min(exponential, MAX_RETRY_DELAY_MS);
}

function parseRetryAfterMs(headers) {
  const retryAfterMs = headers?.get?.('retry-after-ms');
  if (retryAfterMs) {
    const parsed = Number.parseFloat(retryAfterMs);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.ceil(parsed);
    }
  }

  const retryAfter = headers?.get?.('retry-after');
  if (!retryAfter) {
    return null;
  }

  const asSeconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.ceil(asSeconds * 1000);
  }

  const asDateMs = Date.parse(retryAfter) - Date.now();
  if (Number.isFinite(asDateMs) && asDateMs > 0) {
    return Math.ceil(asDateMs);
  }

  return null;
}

async function safeReadResponseText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function sleep(ms) {
  if (!ms || ms <= 0) {
    return Promise.resolve();
  }

  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Resolve Anthropic model aliases (opus/sonnet/haiku) to live NVIDIA models.
 * Ensures tool-capable model is used when MCP/tools are required.
 */
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

  // Guarantee tool/MCP-capable behavior by routing tool-dependent turns to a known tool model.
  // This ensures that ANY model can use tools/MCP when the request includes them.
  if (requiresToolSupport && config.toolModel) {
    // Only switch if current model isn't known to support tools
    if (!isModelToolCapable(resolved)) {
      logRequest('MODEL', 'SELECT', 'tool_routing', {
        from: resolved,
        to: config.toolModel,
        reason: 'tool_support_required'
      });
      return config.toolModel;
    }
  }

  return resolved;
}

/**
 * Determine whether a model should be retried with fallback.
 * Enhanced to handle tool/MCP errors with better model selection.
 */
function getFallbackRetryModel({
  status,
  errorText,
  requestedModel,
  resolvedModel,
  fallbackModel,
  toolModel,
  requiresToolSupport,
}) {
  const text = String(errorText || '').toLowerCase();

  // Tool/MCP errors should retry with a tool-capable model
  if (requiresToolSupport && toolModel && resolvedModel !== toolModel && isToolSupportError(status, text)) {
    logRequest('RETRY', 'MODEL', 'tool_error_retry', {
      from: resolvedModel,
      to: toolModel,
      status,
      errorSnippet: text.slice(0, 100)
    });
    return toolModel;
  }

  // Retry with fallback only for model availability failures.
  // Do not switch models on 524 timeout errors because it causes random model behavior.
  if (!fallbackModel || (status !== 404 && status !== 410)) return null;
  if (resolvedModel === fallbackModel) return null;

  const modelLikelyUnavailable =
    text.includes('404 page not found') ||
    text.includes('end of life') ||
    text.includes('model') ||
    isRetiredOrUnavailableModel(resolvedModel) ||
    isAnthropicFamilyModel(String(requestedModel || '').toLowerCase(), 'opus') ||
    isAnthropicFamilyModel(String(requestedModel || '').toLowerCase(), 'sonnet') ||
    isAnthropicFamilyModel(String(requestedModel || '').toLowerCase(), 'haiku');

  return modelLikelyUnavailable ? fallbackModel : null;
}

function isAnthropicFamilyModel(normalizedModel, family) {
  if (!normalizedModel) return false;
  return normalizedModel === family || normalizedModel.startsWith(`claude-${family}`) ||
    normalizedModel.startsWith(`claude-3-${family}`) ||
    normalizedModel.startsWith(`claude-3-5-${family}`) ||
    normalizedModel.startsWith(`claude-3-7-${family}`) ||
    normalizedModel.startsWith(`claude-opus`) ||
    normalizedModel.startsWith(`claude-sonnet`) ||
    normalizedModel.startsWith(`claude-haiku`) ||
    normalizedModel.includes(`-${family}-`);
}

function isRetiredOrUnavailableModel(model) {
  return RETIRED_OR_UNAVAILABLE_MODELS.has(String(model || '').trim().toLowerCase());
}

// CLAUDE_CODE environment helper functions
function isClaudeCodeRequest(request) {
  const userAgent = request.headers.get('User-Agent') || '';
  const headers = request.headers;

  return userAgent.includes('Claude') ||
         userAgent.includes('claude-code') ||
         userAgent.includes('Anthropic') ||
         headers.has('x-claude-code-version') ||
         headers.has('x-mcp-cli-version') ||
         headers.has('x-agent-id') ||
         headers.has('x-session-id') ||
         headers.has('anthropic-version');
}

function getClaudeCodeConfig(env) {
  return {
    enableSequentialSubagents: env.CLAUDE_CODE_USE_SEQUENTIAL_SUBAGENTS === 'true',
    enableExperimentalMcpCli: env.ENABLE_EXPERIMENTAL_MCP_CLI === 'true',
    enableClaudeCode: env.ENABLE_CLAUDE_CODE === 'true',
    claudeTimeoutMs: Number(env.CLAUDE_CODE_TIMEOUT_MS) || 300000,
    memoryDir: env.CLAUDE_CODE_MEMORY_DIR || './.claude/memory',
    projectEnvVars: env.CLAUDE_CODE_PROJECT_ENV_VARS || '',
    enableFullToolAccess: env.ENABLE_FULL_TOOL_ACCESS === 'true',
    windowsPathSupport: env.ENABLE_WINDOWS_PATH_SUPPORT === 'true',
  };
}

function addAgentCompatibilityHeaders(response, config, claudeConfig) {
  const enhancedHeaders = new Headers(response.headers);

  // Add agent compatibility headers
  enhancedHeaders.set('x-agent-support-level', claudeConfig.enableClaudeCode ? 'full' : 'basic');
  enhancedHeaders.set('x-tool-support-enabled', 'true');
  enhancedHeaders.set('x-mcp-enabled', claudeConfig.enableExperimentalMcpCli ? 'true' : 'false');
  enhancedHeaders.set('x-sequential-subagents', claudeConfig.enableSequentialSubagents ? 'true' : 'false');
  enhancedHeaders.set('x-windows-path-support', claudeConfig.windowsPathSupport ? 'enabled' : 'disabled');
  enhancedHeaders.set('x-full-tool-access', claudeConfig.enableFullToolAccess ? 'enabled' : 'disabled');

  // Add environment info (non-sensitive)
  enhancedHeaders.set('x-node-version', process.version);
  enhancedHeaders.set('x-platform', process.platform);
  enhancedHeaders.set('x-architecture', process.arch);

  return new Response(response.body, {
    status: response.status,
    headers: enhancedHeaders,
  });
}

/**
 * Authenticate Claude Code requests with enhanced logging and agent support
 */
async function authenticateClaudeCodeRequest(request, config, claudeConfig) {
  // Extract authentication token
  const authToken = extractAuthToken(request);

  // Check if this is a Claude Code request
  const isClaudeCode = isClaudeCodeRequest(request);

  // Log authentication attempt for debugging
  if (DEBUG) {
    console.log(`Auth attempt: ${isClaudeCode ? 'Claude Code' : 'Standard'} request from ${request.headers.get('User-Agent') || 'unknown'}`);
  }

  // For Claude Code requests, we may have relaxed authentication in development
  // In production, we still require valid credentials
  if (!config.apiKey && !config.authToken) {
    // Only allow unauthenticated requests in debug mode for Claude Code
    if (DEBUG && isClaudeCode) {
      // Allow but log warning
      if (DEBUG) {
        console.warn('WARNING: Allowing unauthenticated Claude Code request in debug mode');
      }
      return { success: true };
    }

    return {
      success: false,
      response: json({ error: { type: 'authentication_error', message: 'Missing NVIDIA_API_KEY or AUTH_TOKEN' } }, 500)
    };
  }

  // Validate credentials if provided
  if (config.apiKey) {
    // Basic validation - in a real implementation, you might validate against NVIDIA API
    if (!config.apiKey.trim()) {
      return {
        success: false,
        response: json({ error: { type: 'authentication_error', message: 'Invalid NVIDIA_API_KEY' } }, 401)
      };
    }
  }

  if (config.authToken) {
    if (!config.authToken.trim()) {
      return {
        success: false,
        response: json({ error: { type: 'authentication_error', message: 'Invalid AUTH_TOKEN' } }, 401)
      };
    }
  }

  // Additional Claude Code specific validation
  if (isClaudeCode && claudeConfig.enableClaudeCode) {
    // Check for required Claude Code headers in debug mode
    if (DEBUG) {
      const versionHeader = request.headers.get('x-claude-code-version');
      const mcpHeader = request.headers.get('x-mcp-cli-version');
      if (versionHeader || mcpHeader) {
        console.log(`Claude Code detected: version=${versionHeader}, mcp=${mcpHeader}`);
      }
    }
  }

  return { success: true };
}

/**
 * Enhanced message handler with Claude Code specific features
 * Supports sequential subagents, experimental MCP CLI, and Windows path handling
 */
async function handleEnhancedMessages(request, config, claudeConfig) {
  // Delegate to the main handler but with enhanced logging and features
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  try {
    // Log Claude Code specific information
    if (claudeConfig.enableClaudeCode && DEBUG) {
      console.log(`Handling Claude Code request: sequential=${claudeConfig.enableSequentialSubagents}, mcp=${claudeConfig.enableExperimentalMcpCli}`);
    }

    // Process the request with the standard handler
    const response = await handleMessages(request, config);

    // Add agent compatibility headers to the response
    if (claudeConfig.enableClaudeCode) {
      return addAgentCompatibilityHeaders(response, config, claudeConfig);
    }

    return response;
  } catch (error) {
    logError(requestId, error, { endpoint: '/v1/messages (enhanced)' });

    // Return error response with agent compatibility headers
    const errorResponse = json({ error: { type: 'internal_error', message: 'Internal error processing message' } }, 500);

    if (claudeConfig.enableClaudeCode) {
      return addAgentCompatibilityHeaders(errorResponse, config, claudeConfig);
    }

    return errorResponse;
  }
}

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

function normalizeUpstreamTimeoutMs(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 10000), 120000);
}

function requestNeedsToolSupport(anthropicRequest) {
  // Check if tools array is present and non-empty
  if (Array.isArray(anthropicRequest.tools) && anthropicRequest.tools.length > 0) {
    return true;
  }

  // Check for explicit tool_choice that isn't 'none'
  if (anthropicRequest.tool_choice && anthropicRequest.tool_choice.type !== 'none') {
    return true;
  }

  // Check for stream option with tools (streaming tool calls need special handling)
  if (anthropicRequest.stream && anthropicRequest.tools?.length > 0) {
    return true;
  }

  if (!Array.isArray(anthropicRequest.messages)) {
    return false;
  }

  // Check messages for tool-related content
  for (const msg of anthropicRequest.messages) {
    // Direct tool role messages indicate tool use
    if (msg?.role === 'tool') {
      return true;
    }

    // Check content blocks for tool_use or tool_result
    if (!Array.isArray(msg?.content)) {
      continue;
    }

    for (const block of msg.content) {
      if (!block?.type) continue;
      if (block.type === 'tool_use' || block.type === 'tool_result') {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a model supports tools based on known capability list
 */
function isModelToolCapable(model) {
  const normalized = String(model || '').trim().toLowerCase();
  return TOOL_CAPABLE_MODELS.has(normalized);
}

/**
 * Enhanced tool support error detection - checks multiple error patterns
 */
function isToolSupportError(status, text) {
  if (!text) return false;

  // Check for tool-related error patterns
  for (const pattern of TOOL_ERROR_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }

  // Status codes commonly returned for tool support issues
  const toolErrorStatuses = [400, 404, 422, 501, 503];
  if (toolErrorStatuses.includes(status) && (
    text.includes('tool') ||
    text.includes('function') ||
    text.includes('mcp') ||
    text.includes('calling')
  )) {
    return true;
  }

  return false;
}

/**
 * Detect context length exceeded error
 */
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

function createToolState() {
  return {
    pendingToolCallIds: [],
    nextSyntheticToolId: 0,
  };
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
    if (idx >= 0) {
      toolState.pendingToolCallIds.splice(idx, 1);
    }
    return explicitId;
  }

  const nextPending = toolState.pendingToolCallIds.shift();
  if (nextPending) {
    return nextPending;
  }

  return resolveToolCallId('', toolState);
}

function normalizeToolResultContent(content, isError) {
  let result;
  if (typeof content === 'string') {
    result = content;
  } else if (Array.isArray(content)) {
    result = content
      .map(part => {
        if (part?.type === 'text' && typeof part.text === 'string') {
          return part.text;
        }
        return safeJSONStringify(part);
      })
      .join('\n');
  } else {
    result = safeJSONStringify(content ?? '');
  }

  if (isError && result && !result.toLowerCase().startsWith('tool error')) {
    return `Tool error: ${result}`;
  }

  return result;
}

function safeJSONStringify(value) {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value ?? '');
  }
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return '';
}

function buildUpstreamErrorDetails({ status, errorText, resolvedModel, requiresToolSupport }) {
  const text = String(errorText || '');
  const details = [];

  if (status) {
    details.push(`HTTP ${status}`);
  }

  if (requiresToolSupport) {
    if (!isModelToolCapable(resolvedModel)) {
      details.push(`Model '${resolvedModel}' may not support tools/MCP. Consider setting TOOL_MODEL to a capable model like '${DEFAULT_TOOL_MODEL}'`);
    } else if (isToolSupportError(status, text.toLowerCase())) {
      details.push(`Tool/MCP error detected - model '${resolvedModel}' failed to process tools`);
    }
  }

  // Include truncated error text if available
  if (text && text.length > 0) {
    const truncatedError = text.slice(0, 150).replace(/\n/g, ' ').trim();
    details.push(`Upstream: ${truncatedError}${text.length > 150 ? '...' : ''}`);
  }

  return details.join(' | ') || 'Unknown upstream error';
}

/**
 * Build a user-friendly error message for tool failures
 */
function buildToolErrorMessage(toolName, errorDetail) {
  const messages = [
    `Tool '${toolName || 'unknown'}' execution failed`,
  ];

  if (errorDetail) {
    messages.push(`Details: ${errorDetail}`);
  }

  messages.push('Consider: (1) Checking tool parameters, (2) Verifying API access, (3) Using a different model');

  return messages.join('. ');
}

/**
 * Extract system text from various formats
 */
function extractSystemText(system) {
  if (!system) return '';

  // Handle string format
  if (typeof system === 'string') {
    return system.trim();
  }

  // Handle array of content blocks
  if (Array.isArray(system)) {
    return system
      .filter(block => block && block.type === 'text' && block.text)
      .map(block => block.text)
      .join('\n\n')
      .trim();
  }

  return '';
}

/**
 * Convert Anthropic user message to OpenAI format
 * Splits tool results into separate "tool" role messages (Repo1 pattern)
 */
function convertUserMessage(msg, toolState) {
  const messages = [];
  const userContent = [];

  if (typeof msg.content === 'string') {
    // Simple string content
    return [{ role: 'user', content: msg.content }];
  }

  if (!Array.isArray(msg.content)) {
    return [];
  }

  // Process content blocks - separate tool results from other blocks
  for (const block of msg.content) {
    if (!block || !block.type) continue;

    // CRITICAL (from Repo1): Tool results must become separate "tool" role messages
    if (block.type === 'tool_result') {
      // Flush accumulated user content first
      if (userContent.length > 0) {
        messages.push({ role: 'user', content: [...userContent] });
        userContent.length = 0;
      }

      // Add tool result as separate message (OpenAI required format)
      const toolCallId = resolveToolResultCallId(block, toolState);
      const resultContent = normalizeToolResultContent(block.content, !!block.is_error);

      messages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: resultContent,
      });
    }
    // Text blocks
    else if (block.type === 'text') {
      userContent.push({ type: 'text', text: block.text });
    }
    // Image blocks
    else if (block.type === 'image') {
      const imageContent = convertImageBlock(block);
      if (imageContent) {
        userContent.push(imageContent);
      }
    }
  }

  // Add remaining user content
  if (userContent.length > 0) {
    messages.push({ role: 'user', content: userContent });
  }

  return messages.length > 0 ? messages : [{ role: 'user', content: '' }];
}

/**
 * Convert Anthropic assistant message to OpenAI format
 * Separates text content from tool_calls (OpenAI requires separate fields)
 */
function convertAssistantMessage(msg, toolState) {
  const textContent = [];
  const toolCalls = [];

  if (typeof msg.content === 'string') {
    return { role: 'assistant', content: msg.content };
  }

  if (!Array.isArray(msg.content)) {
    return null;
  }

  // Process content blocks - separate text from tool_calls
  for (const block of msg.content) {
    if (!block || !block.type) continue;

    if (block.type === 'text') {
      textContent.push(block.text);
    } else if (block.type === 'thinking') {
      // Some models support reasoning/thinking
      textContent.push(`[Thinking: ${block.thinking}]`);
    } else if (block.type === 'tool_use') {
      const toolCallId = resolveToolCallId(block.id, toolState);
      const toolName = firstNonEmptyString(block.name, `tool_${toolCalls.length}`);
      trackPendingToolCall(toolCallId, toolState);

      // Tool calls must be in separate field for OpenAI format
      toolCalls.push({
        id: toolCallId,
        type: 'function',
        function: {
          name: toolName,
          arguments: safeJSONStringify(block.input ?? {}),
        },
      });
    }
  }

  // Build response following OpenAI format
  const response = { role: 'assistant' };

  // Add text content if present
  if (textContent.length > 0) {
    response.content = textContent.join('\n');
  }

  // Add tool calls in separate field if present
  if (toolCalls.length > 0) {
    response.tool_calls = toolCalls;
  }

  // Return null if no content was added (shouldn't happen with valid messages)
  return Object.keys(response).length > 1 ? response : null;
}

/**
 * Convert image block from Anthropic to OpenAI format
 * Validates base64 (inspired by Repo4 security pattern)
 */
function convertImageBlock(block) {
  if (!block.source) return null;

  const { source } = block;

  // Handle base64 encoded images
  if (source.type === 'base64') {
    // Validate base64 before including (Repo4 pattern)
    try {
      if (typeof atob === 'function') {
        atob(source.data); // Validate in browser environment
      } else if (typeof Buffer !== 'undefined') {
        Buffer.from(source.data, 'base64').toString(); // Validate in Node environment
      }
      // If validation passes, include the image
    } catch (err) {
      console.warn('Invalid base64 image data:', err.message);
      return null;
    }

    const mediaType = source.media_type || 'image/jpeg';
    return {
      type: 'image_url',
      image_url: {
        url: `data:${mediaType};base64,${source.data}`,
      },
    };
  }

  // Handle URL-based images
  if (source.type === 'url') {
    return {
      type: 'image_url',
      image_url: { url: source.url },
    };
  }

  return null;
}

/**
 * Convert tool choice format from Anthropic to OpenAI
 */
function convertToolChoice(toolChoice) {
  if (!toolChoice) return undefined;

  if (toolChoice.type === 'auto') {
    return 'auto';
  }
  if (toolChoice.type === 'any') {
    return 'required';
  }
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } };
  }

  return undefined;
}

/**
 * Handle non-streaming OpenAI response and convert back to Anthropic format
 */
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

    // Build Anthropic response content
    const content = [];

    // Add reasoning/thinking if present
    if (message.reasoning_content) {
      content.push({ type: 'thinking', thinking: message.reasoning_content });
    }

    // Add text content
    if (message.content) {
      content.push({ type: 'text', text: message.content });
    }

    // Add tool uses with error handling
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
          content.push({
            type: 'text',
            text: `[Tool error: Failed to parse arguments for ${toolName}]`,
          });
        }
      }
    }

    // Check for errors in refusal or content
    if (choice.finish_reason === 'content_filter') {
      content.push({
        type: 'text',
        text: '[Content filtered - please adjust your request]',
      });
    }

    // Determine stop reason
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

/**
 * Process the NVIDIA response stream using an existing writer
 * Implements state machine pattern (inspired by Repo4 Go implementation)
 */
async function processNvidiaStreamBody(nvidiaResponse, model, requestId, writer, encoder) {
  if (!nvidiaResponse.body) {
    logError(requestId, new Error('No response stream'), { endpoint: 'processNvidiaStreamBody' });
    const errJson = JSON.stringify({ error: { type: 'api_error', message: 'No response stream' } });
    await writer.write(encoder.encode(`event: error\ndata: ${errJson}\n\n`));
    await writer.close();
    return;
  }

  // State machine for streaming (prevents event ordering issues)
  const streamState = {
    messageId: `msg_${Date.now()}`,
    nextBlockIndex: 0,
    currentBlock: null, // { type: 'text'|'tool_use', index: number }
    toolStates: new Map(), // index -> { id, name, argsBuffer, jsonSent }
    finalStopReason: null,
    messageClosed: false,
    hasError: false,
  };

  /**
   * Send an SSE event (from Repo4 pattern)
   */
  const sendEvent = async (eventType, data) => {
    if (streamState.hasError) return;
    try {
      const eventLine = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
      await writer.write(encoder.encode(eventLine));
    } catch (err) {
      logError(requestId, err, { function: 'sendEvent', eventType });
      streamState.hasError = true;
    }
  };

  /**
   * Close current content block
   */
  const closeBlock = async () => {
    if (streamState.currentBlock) {
      await sendEvent('content_block_stop', {
        type: 'content_block_stop',
        index: streamState.currentBlock.index,
      });
      streamState.currentBlock = null;
    }
  };

  /**
   * Assign and open new content block
   */
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

  /**
   * Finalize a stream exactly once.
   */
  const finalizeMessage = async (stopReason, outputTokens) => {
    if (streamState.messageClosed || streamState.hasError) return;

    await closeBlock();
    await sendEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason || streamState.finalStopReason || 'end_turn' },
      usage: { output_tokens: outputTokens },
    });
    await sendEvent('message_stop', { type: 'message_stop' });
    streamState.messageClosed = true;
  };

  // Initialize stream
  try {
    logRequest(requestId, 'STREAM', 'start', { model });

    // Initial message_start already sent by handleStreamWithBackgroundFetch

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
            logError(requestId, err, {
              function: 'parseChunk',
              preview: dataStr.slice(0, 100)
            });
          }
        }
      }
    }

    await finalizeMessage(streamState.finalStopReason, chunkCount);
    await writer.close();
    logRequest(requestId, 'STREAM', 'complete', { chunks: chunkCount });
  } catch (error) {
    logError(requestId, error, { function: 'streamHandler' });
    streamState.hasError = true;
    try {
      await writer.abort(error);
    } catch (e) {
      // Ignore abort errors
    }
  }
}

/**
 * Process individual streaming chunk
 * Handles text, tool calls, and finish reasons
 */
async function processStreamChunk(chunk, state, openBlock, closeBlock, sendEvent, requestId = '') {
  if (!chunk.choices || !chunk.choices[0]) return;

  const choice = chunk.choices[0];
  const delta = choice.delta || {};
  const finishReason = choice.finish_reason;

  // Handle reasoning content (thinking)
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

  // Handle text content
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

  // Handle tool calls (Repo4 pattern for proper state management)
  if (delta.tool_calls && delta.tool_calls.length > 0) {
    for (const toolCall of delta.tool_calls) {
      const toolIndex = toolCall.index ?? 0;
      let toolState = state.toolStates.get(toolIndex);

      if (!toolState) {
        // First delta for this tool - create state
        const toolName = toolCall.function?.name || `tool_${toolIndex}`;
        toolState = {
          id: toolCall.id || `call_${Date.now()}_${toolIndex}`,
          name: toolName,
          argsBuffer: '',
          jsonSent: false,
          blockIndex: null,
        };
        state.toolStates.set(toolIndex, toolState);

        // Open tool block
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
        logRequest(requestId, 'STREAM', 'tool_start', { name: toolState.name });
      }

      // Update tool state with new data
      if (toolCall.id && toolState.id.startsWith('call_')) {
        toolState.id = toolCall.id;
      }
      if (toolCall.function?.name) {
        toolState.name = toolCall.function.name;
      }

      // Handle arguments by sending deltas directly
      if (toolCall.function?.arguments) {
        await sendEvent('content_block_delta', {
          type: 'content_block_delta',
          index: toolState.blockIndex,
          delta: { type: 'input_json_delta', partial_json: toolCall.function.arguments },
        });
        toolState.argsBuffer += toolCall.function.arguments;
      }
    }
  }

  // Handle finish reason
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

/**
 * Map NVIDIA/OpenAI finish_reason values to Anthropic stop_reason values.
 */
function mapFinishReason(finishReason) {
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'stop') return 'end_turn';
  return 'end_turn';
}

/**
 * Safely parse JSON string, returning parsed object or the original string
 */
function safeParseJSON(str) {
  if (typeof str !== 'string') return str;
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

/**
 * Request logging helper (from Repo1 pattern)
 */
function logRequest(requestId, method, path, details = {}) {
  if (DEBUG) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId,
      method,
      path,
      ...details,
    }));
  }
}

/**
 * Error logging helper
 */
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
/**
 * Proactively estimate the number of tokens in a request
 * Very rough estimation: 4 chars per token + fixed overhead
 */
function estimateRequestTokens(request) {
  let tokens = 200; // Fixed overhead

  if (request.system) {
    const text = extractSystemText(request.system);
    tokens += Math.ceil(text.length / 3.8); // Slightly more conservative (lower divisor)
  }

  if (request.messages) {
    for (const msg of request.messages) {
      tokens += 4; // Overhead per message
      if (typeof msg.content === 'string') {
        tokens += Math.ceil(msg.content.length / 3.8);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            tokens += Math.ceil(block.text.length / 3.8);
          } else if (block.type === 'tool_use' || block.type === 'tool_result') {
            tokens += 100; // Block overhead
            tokens += Math.ceil(safeJSONStringify(block).length / 3.8);
          }
        }
      }
    }
  }

  return tokens;
}


/**
 * Get the estimated context limit for a model to prevent 400 errors
 */
function getModelContextLimit(model) {
  const normalized = String(model || '').toLowerCase();

  for (const [key, limit] of Object.entries(ESTIMATED_MODEL_LIMITS)) {
    if (key !== 'default' && normalized.startsWith(key)) {
      return limit;
    }
  }

  return ESTIMATED_MODEL_LIMITS.default;
}
