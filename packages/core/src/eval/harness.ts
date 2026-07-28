import type { ModelRegistry } from '../ai/registry.js';
import type { ChatMessage, CompletionResponse } from '../ai/types.js';
import { cosineSimilarity, embedLocal } from '../memory/embedding.js';
import { createId } from '../kernel/id.js';
import { clamp, round } from '../kernel/text.js';
import { ForgeError } from '../kernel/errors.js';

/**
 * Prompt and model evaluation.
 *
 * The harness is built around a principle that is easy to state and often
 * ignored: **a benchmark that cannot be reproduced is an anecdote.** Every run
 * therefore records the exact prompt template, the resolved model id, the seed,
 * the scorer configuration and the raw output, so a result can be re-derived
 * rather than merely believed.
 *
 * Scorers are deterministic by default. An LLM-as-judge scorer is available but
 * opt-in, because it costs money and introduces the very variance the harness
 * exists to measure.
 */
export interface PromptTemplate {
  readonly id: string;
  readonly name: string;
  /** Supports `{{variable}}` placeholders. */
  readonly system?: string;
  readonly user: string;
  readonly version?: number;
}

export interface EvalCase {
  readonly id: string;
  readonly name?: string;
  readonly variables: Readonly<Record<string, string>>;
  /** Reference answer, used by the reference-based scorers. */
  readonly expected?: string;
  /** Substrings that must all appear. */
  readonly mustContain?: readonly string[];
  /** Substrings that must not appear. */
  readonly mustNotContain?: readonly string[];
  readonly tags?: readonly string[];
}

export type ScorerId =
  | 'exact-match'
  | 'contains'
  | 'not-contains'
  | 'similarity'
  | 'json-valid'
  | 'regex'
  | 'length'
  | 'llm-judge';

export interface ScorerConfig {
  readonly id: ScorerId;
  /** Relative weight in the composite quality score. */
  readonly weight?: number;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  /** Model used by `llm-judge`. */
  readonly judgeModel?: string;
  readonly rubric?: string;
}

export interface ScoreBreakdown {
  readonly scorer: ScorerId;
  /** 0–1. */
  readonly score: number;
  readonly weight: number;
  readonly detail: string;
}

export interface CaseResult {
  readonly caseId: string;
  readonly output: string;
  readonly scores: readonly ScoreBreakdown[];
  /** Weighted mean of the individual scores, 0–1. */
  readonly quality: number;
  readonly usage: CompletionResponse['usage'];
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly error?: string;
}

export interface VariantResult {
  readonly variantId: string;
  readonly label: string;
  readonly model: string;
  readonly templateId: string;
  readonly cases: readonly CaseResult[];
  readonly summary: VariantSummary;
}

export interface VariantSummary {
  readonly quality: number;
  readonly passRate: number;
  readonly meanLatencyMs: number;
  readonly p95LatencyMs: number;
  readonly totalCostUsd: number;
  readonly costPerCase: number;
  readonly totalTokens: number;
  readonly meanOutputTokens: number;
  readonly errors: number;
}

export interface BenchmarkRun {
  readonly id: string;
  readonly name: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly variants: readonly VariantResult[];
  readonly caseCount: number;
  readonly seed: number;
  readonly winner?: { variantId: string; reason: string };
  readonly totalCostUsd: number;
}

export interface Variant {
  readonly id?: string;
  readonly label: string;
  readonly template: PromptTemplate;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface BenchmarkOptions {
  readonly name: string;
  readonly registry: ModelRegistry;
  readonly variants: readonly Variant[];
  readonly cases: readonly EvalCase[];
  readonly scorers: readonly ScorerConfig[];
  /** Quality below which a case is considered failed. Default 0.6. */
  readonly passThreshold?: number;
  readonly seed?: number;
  /** Cases run per variant concurrently. Default 4. */
  readonly concurrency?: number;
  readonly now?: () => number;
  readonly onProgress?: (done: number, total: number) => void;
}

/** Substitute `{{variable}}` placeholders, leaving unknown ones visible. */
export function renderTemplate(
  template: string,
  variables: Readonly<Record<string, string>>
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? (variables[name] ?? '') : match
  );
}

