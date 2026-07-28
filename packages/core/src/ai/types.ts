/**
 * The AI provider contract.
 *
 * Every ForgeOS feature that talks to a model goes through this interface, and
 * nothing in the product depends on a specific vendor. That is what makes the
 * offline default viable: `forge-local` implements the same contract as a
 * hosted model, so the assistant, the workflow engine and the evaluation
 * harness all work identically with or without an API key.
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  readonly role: MessageRole;
  readonly content: string;
  /** Tool name, when `role` is `tool`. */
  readonly name?: string;
  readonly toolCallId?: string;
}

export interface ToolParameter {
  readonly type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  readonly description: string;
  readonly enum?: readonly string[];
  readonly required?: boolean;
  readonly items?: { type: string };
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, ToolParameter>>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface CompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly tools?: readonly ToolDefinition[];
  readonly seed?: number;
  readonly signal?: AbortSignal;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface CompletionResponse {
  readonly text: string;
  readonly model: string;
  readonly provider: string;
  readonly usage: TokenUsage;
  /** Cost in USD. Always `0` for local providers — and that is the point. */
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly finishReason: 'stop' | 'length' | 'tool_calls' | 'error';
  readonly toolCalls?: readonly ToolCall[];
}

export interface StreamChunk {
  readonly delta: string;
  readonly done: boolean;
  readonly response?: CompletionResponse;
}

export interface ModelInfo {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly contextWindow: number;
  /** USD per million input tokens. */
  readonly inputCostPerMillion: number;
  /** USD per million output tokens. */
  readonly outputCostPerMillion: number;
  readonly supportsTools: boolean;
  readonly supportsStreaming: boolean;
  /** True when the model runs locally and costs nothing. */
  readonly local: boolean;
  readonly description?: string;
}

export interface AIProvider {
  readonly id: string;
  models(): Promise<readonly ModelInfo[]>;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>;
}

/**
 * Token estimation without a tokeniser.
 *
 * Real tokenisers are model-specific and heavy. For budgeting, cost projection
 * and context packing an estimate within ~10% is sufficient, and this one is
 * calibrated for code-heavy English text: roughly 3.6 characters per token,
 * with an allowance for the extra tokens punctuation-dense source produces.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const words = text.split(/\s+/).filter(Boolean).length;
  const punctuation = (text.match(/[^\w\s]/g) ?? []).length;
  return Math.max(1, Math.ceil(text.length / 3.6 + punctuation * 0.15 + words * 0.05));
}

export function countMessageTokens(messages: readonly ChatMessage[]): number {
  // Each message carries a small framing overhead in every chat format.
  return messages.reduce((total, message) => total + estimateTokens(message.content) + 4, 0);
}

export function computeCost(usage: TokenUsage, model: ModelInfo): number {
  const input = (usage.promptTokens / 1_000_000) * model.inputCostPerMillion;
  const output = (usage.completionTokens / 1_000_000) * model.outputCostPerMillion;
  return Math.round((input + output) * 1_000_000) / 1_000_000;
}
