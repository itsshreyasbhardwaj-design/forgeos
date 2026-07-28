import {
  computeCost,
  countMessageTokens,
  estimateTokens,
  type AIProvider,
  type ChatMessage,
  type CompletionRequest,
  type ModelInfo,
  type StreamChunk,
  type ToolCall,
} from './types.js';
import { SearchIndex } from '../search/index.js';
import { seededRandom } from '../kernel/hash.js';
import { firstSentence, tokenize, truncate } from '../kernel/text.js';

/**
 * `forge-local` — the offline provider.
 *
 * **This is not a neural language model, and ForgeOS never claims it is.** It
 * is a deterministic, retrieval-grounded responder: it selects and arranges
 * sentences from the context it was given, following the shape of the question
 * asked. That makes it genuinely useful for the tasks ForgeOS puts in front of
 * it — summarising an analysis, explaining what a module does, listing findings
 * — because in every one of those cases the answer *is* in the context.
 *
 * It exists so the product has no dead ends without an API key: every button
 * works, nothing costs money, and results are reproducible. Where it cannot
 * answer, it says so plainly rather than inventing something, which is more
 * than can be said for a hallucinating model.
 */
export const LOCAL_MODEL: ModelInfo = {
  id: 'forge-local',
  name: 'ForgeOS Local',
  provider: 'forgeos',
  contextWindow: 32_000,
  inputCostPerMillion: 0,
  outputCostPerMillion: 0,
  supportsTools: true,
  supportsStreaming: true,
  local: true,
  description:
    'Deterministic retrieval-grounded responder. Runs offline at zero cost; extracts and organises answers from supplied context rather than generating novel prose.',
};

type Intent =
  | 'explain'
  | 'summarise'
  | 'list'
  | 'compare'
  | 'howto'
  | 'define'
  | 'generate'
  | 'unknown';

function classifyIntent(question: string): Intent {
  const q = question.toLowerCase();
  if (/\b(how do i|how to|steps|set ?up|install|configure|deploy)\b/.test(q)) return 'howto';
  if (/\b(list|show|what are|which|enumerate|find all)\b/.test(q)) return 'list';
  if (/\b(compare|versus|vs\.?|difference between|better)\b/.test(q)) return 'compare';
  if (/\b(summar|overview|tl;?dr|brief)\b/.test(q)) return 'summarise';
  if (/\b(what is|what does|define|meaning of)\b/.test(q)) return 'define';
  if (/\b(explain|why|how does|walk me through|understand)\b/.test(q)) return 'explain';
  if (/\b(write|generate|create|draft|produce)\b/.test(q)) return 'generate';
  return 'unknown';
}