/** Placeholders a template references, so the UI can prompt for them. */
export function templateVariables(template: PromptTemplate): string[] {
  const found = new Set<string>();
  for (const source of [template.system ?? '', template.user]) {
    for (const match of source.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found].sort();
}

function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function runScorer(
  config: ScorerConfig,
  output: string,
  testCase: EvalCase,
  registry: ModelRegistry
): Promise<ScoreBreakdown> {
  const weight = config.weight ?? 1;

  switch (config.id) {
    case 'exact-match': {
      if (testCase.expected === undefined) {
        return { scorer: config.id, score: 0, weight: 0, detail: 'No expected value supplied.' };
      }
      const pass = normalise(output) === normalise(testCase.expected);
      return {
        scorer: config.id,
        score: pass ? 1 : 0,
        weight,
        detail: pass ? 'Exact match.' : 'Output differs from the reference.',
      };
    }

    case 'contains': {
      const required = testCase.mustContain ?? [];
      if (required.length === 0) {
        return { scorer: config.id, score: 0, weight: 0, detail: 'No required substrings.' };
      }
      const lower = output.toLowerCase();
      const hits = required.filter((needle) => lower.includes(needle.toLowerCase()));
      return {
        scorer: config.id,
        score: hits.length / required.length,
        weight,
        detail: `${hits.length}/${required.length} required substrings present.`,
      };
    }

    case 'not-contains': {
      const banned = testCase.mustNotContain ?? [];
      if (banned.length === 0) {
        return { scorer: config.id, score: 1, weight: 0, detail: 'No banned substrings.' };
      }
      const lower = output.toLowerCase();
      const violations = banned.filter((needle) => lower.includes(needle.toLowerCase()));
      return {
        scorer: config.id,
        score: violations.length === 0 ? 1 : 0,
        weight,
        detail:
          violations.length === 0
            ? 'No banned content.'
            : `Contains banned content: ${violations.join(', ')}.`,
      };
    }

    case 'similarity': {
      if (testCase.expected === undefined) {
        return { scorer: config.id, score: 0, weight: 0, detail: 'No expected value supplied.' };
      }
      // Cosine over local lexical embeddings: reproducible and free. It rewards
      // overlapping vocabulary, which is the right proxy when the reference is
      // a specific factual answer rather than open-ended prose.
      const similarity = cosineSimilarity(embedLocal(output), embedLocal(testCase.expected));
      return {
        scorer: config.id,
        score: clamp(similarity, 0, 1),
        weight,
        detail: `Lexical similarity to reference: ${round(similarity, 3)}.`,
      };
    }

    case 'json-valid': {
      const candidate = output.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
      try {
        JSON.parse(candidate);
        return { scorer: config.id, score: 1, weight, detail: 'Output parses as JSON.' };
      } catch (error) {
        return {
          scorer: config.id,
          score: 0,
          weight,
          detail: `Not valid JSON: ${(error as Error).message}`,
        };
      }
    }

    case 'regex': {
      if (!config.pattern) {
        return { scorer: config.id, score: 0, weight: 0, detail: 'No pattern configured.' };
      }
      try {
        const pass = new RegExp(config.pattern, 'i').test(output);
        return {
          scorer: config.id,
          score: pass ? 1 : 0,
          weight,
          detail: pass ? 'Pattern matched.' : 'Pattern did not match.',
        };
      } catch {
        return { scorer: config.id, score: 0, weight: 0, detail: 'Invalid regular expression.' };
      }
    }

    case 'length': {
      const min = config.minLength ?? 0;
      const max = config.maxLength ?? Number.MAX_SAFE_INTEGER;
      const length = output.trim().length;
      const pass = length >= min && length <= max;
      return {
        scorer: config.id,
        score: pass ? 1 : 0,
        weight,
        detail: `${length} characters (expected ${min}–${max === Number.MAX_SAFE_INTEGER ? '∞' : max}).`,
      };
    }

    case 'llm-judge': {
      const judgeModel = config.judgeModel;
      if (!judgeModel) {
        return { scorer: config.id, score: 0, weight: 0, detail: 'No judge model configured.' };
      }
      try {
        const { provider } = await registry.resolve(judgeModel);
        const rubric =
          config.rubric ??
          'Score how well the answer satisfies the request: accurate, complete, and free of invented detail.';
        const response = await provider.complete({
          model: judgeModel,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content: `You are an impartial evaluator. ${rubric}\nReply with only a number from 0 to 10.`,
            },
            {
              role: 'user',
              content: `Reference answer:\n${testCase.expected ?? '(none provided)'}\n\nCandidate answer:\n${output}`,
            },
          ],
        });
        const parsed = Number.parseFloat(/(\d+(?:\.\d+)?)/.exec(response.text)?.[1] ?? '');
        const score = Number.isFinite(parsed) ? clamp(parsed / 10, 0, 1) : 0;
        return {
          scorer: config.id,
          score,
          weight,
          detail: `Judge (${judgeModel}) scored ${round(score * 10, 1)}/10.`,
        };
      } catch (error) {
        return {
          scorer: config.id,
          score: 0,
          weight: 0,
          detail: `Judge failed: ${ForgeError.from(error).message}`,
        };
      }
    }
  }
}

