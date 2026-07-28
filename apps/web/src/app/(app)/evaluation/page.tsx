import { Badge, Card, CardContent, EmptyState, ProgressBar, Stat } from '@forgeos/ui';
import { FlaskConical } from 'lucide-react';
import { compareVariants, projectMonthlyCost } from '@forgeos/core';
import { getActiveWorkspace, getContext } from '@/lib/server/context';
import { PageHeader, Section, ScrollTable, Td, Th, Mono } from '@/components/primitives';
import { RunBenchmarkButton } from '@/components/run-benchmark';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export const metadata = { title: 'Evaluation' };

function formatValue(value: number, format: string): string {
  switch (format) {
    case 'percent':
      return `${(value * 100).toFixed(1)}%`;
    case 'currency':
      return value === 0 ? 'free' : `$${value.toFixed(5)}`;
    case 'duration':
      return `${Math.round(value)}ms`;
    default:
      return String(Math.round(value));
  }
}

export default async function EvaluationPage() {
  const workspace = await getActiveWorkspace();
  const { store, registry } = await getContext();

  const benchmarks = await store.listBenchmarks(workspace.id, { limit: 50 });
  const models = await registry.models();
  const latest = benchmarks[0];
  const comparison = latest ? compareVariants(latest.run) : [];

  return (
    <>
      <PageHeader
        title="Evaluation"
        description="Compare prompts and models on quality, latency, tokens and real cost. Every run records the exact prompt, model, seed and scorers, so a result can be re-derived rather than merely believed."
        actions={<RunBenchmarkButton models={models.map((model) => model.id)} />}
      />

      <Section title="Available models">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {models.map((model) => (
            <Card key={model.id}>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold">{model.name}</span>
                  {model.local ? <Badge tone="success">free · local</Badge> : null}
                </div>
                <div className="mt-1">
                  <Mono>{model.id}</Mono>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--forge-text-muted)]">
                  <span>{(model.contextWindow / 1000).toFixed(0)}k context</span>
                  <span>
                    {model.inputCostPerMillion === 0
                      ? 'no cost'
                      : `$${model.inputCostPerMillion.toFixed(2)}/M in · $${model.outputCostPerMillion.toFixed(2)}/M out`}
                  </span>
                  {model.supportsTools ? <span>tools</span> : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        {models.length === 1 ? (
          <p className="mt-3 text-[12px] text-[var(--forge-text-subtle)]">
            Only the local provider is registered. Set <code>OPENROUTER_API_KEY</code> to compare
            against hosted models — ForgeOS never calls a paid provider unless you configure one.
          </p>
        ) : null}
      </Section>

      {!latest ? (
        <Section>
          <Card>
            <EmptyState
              icon={<FlaskConical className="h-5 w-5" />}
              title="No benchmarks yet"
              description="Run the built-in comparison to see quality, latency and cost side by side. With only the local provider configured it costs nothing."
            />
          </Card>
        </Section>
      ) : (
        <>
          <Section
            title={latest.name}
            description={`${latest.run.variants.length} variants × ${latest.run.caseCount} cases · seed ${latest.run.seed} · ${latest.run.finishedAt - latest.run.startedAt}ms`}
          >
            {latest.run.winner ? (
              <Card className="mb-4">
                <CardContent className="pt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="success">Winner</Badge>
                    <span className="text-[13px] font-medium">
                      {latest.run.variants.find(
                        (variant) => variant.variantId === latest.run.winner?.variantId
                      )?.label ?? latest.run.winner.variantId}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[13px] text-[var(--forge-text-muted)]">
                    {latest.run.winner.reason}
                  </p>
                </CardContent>
              </Card>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-3">
              <Card>
                <CardContent className="pt-5">
                  <Stat
                    label="Total cost"
                    value={latest.run.totalCostUsd === 0 ? 'free' : `$${latest.run.totalCostUsd.toFixed(4)}`}
                    hint={`${latest.run.variants.length * latest.run.caseCount} model calls`}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-5">
                  <Stat
                    label="Best quality"
                    value={`${(Math.max(...latest.run.variants.map((variant) => variant.summary.quality)) * 100).toFixed(1)}%`}
                    hint="weighted mean across scorers"
                  />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-5">
                  <Stat
                    label="Projected monthly"
                    value={`$${projectMonthlyCost(
                      latest.run.variants[0]?.summary ?? {
                        quality: 0,
                        passRate: 0,
                        meanLatencyMs: 0,
                        p95LatencyMs: 0,
                        totalCostUsd: 0,
                        costPerCase: 0,
                        totalTokens: 0,
                        meanOutputTokens: 0,
                        errors: 0,
                      },
                      1000
                    ).toFixed(2)}`}
                    hint="at 1,000 requests per day"
                  />
                </CardContent>
              </Card>
            </div>
          </Section>

          <Section title="Comparison">
            <ScrollTable>
              <thead>
                <tr>
                  <Th>Metric</Th>
                  {latest.run.variants.map((variant) => (
                    <Th key={variant.variantId} align="right">
                      {variant.label}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {comparison.map((row) => (
                  <tr key={row.metric}>
                    <Td>{row.metric}</Td>
                    {row.values.map((value) => (
                      <Td key={value.variantId} align="right">
                        <span className={value.better ? 'font-semibold text-[var(--forge-success)]' : ''}>
                          {formatValue(value.value, row.format)}
                        </span>
                      </Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </ScrollTable>
          </Section>

          <Section title="Variants">
            <div className="space-y-3">
              {latest.run.variants.map((variant) => (
                <Card key={variant.variantId}>
                  <CardContent className="pt-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold">{variant.label}</span>
                          <Mono>{variant.model}</Mono>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--forge-text-muted)]">
                          <span>{variant.summary.meanLatencyMs}ms mean</span>
                          <span>{variant.summary.p95LatencyMs}ms p95</span>
                          <span>{variant.summary.totalTokens.toLocaleString()} tokens</span>
                          <span>
                            {variant.summary.totalCostUsd === 0
                              ? 'free'
                              : `$${variant.summary.totalCostUsd.toFixed(5)}`}
                          </span>
                          {variant.summary.errors > 0 ? (
                            <span className="text-[var(--forge-danger)]">
                              {variant.summary.errors} errors
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="w-40">
                        <div className="mb-1 flex justify-between text-[11px] text-[var(--forge-text-muted)]">
                          <span>quality</span>
                          <span className="tabular-nums">
                            {(variant.summary.quality * 100).toFixed(1)}%
                          </span>
                        </div>
                        <ProgressBar
                          value={variant.summary.quality * 100}
                          tone={variant.summary.quality > 0.75 ? 'success' : 'warning'}
                          label={`${variant.label} quality`}
                        />
                      </div>
                    </div>

                    <details className="mt-3">
                      <summary className="cursor-pointer text-[12px] text-[var(--forge-accent-text)]">
                        Show per-case results
                      </summary>
                      <div className="mt-2 space-y-2">
                        {variant.cases.slice(0, 8).map((result) => (
                          <div
                            key={result.caseId}
                            className="rounded-[var(--forge-radius)] border border-[var(--forge-border)] p-3"
                          >
                            <div className="flex items-center gap-2">
                              <Mono>{result.caseId}</Mono>
                              <Badge tone={result.quality >= 0.6 ? 'success' : 'warning'}>
                                {(result.quality * 100).toFixed(0)}%
                              </Badge>
                              <span className="text-[11px] text-[var(--forge-text-subtle)]">
                                {result.latencyMs}ms · {result.usage.totalTokens} tokens
                              </span>
                            </div>
                            {result.error ? (
                              <p className="mt-1 text-[12px] text-[var(--forge-danger)]">
                                {result.error}
                              </p>
                            ) : (
                              <>
                                <p className="mt-1.5 whitespace-pre-wrap text-[12px] text-[var(--forge-text-muted)]">
                                  {result.output.slice(0, 400)}
                                  {result.output.length > 400 ? '…' : ''}
                                </p>
                                <div className="mt-1.5 flex flex-wrap gap-1.5">
                                  {result.scores.map((score) => (
                                    <span
                                      key={score.scorer}
                                      title={score.detail}
                                      className="rounded-full border border-[var(--forge-border)] px-2 py-0.5 text-[10px] text-[var(--forge-text-muted)]"
                                    >
                                      {score.scorer}: {(score.score * 100).toFixed(0)}%
                                    </span>
                                  ))}
                                </div>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  </CardContent>
                </Card>
              ))}
            </div>
          </Section>
        </>
      )}
    </>
  );
}
