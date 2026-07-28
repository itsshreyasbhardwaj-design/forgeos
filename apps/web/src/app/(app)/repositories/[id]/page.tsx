import Link from 'next/link';
import { notFound as nextNotFound } from 'next/navigation';
import { Badge, Card, CardContent, ProgressBar, ScoreRing, Stat } from '@forgeos/ui';
import { getActiveWorkspace, getContext } from '@/lib/server/context';
import { requireAnalysis } from '@/lib/server/projects';
import {
  PageHeader,
  Section,
  CompositionBar,
  GradeBadge,
  KeyValue,
  Mono,
  ScrollTable,
  SeverityBadge,
  Td,
  Th,
} from '@/components/primitives';
import { AnalyzeButton, GenerateDocsButton, ScanButton } from '@/components/actions';
import { ModuleGraphView, LayerLegend } from '@/components/module-graph';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export default async function RepositoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspace = await getActiveWorkspace();
  const { store } = await getContext();

  const project = await store.getProject(workspace.id, id);
  if (!project) nextNotFound();

  const analysis = await requireAnalysis(workspace.id, id);
  const { overview, debt } = analysis;

  const severityTotal =
    debt.bySeverity.critical + debt.bySeverity.high + debt.bySeverity.medium + debt.bySeverity.low;

  return (
    <>
      <PageHeader
        title={project.name}
        description={overview.description || project.source}
        meta={
          <>
            <GradeBadge grade={debt.grade} />
            <Badge tone="neutral">{overview.stackSummary}</Badge>
            {analysis.snapshot.revision ? (
              <Badge tone="neutral">@{analysis.snapshot.revision.slice(0, 7)}</Badge>
            ) : null}
            {analysis.snapshot.partial ? (
              <Badge tone="warning">partial scan — limits reached</Badge>
            ) : null}
          </>
        }
        actions={
          <>
            <GenerateDocsButton projectId={id} />
            <ScanButton projectId={id} />
            <AnalyzeButton projectId={id} />
          </>
        }
      />

      <Section>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Card>
            <CardContent className="flex items-center gap-4 pt-5">
              <ScoreRing value={debt.score} label="Health" />
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--forge-text-subtle)]">
                  Health score
                </div>
                <div className="mt-1 text-[13px] text-[var(--forge-text-muted)]">
                  {debt.estimatedDays} days of estimated debt
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <Stat
                label="Code"
                value={overview.code.toLocaleString()}
                hint={`${overview.files} files · ${(overview.commentRatio * 100).toFixed(1)}% comments`}
              />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <Stat
                label="Modules"
                value={analysis.graph.nodes.length}
                hint={`${analysis.graph.edges.length} imports · ${analysis.cycles.length} cycles`}
              />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <Stat
                label="Tests"
                value={overview.testFiles}
                hint={`${(overview.testRatio * 100).toFixed(0)}% of source files have a test`}
              />
            </CardContent>
          </Card>
        </div>
      </Section>

      <div className="grid gap-6 px-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="pt-5">
            <h3 className="mb-3 text-[13px] font-semibold">Languages</h3>
            <CompositionBar
              segments={analysis.languages.slice(0, 8).map((language) => ({
                label: language.name,
                value: language.code,
                color: language.color,
              }))}
              height={10}
            />
            <div className="mt-4 space-y-1">
              {analysis.languages.slice(0, 6).map((language) => (
                <div key={language.id} className="flex items-center gap-3 text-[13px]">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: language.color }}
                  />
                  <span className="w-32 shrink-0 truncate">{language.name}</span>
                  <div className="flex-1">
                    <ProgressBar value={language.percentage} label={language.name} />
                  </div>
                  <span className="w-14 text-right tabular-nums text-[var(--forge-text-muted)]">
                    {language.percentage}%
                  </span>
                  <span className="w-20 text-right tabular-nums text-[var(--forge-text-subtle)]">
                    {language.code.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5">
            <h3 className="mb-2 text-[13px] font-semibold">Repository hygiene</h3>
            <KeyValue label="README" value={overview.hasReadme ? 'present' : '—'} />
            <KeyValue label="License" value={overview.hasLicense ? 'present' : '—'} />
            <KeyValue label="Contributing guide" value={overview.hasContributing ? 'present' : '—'} />
            <KeyValue label="Continuous integration" value={overview.hasCi ? 'configured' : '—'} />
            <KeyValue label="Dockerfile" value={overview.hasDockerfile ? 'present' : '—'} />
            <KeyValue label="Dependencies" value={analysis.dependencies.length} />
            <KeyValue label="Entry points" value={analysis.entryPoints.length} />
          </CardContent>
        </Card>
      </div>

      <Section
        title="Module graph"
        description="Layered by dependency depth. Hover a module to isolate its neighbourhood."
      >
        <div className="mb-3">
          <LayerLegend layers={analysis.layers.map((layer) => layer.layer)} />
        </div>
        <ModuleGraphView graph={analysis.graph} maxNodes={44} />
      </Section>

      {analysis.cycles.length > 0 ? (
        <Section title="Circular dependencies">
          <div className="space-y-2">
            {analysis.cycles.slice(0, 8).map((cycle, index) => (
              <Card key={index}>
                <CardContent className="pt-4">
                  <div className="mb-2 flex items-center gap-2">
                    <Badge tone={cycle.crossesLayers ? 'high' : 'moderate'}>
                      {cycle.length} modules
                    </Badge>
                    {cycle.crossesLayers ? <Badge tone="warning">crosses layers</Badge> : null}
                  </div>
                  <p className="break-words font-[var(--forge-font-mono)] text-[11px] leading-relaxed text-[var(--forge-text-muted)]">
                    {cycle.cycle.join(' → ')} → {cycle.cycle[0]}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </Section>
      ) : null}

      <Section
        title="Highest-risk modules"
        description="Risk combines complexity with how many modules depend on the file."
      >
        <ScrollTable>
          <thead>
            <tr>
              <Th>Module</Th>
              <Th align="right">Risk</Th>
              <Th align="right">Complexity</Th>
              <Th align="right">LOC</Th>
              <Th align="right">Dependents</Th>
              <Th align="right">Maintainability</Th>
            </tr>
          </thead>
          <tbody>
            {analysis.hotspots.slice(0, 15).map((hotspot) => (
              <tr key={hotspot.path}>
                <Td>
                  <span className="font-[var(--forge-font-mono)] text-[11px]">{hotspot.path}</span>
                  <div className="mt-0.5 text-[11px] text-[var(--forge-text-subtle)]">
                    {hotspot.reason}
                  </div>
                </Td>
                <Td align="right">
                  <span className="font-medium">{hotspot.risk}</span>
                </Td>
                <Td align="right">{hotspot.complexity}</Td>
                <Td align="right">{hotspot.loc.toLocaleString()}</Td>
                <Td align="right">{hotspot.fanIn}</Td>
                <Td align="right">{hotspot.maintainability}</Td>
              </tr>
            ))}
          </tbody>
        </ScrollTable>
      </Section>

      <Section
        title="Technical debt"
        description={`${debt.findings.length} findings · ${debt.estimatedDays} days estimated · grade ${debt.grade}`}
      >
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(
            [
              ['critical', debt.bySeverity.critical],
              ['high', debt.bySeverity.high],
              ['medium', debt.bySeverity.medium],
              ['low', debt.bySeverity.low],
            ] as const
          ).map(([severity, count]) => (
            <Card key={severity}>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <SeverityBadge severity={severity} />
                  <span className="text-lg font-semibold tabular-nums">{count}</span>
                </div>
                <div className="mt-2">
                  <ProgressBar
                    value={severityTotal === 0 ? 0 : (count / severityTotal) * 100}
                    tone={severity === 'medium' ? 'moderate' : severity}
                    label={`${severity} findings`}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <ScrollTable>
          <thead>
            <tr>
              <Th>Severity</Th>
              <Th>Finding</Th>
              <Th>Location</Th>
              <Th align="right">Effort</Th>
            </tr>
          </thead>
          <tbody>
            {debt.findings.slice(0, 40).map((finding) => (
              <tr key={finding.id}>
                <Td>
                  <SeverityBadge severity={finding.severity} />
                </Td>
                <Td>
                  <div className="font-medium">{finding.title}</div>
                  <div className="mt-0.5 text-[12px] text-[var(--forge-text-muted)]">
                    {finding.detail}
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--forge-accent-text)]">
                    {finding.recommendation}
                  </div>
                </Td>
                <Td>
                  <Mono>
                    {finding.file}
                    {finding.line ? `:${finding.line}` : ''}
                  </Mono>
                </Td>
                <Td align="right">{finding.effortHours}h</Td>
              </tr>
            ))}
          </tbody>
        </ScrollTable>
        {debt.findings.length > 40 ? (
          <p className="mt-3 text-[12px] text-[var(--forge-text-subtle)]">
            Showing 40 of {debt.findings.length} findings, highest severity first.
          </p>
        ) : null}
      </Section>

      <Section title="Next steps">
        <div className="flex flex-wrap gap-3">
          <Link
            href={`/architecture?project=${id}`}
            className="rounded-[var(--forge-radius)] border border-[var(--forge-border)] px-4 py-2 text-[13px] transition-colors hover:border-[var(--forge-accent-border)]"
          >
            Explore the architecture →
          </Link>
          <Link
            href="/documentation"
            className="rounded-[var(--forge-radius)] border border-[var(--forge-border)] px-4 py-2 text-[13px] transition-colors hover:border-[var(--forge-accent-border)]"
          >
            Generate documentation →
          </Link>
          <Link
            href="/security"
            className="rounded-[var(--forge-radius)] border border-[var(--forge-border)] px-4 py-2 text-[13px] transition-colors hover:border-[var(--forge-accent-border)]"
          >
            Review security →
          </Link>
        </div>
      </Section>
    </>
  );
}