function summarise(cases: readonly CaseResult[], passThreshold: number): VariantSummary {
  const successful = cases.filter((result) => !result.error);
  const latencies = successful.map((result) => result.latencyMs).sort((a, b) => a - b);
  const totalCost = cases.reduce((sum, result) => sum + result.costUsd, 0);
  const totalTokens = cases.reduce((sum, result) => sum + result.usage.totalTokens, 0);
  const outputTokens = successful.reduce((sum, result) => sum + result.usage.completionTokens, 0);

  const p95Index = Math.max(0, Math.ceil(latencies.length * 0.95) - 1);

  return {
    quality: round(
      successful.length === 0
        ? 0
        : successful.reduce((sum, result) => sum + result.quality, 0) / successful.length,
      4
    ),
    passRate: round(
      cases.length === 0
        ? 0
        : cases.filter((result) => !result.error && result.quality >= passThreshold).length /
            cases.length,
      4
    ),
    meanLatencyMs: Math.round(
      latencies.length === 0 ? 0 : latencies.reduce((sum, value) => sum + value, 0) / latencies.length
    ),
    p95LatencyMs: latencies[p95Index] ?? 0,
    totalCostUsd: round(totalCost, 6),
    costPerCase: round(cases.length === 0 ? 0 : totalCost / cases.length, 6),
    totalTokens,
    meanOutputTokens: Math.round(successful.length === 0 ? 0 : outputTokens / successful.length),
    errors: cases.length - successful.length,
  };
}

/** Run tasks with bounded concurrency, preserving input order in the output. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkRun> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const passThreshold = options.passThreshold ?? 0.6;
  const seed = options.seed ?? 1;
  const concurrency = options.concurrency ?? 4;

  const total = options.variants.length * options.cases.length;
  let completed = 0;

  const variants: VariantResult[] = [];

  for (const variant of options.variants) {
    const results = await mapWithConcurrency(options.cases, concurrency, async (testCase) => {
      const messages: ChatMessage[] = [];
      if (variant.template.system) {
        messages.push({
          role: 'system',
          content: renderTemplate(variant.template.system, testCase.variables),
        });
      }
      messages.push({
        role: 'user',
        content: renderTemplate(variant.template.user, testCase.variables),
      });

      try {
        const { provider } = await options.registry.resolve(variant.model);
        const response = await provider.complete({
          model: variant.model,
          messages,
          seed,
          ...(variant.temperature !== undefined ? { temperature: variant.temperature } : {}),
          ...(variant.maxTokens !== undefined ? { maxTokens: variant.maxTokens } : {}),
        });

        const scores = await Promise.all(
          options.scorers.map((scorer) =>
            runScorer(scorer, response.text, testCase, options.registry)
          )
        );

        const totalWeight = scores.reduce((sum, score) => sum + score.weight, 0);
        const quality =
          totalWeight === 0
            ? 0
            : round(
                scores.reduce((sum, score) => sum + score.score * score.weight, 0) / totalWeight,
                4
              );

        completed++;
        options.onProgress?.(completed, total);

        return {
          caseId: testCase.id,
          output: response.text,
          scores,
          quality,
          usage: response.usage,
          costUsd: response.costUsd,
          latencyMs: response.latencyMs,
        } satisfies CaseResult;
      } catch (error) {
        completed++;
        options.onProgress?.(completed, total);
        return {
          caseId: testCase.id,
          output: '',
          scores: [],
          quality: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          costUsd: 0,
          latencyMs: 0,
          error: ForgeError.from(error).message,
        } satisfies CaseResult;
      }
    });

    variants.push({
      variantId: variant.id ?? createId('bmk'),
      label: variant.label,
      model: variant.model,
      templateId: variant.template.id,
      cases: results,
      summary: summarise(results, passThreshold),
    });
  }

  return {
    id: createId('run', startedAt),
    name: options.name,
    startedAt,
    finishedAt: now(),
    variants,
    caseCount: options.cases.length,
    seed,
    ...(pickWinner(variants) ? { winner: pickWinner(variants) as { variantId: string; reason: string } } : {}),
    totalCostUsd: round(
      variants.reduce((sum, variant) => sum + variant.summary.totalCostUsd, 0),
      6
    ),
  };
}

/**
 * Choose a winner on quality, breaking near-ties on cost and then latency.
 *
 * The 2% tolerance is deliberate: declaring a winner on a 0.3% quality
 * difference over a handful of cases is noise, and picking the cheaper variant
 * in that situation is the better engineering decision.
 */
