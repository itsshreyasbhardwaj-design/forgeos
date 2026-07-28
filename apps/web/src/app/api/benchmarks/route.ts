import {
  compareVariants,
  createId,
  runBenchmark,
  type EvalCase,
  type ScorerConfig,
  type Variant,
} from '@forgeos/core';
import { getContext } from '@/lib/server/context';
import { route, readJson, requireString } from '@/lib/server/http';
import { invalidateSearchIndex } from '@/lib/server/search';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const GET = route(async ({ workspace }) => {
  const { store, registry } = await getContext();
  const benchmarks = await store.listBenchmarks(workspace.id, { limit: 100 });
  const models = await registry.models();

  return {
    items: benchmarks.map((record) => ({
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      variants: record.run.variants.map((variant) => ({
        id: variant.variantId,
        label: variant.label,
        model: variant.model,
        quality: variant.summary.quality,
        passRate: variant.summary.passRate,
        meanLatencyMs: variant.summary.meanLatencyMs,
        totalCostUsd: variant.summary.totalCostUsd,
        errors: variant.summary.errors,
      })),
      cases: record.run.caseCount,
      winner: record.run.winner ?? null,
      totalCostUsd: record.run.totalCostUsd,
    })),
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      provider: model.provider,
      local: model.local,
      inputCostPerMillion: model.inputCostPerMillion,
      outputCostPerMillion: model.outputCostPerMillion,
      contextWindow: model.contextWindow,
    })),
  };
});

/**
 * Run a benchmark.
 *
 * Note the cost guard: running a large matrix against a paid model is the one
 * action in ForgeOS that can spend real money quickly, so the request is
 * bounded and the resulting cost is always reported back.
 */
export const POST = route(
  async ({ workspace, request }) => {
    const { store, registry } = await getContext();
    const body = await readJson(request);
    const name = requireString(body, 'name', 120);

    const variants = (Array.isArray(body.variants) ? body.variants : []) as Variant[];
    const cases = (Array.isArray(body.cases) ? body.cases : []) as EvalCase[];
    const scorers = (Array.isArray(body.scorers) ? body.scorers : []) as ScorerConfig[];

    if (variants.length === 0 || cases.length === 0) {
      throw Object.assign(new Error('At least one variant and one case are required'), {
        status: 400,
      });
    }

    // 200 model calls is already a meaningful bill on a hosted provider.
    const totalCalls = variants.length * cases.length;
    if (totalCalls > 200) {
      throw Object.assign(
        new Error(`This configuration would make ${totalCalls} model calls; the limit is 200.`),
        { status: 400 }
      );
    }

    const run = await runBenchmark({
      name,
      registry,
      variants,
      cases,
      scorers: scorers.length > 0 ? scorers : [{ id: 'contains', weight: 1 }, { id: 'length', weight: 0.5, minLength: 1 }],
      ...(typeof body.seed === 'number' ? { seed: body.seed } : {}),
    });

    const now = Date.now();
    const record = { id: createId('bmk', now), workspaceId: workspace.id, name, createdAt: now, run };
    await store.saveBenchmark(record);
    await store.recordActivity({
      id: createId('act', now),
      workspaceId: workspace.id,
      kind: 'benchmark.completed',
      actorId: 'system',
      summary: `Benchmark “${name}” finished — winner: ${run.winner?.variantId ?? 'none'}`,
      createdAt: now,
      targetId: record.id,
      targetHref: `/evaluation`,
    });

    invalidateSearchIndex(workspace.id);
    return { id: record.id, run, comparison: compareVariants(run) };
  },
  { limit: 10, windowMs: 60_000, audit: 'benchmark.run' }
);