/** Split context into ranked, addressable passages. */
function passagesFrom(messages: readonly ChatMessage[]): { text: string; source: string }[] {
  const passages: { text: string; source: string }[] = [];

  for (const message of messages) {
    if (message.role === 'user') continue;
    const source = message.role === 'tool' ? (message.name ?? 'tool') : message.role;

    for (const block of message.content.split(/\n{2,}/)) {
      const trimmed = block.trim();
      if (trimmed.length < 24) continue;
      // Keep list blocks whole; they lose meaning split into sentences.
      if (/^[-*•]\s|\|.*\|/.test(trimmed)) {
        passages.push({ text: trimmed, source });
        continue;
      }
      for (const sentence of trimmed.split(/(?<=[.!?])\s+(?=[A-Z(`])/)) {
        const clean = sentence.trim();
        if (clean.length >= 24) passages.push({ text: clean, source });
      }
    }
  }

  return passages;
}

function lastUserMessage(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'user') return message.content;
  }
  return '';
}

const INTENT_PREFACE: Record<Intent, string> = {
  explain: 'Here is what the available context says',
  summarise: 'Summary of the available context',
  list: 'From the available context',
  compare: 'Comparing what the context describes',
  howto: 'Based on the available context',
  define: 'From the available context',
  generate: 'Assembled from the available context',
  unknown: 'From the available context',
};

/**
 * Compose an answer by ranking context passages against the question and
 * arranging the best ones according to the detected intent.
 */
export function composeLocalAnswer(messages: readonly ChatMessage[], maxTokens = 700): string {
  const question = lastUserMessage(messages);
  const passages = passagesFrom(messages);

  if (passages.length === 0) {
    return [
      'I have no context to answer from.',
      '',
      'The local provider (`forge-local`) answers strictly from supplied context — it does not generate from parameters. Attach a repository, run an analysis, or configure `OPENROUTER_API_KEY` to use a hosted model.',
    ].join('\n');
  }

  const index = new SearchIndex();
  passages.forEach((passage, position) => {
    index.add({
      id: String(position),
      kind: 'document',
      title: passage.source,
      body: passage.text,
      href: '#',
    });
  });

  const hits = index.search(question, { limit: 14, fuzzyTitles: false });
  const questionTerms = new Set(tokenize(question));

  const selected =
    hits.length > 0
      ? hits.map((hit) => passages[Number(hit.document.id)]).filter(Boolean)
      : // No lexical overlap: fall back to the leading passages, which in
        // ForgeOS are the analysis summary the caller put first.
        passages.slice(0, 6);

  const intent = classifyIntent(question);
  const budget = maxTokens * 4;
  const lines: string[] = [];
  let used = 0;

  const push = (line: string): boolean => {
    if (used + line.length > budget) return false;
    lines.push(line);
    used += line.length;
    return true;
  };

  push(`${INTENT_PREFACE[intent]}:`);
  push('');

  if (intent === 'list' || intent === 'howto') {
    let position = 1;
    for (const passage of selected as { text: string; source: string }[]) {
      if (!passage) continue;
      const bullet = /^[-*•]\s/.test(passage.text)
        ? passage.text
        : `${intent === 'howto' ? `${position}.` : '-'} ${truncate(passage.text, 320)}`;
      if (!push(bullet)) break;
      position++;
    }
  } else {
    for (const passage of selected as { text: string; source: string }[]) {
      if (!passage) continue;
      if (!push(truncate(passage.text, 480))) break;
      if (!push('')) break;
    }
  }

  // Name the strongest term the question used that the context never mentions,
  // so an unanswered question is visibly unanswered.
  const covered = new Set(tokenize(selected.map((p) => p?.text ?? '').join(' ')));
  const missing = [...questionTerms].filter((term) => !covered.has(term)).slice(0, 4);
  if (missing.length > 0) {
    push('');
    push(
      `_Not found in the supplied context: ${missing.map((term) => `\`${term}\``).join(', ')}._`
    );
  }

  return lines.join('\n').trim();
}

/**
 * Decide whether a tool should be invoked, and with what arguments.
 *
 * Matching is lexical: the request is scored against each tool's name and
 * description, and a tool is only called when the match is decisive. Being
 * conservative here matters — a wrongly chosen tool produces a confidently
 * wrong answer, whereas declining to call one merely produces a plainer answer.
 */
export function selectLocalTool(
  request: CompletionRequest
): { call: ToolCall; confidence: number } | null {
  if (!request.tools || request.tools.length === 0) return null;

  const question = lastUserMessage(request.messages);
  if (question.trim() === '') return null;

  // A tool that has already answered in this exchange must not be selected
  // again: its result is in context, and re-calling it loops until the step
  // limit without ever producing a final answer.
  const alreadyCalled = new Set(
    request.messages.filter((message) => message.role === 'tool').map((message) => message.name)
  );
  const available = request.tools.filter((tool) => !alreadyCalled.has(tool.name));
  if (available.length === 0) return null;

  const index = new SearchIndex();
  available.forEach((tool, position) => {
    index.add({
      id: String(position),
      kind: 'document',
      title: tool.name.replace(/[._-]/g, ' '),
      body: `${tool.description} ${Object.entries(tool.parameters)
        .map(([name, parameter]) => `${name} ${parameter.description}`)
        .join(' ')}`,
      href: '#',
    });
  });

  const [best] = index.search(question, { limit: 1, fuzzyTitles: false });
  if (!best || best.score < 1.2) return null;

  const tool = available[Number(best.document.id)];
  if (!tool) return null;

  // Fill required string parameters from the question; anything that cannot be
  // inferred is simply omitted so the tool can apply its own default.
  const args: Record<string, unknown> = {};
  for (const [name, parameter] of Object.entries(tool.parameters)) {
    if (parameter.enum && parameter.enum.length > 0) {
      const matched = parameter.enum.find((option) =>
        question.toLowerCase().includes(option.toLowerCase())
      );
      if (matched) args[name] = matched;
      continue;
    }
    if (parameter.type === 'string' && parameter.required) {
      args[name] = question.trim();
    }
  }

  return {
    call: { id: `call_${best.document.id}`, name: tool.name, arguments: args },
    confidence: best.score,
  };
}

export function createLocalProvider(now: () => number = Date.now): AIProvider {
  return {
    id: 'forgeos',

    async models() {
      return [LOCAL_MODEL];
    },

    async complete(request) {
      const startedAt = now();
      const toolChoice = selectLocalTool(request);

      const text = toolChoice ? '' : composeLocalAnswer(request.messages, request.maxTokens ?? 700);
      const promptTokens = countMessageTokens(request.messages);
      const completionTokens = estimateTokens(text);
      const usage = {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };

      return {
        text,
        model: LOCAL_MODEL.id,
        provider: 'forgeos',
        usage,
        costUsd: computeCost(usage, LOCAL_MODEL),
        latencyMs: Math.max(1, now() - startedAt),
        finishReason: toolChoice ? 'tool_calls' : 'stop',
        ...(toolChoice ? { toolCalls: [toolChoice.call] } : {}),
      };
    },

    async *stream(request): AsyncIterable<StreamChunk> {
      const response = await this.complete(request);
      // Chunk on word boundaries so the UI's streaming path is exercised
      // identically to a hosted provider. Jitter is seeded, not random, so
      // streamed output remains reproducible in tests.
      const random = seededRandom(request.seed ?? response.text.length);
      const words = response.text.split(/(\s+)/);

      let emitted = '';
      let cursor = 0;
      while (cursor < words.length) {
        // The step must be drawn once and used for both the slice and the
        // advance; drawing twice emits overlapping chunks, so the streamed
        // text no longer matches the returned text.
        const step = 1 + Math.floor(random() * 3);
        const delta = words.slice(cursor, cursor + step).join('');
        cursor += step;
        if (delta === '') continue;
        emitted += delta;
        yield { delta, done: false };
      }

      if (emitted.length < response.text.length) {
        yield { delta: response.text.slice(emitted.length), done: false };
      }
      yield { delta: '', done: true, response };
    },
  };
}

/** A one-line, context-grounded title for a conversation. */
export function summariseConversation(messages: readonly ChatMessage[]): string {
  const first = messages.find((message) => message.role === 'user');
  if (!first) return 'New conversation';
  return truncate(firstSentence(first.content, 60) || first.content, 60);
}