export function pickWinner(
  variants: readonly VariantResult[]
): { variantId: string; reason: string } | null {
  const usable = variants.filter((variant) => variant.summary.errors < variant.cases.length);
  if (usable.length === 0) return null;

  const best = usable.reduce((leader, variant) =>
    variant.summary.quality > leader.summary.quality ? variant : leader
  );

  const contenders = usable.filter(
    (variant) => variant.summary.quality >= best.summary.quality - 0.02
  );

  if (contenders.length === 1) {
    return {
      variantId: best.variantId,
      reason: `Highest quality (${round(best.summary.quality * 100, 1)}%).`,
    };
  }

  const cheapest = contenders.reduce((leader, variant) =>
    variant.summary.totalCostUsd < leader.summary.totalCostUsd
      ? variant
      : variant.summary.totalCostUsd === leader.summary.totalCostUsd &&
          variant.summary.meanLatencyMs < leader.summary.meanLatencyMs
        ? variant
        : leader
  );

  return {
    variantId: cheapest.variantId,
    reason:
      contenders.length > 1 && cheapest.variantId !== best.variantId
        ? `Quality within 2% of the best variant at lower cost (${cheapest.summary.totalCostUsd === 0 ? 'free' : `$${cheapest.summary.totalCostUsd}`}, ${cheapest.summary.meanLatencyMs}ms mean latency).`
        : `Highest quality (${round(cheapest.summary.quality * 100, 1)}%) at the lowest cost among tied variants.`,
  };
}

/** Pairwise comparison table for the results UI. */
export interface Comparison {
  readonly metric: string;
  readonly values: readonly { variantId: string; label: string; value: number; better: boolean }[];
  readonly format: 'percent' | 'currency' | 'duration' | 'count';
}

export function compareVariants(run: BenchmarkRun): Comparison[] {
  const build = (
    metric: string,
    format: Comparison['format'],
    select: (summary: VariantSummary) => number,
    higherIsBetter: boolean
  ): Comparison => {
    const values = run.variants.map((variant) => ({
      variantId: variant.variantId,
      label: variant.label,
      value: select(variant.summary),
    }));
    const best = higherIsBetter
      ? Math.max(...values.map((value) => value.value))
      : Math.min(...values.map((value) => value.value));
    return {
      metric,
      format,
      values: values.map((value) => ({ ...value, better: value.value === best })),
    };
  };

  return [
    build('Quality', 'percent', (summary) => summary.quality, true),
    build('Pass rate', 'percent', (summary) => summary.passRate, true),
    build('Mean latency', 'duration', (summary) => summary.meanLatencyMs, false),
    build('p95 latency', 'duration', (summary) => summary.p95LatencyMs, false),
    build('Total cost', 'currency', (summary) => summary.totalCostUsd, false),
    build('Cost per case', 'currency', (summary) => summary.costPerCase, false),
    build('Output tokens', 'count', (summary) => summary.meanOutputTokens, false),
    build('Errors', 'count', (summary) => summary.errors, false),
  ];
}

/** Project the monthly cost of running a variant at a given request volume. */
export function projectMonthlyCost(summary: VariantSummary, requestsPerDay: number): number {
  return round(summary.costPerCase * requestsPerDay * 30, 2);
}
