import {
  computeCost,
  countMessageTokens,
  estimateTokens,
  type AIProvider,
  type CompletionRequest,
  type CompletionResponse,
  type ModelInfo,
  type StreamChunk,
  type ToolCall,
} from './types.js';
import { upstreamFailure } from '../kernel/errors.js';

/**
 * OpenRouter provider.
 *
 * Registered only when `OPENROUTER_API_KEY` is present. ForgeOS never falls
 * back to a paid provider implicitly — if a hosted model is used, it is because
 * the operator configured one and the request named it.
 */
export interface OpenRouterOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly appUrl?: string;
  readonly appName?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** Cache of the model catalogue, in milliseconds. Default 10 minutes. */
  readonly catalogueTtlMs?: number;
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  description?: string;
}

interface OpenRouterChoice {
  message?: {
    content?: string | null;
    tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
  };
  delta?: { content?: string | null };
  finish_reason?: string | null;
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
  error?: { message?: string };
}

const FINISH_REASONS: Record<string, CompletionResponse['finishReason']> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  content_filter: 'stop',
};

export function createOpenRouterProvider(options: OpenRouterOptions): AIProvider {
  const baseUrl = (options.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const catalogueTtl = options.catalogueTtlMs ?? 600_000;

  let cachedModels: { at: number; models: ModelInfo[] } | null = null;

  const headers = (): Record<string, string> => ({
    authorization: `Bearer ${options.apiKey}`,
    'content-type': 'application/json',
    // OpenRouter uses these for attribution on its dashboard.
    ...(options.appUrl ? { 'HTTP-Referer': options.appUrl } : {}),
    ...(options.appName ? { 'X-Title': options.appName } : {}),
  });

  const toRequestBody = (request: CompletionRequest, stream: boolean): string =>
    JSON.stringify({
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      })),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: {
                  type: 'object',
                  properties: Object.fromEntries(
                    Object.entries(tool.parameters).map(([name, parameter]) => [
                      name,
                      {
                        type: parameter.type,
                        description: parameter.description,
                        ...(parameter.enum ? { enum: parameter.enum } : {}),
                        ...(parameter.items ? { items: parameter.items } : {}),
                      },
                    ])
                  ),
                  required: Object.entries(tool.parameters)
                    .filter(([, parameter]) => parameter.required)
                    .map(([name]) => name),
                },
              },
            })),
          }
        : {}),
      stream,
    });

  const findModel = async (id: string): Promise<ModelInfo | undefined> =>
    (await provider.models()).find((model) => model.id === id);

  const provider: AIProvider = {
    id: 'openrouter',

    async models() {
      if (cachedModels && now() - cachedModels.at < catalogueTtl) return cachedModels.models;

      const response = await fetchImpl(`${baseUrl}/models`, { headers: headers() });
      if (!response.ok) throw upstreamFailure('openrouter', `models: ${response.status}`);

      const body = (await response.json()) as { data?: OpenRouterModel[] };
      const models: ModelInfo[] = (body.data ?? []).map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        provider: 'openrouter',
        contextWindow: model.context_length ?? 8192,
        // OpenRouter quotes price per token; the product reports per million.
        inputCostPerMillion: Number(model.pricing?.prompt ?? 0) * 1_000_000,
        outputCostPerMillion: Number(model.pricing?.completion ?? 0) * 1_000_000,
        supportsTools: model.supported_parameters?.includes('tools') ?? false,
        supportsStreaming: true,
        local: false,
        ...(model.description ? { description: model.description } : {}),
      }));

      cachedModels = { at: now(), models };
      return models;
    },

    async complete(request) {
      const startedAt = now();
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: toRequestBody(request, false),
        ...(request.signal ? { signal: request.signal } : {}),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw upstreamFailure('openrouter', `${response.status}: ${detail.slice(0, 200)}`);
      }

      const body = (await response.json()) as OpenRouterResponse;
      if (body.error) throw upstreamFailure('openrouter', body.error.message);

      const choice = body.choices?.[0];
      const text = choice?.message?.content ?? '';

      const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((call, index) => ({
        id: call.id ?? `call_${index}`,
        name: call.function?.name ?? 'unknown',
        arguments: safeParseArguments(call.function?.arguments),
      }));

      const usage = {
        promptTokens: body.usage?.prompt_tokens ?? countMessageTokens(request.messages),
        completionTokens: body.usage?.completion_tokens ?? estimateTokens(text),
        totalTokens: body.usage?.total_tokens ?? 0,
      };
      const resolvedUsage = {
        ...usage,
        totalTokens: usage.totalTokens || usage.promptTokens + usage.completionTokens,
      };

      const model = await findModel(body.model ?? request.model);

      return {
        text,
        model: body.model ?? request.model,
        provider: 'openrouter',
        usage: resolvedUsage,
        costUsd: model ? computeCost(resolvedUsage, model) : 0,
        latencyMs: Math.max(1, now() - startedAt),
        finishReason: FINISH_REASONS[choice?.finish_reason ?? 'stop'] ?? 'stop',
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    },

    async *stream(request): AsyncIterable<StreamChunk> {
      const startedAt = now();
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: toRequestBody(request, true),
        ...(request.signal ? { signal: request.signal } : {}),
      });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        throw upstreamFailure('openrouter', `${response.status}: ${detail.slice(0, 200)}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let text = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Server-sent events are newline-delimited; a chunk may split a line.
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '' || payload === '[DONE]') continue;

          try {
            const event = JSON.parse(payload) as OpenRouterResponse;
            const delta = event.choices?.[0]?.delta?.content ?? '';
            if (delta === '') continue;
            text += delta;
            yield { delta, done: false };
          } catch {
            // A malformed keep-alive frame must not abort the stream.
          }
        }
      }

      const promptTokens = countMessageTokens(request.messages);
      const completionTokens = estimateTokens(text);
      const usage = {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };
      const model = await findModel(request.model).catch(() => undefined);

      yield {
        delta: '',
        done: true,
        response: {
          text,
          model: request.model,
          provider: 'openrouter',
          usage,
          costUsd: model ? computeCost(usage, model) : 0,
          latencyMs: Math.max(1, now() - startedAt),
          finishReason: 'stop',
        },
      };
    },
  };

  return provider;
}

function safeParseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
