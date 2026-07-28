import Link from 'next/link';
import { Badge, Card, CardContent, EmptyState, ScoreRing } from '@forgeos/ui';
import { Boxes } from 'lucide-react';
import { getActiveWorkspace, getContext } from '@/lib/server/context';
import { PageHeader, Section, CompositionBar, GradeBadge } from '@/components/primitives';
import { AddRepositoryForm, AnalyzeButton } from '@/components/actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Repositories' };

export default async function RepositoriesPage() {
  const workspace = await getActiveWorkspace();
  const { store } = await getContext();
  const projects = await store.listProjects(workspace.id, { limit: 100 });

  const rows = await Promise.all(
    projects.map(async (project) => ({
      project,
      latest: await store.getLatestAnalysis(workspace.id, project.id),
    }))
  );

  return (
    <>
      <PageHeader
        title="Repositories"
        description="Point ForgeOS at a codebase and it derives everything else: structure, dependencies, complexity, hotspots and debt."
      />

      <Section title="Add a repository">
        <Card>
          <CardContent className="pt-5">
            <AddRepositoryForm />
          </CardContent>
        </Card>
      </Section>

      <Section title={`${projects.length} repositor${projects.length === 1 ? 'y' : 'ies'}`}>
        {projects.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Boxes className="h-5 w-5" />}
              title="Nothing here yet"
              description="Add a local path above. ForgeOS analyses it in place — nothing is uploaded anywhere."
            />
          </Card>
        ) : (
          <div className="space-y-3">
            {rows.map(({ project, latest }) => (
              <Card key={project.id}>
                <CardContent className="pt-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/repositories/${project.id}`}
                          className="text-sm font-semibold hover:underline"
                        >
                          {project.name}
                        </Link>
                        {latest ? <GradeBadge grade={latest.analysis.debt.grade} /> : null}
                        {project.sourceKind === 'sample' ? (
                          <Badge tone="accent">bundled sample</Badge>
                        ) : null}
                      </div>

                      <p className="mt-1 font-[var(--forge-font-mono)] text-[11px] text-[var(--forge-text-subtle)]">
                        {project.source}
                      </p>

                      {latest ? (
                        <>
                          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-[12px] text-[var(--forge-text-muted)]">
                            <span>{latest.analysis.overview.stackSummary}</span>
                            <span>{latest.analysis.overview.code.toLocaleString()} LOC</span>
                            <span>{latest.analysis.graph.nodes.length} modules</span>
                            <span>{latest.analysis.graph.edges.length} imports</span>
                            <span>{latest.analysis.api.routes.length} routes</span>
                            <span>
                              {(latest.analysis.overview.commentRatio * 100).toFixed(1)}% comments
                            </span>
                          </div>

                          <div className="mt-3 max-w-md">
                            <CompositionBar
                              segments={latest.analysis.languages.slice(0, 6).map((language) => ({
                                label: language.name,
                                value: language.code,
                                color: language.color,
                              }))}
                            />
                          </div>

                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {latest.analysis.debt.bySeverity.critical > 0 ? (
                              <Badge tone="critical">
                                {latest.analysis.debt.bySeverity.critical} critical
                              </Badge>
                            ) : null}
                            {latest.analysis.debt.bySeverity.high > 0 ? (
                              <Badge tone="high">{latest.analysis.debt.bySeverity.high} high</Badge>
                            ) : null}
                            {latest.analysis.cycles.length > 0 ? (
                              <Badge tone="warning">
                                {latest.analysis.cycles.length} circular dependenc
                                {latest.analysis.cycles.length === 1 ? 'y' : 'ies'}
                              </Badge>
                            ) : null}
                            <Badge tone="neutral">
                              {latest.analysis.debt.estimatedDays} days of debt
                            </Badge>
                          </div>
                        </>
                      ) : (
                        <p className="mt-3 text-[13px] text-[var(--forge-text-muted)]">
                          Not analysed yet.
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-4">
                      {latest ? (
                        <ScoreRing value={latest.analysis.debt.score} size={52} label={project.name} />
                      ) : null}
                      <AnalyzeButton
                        projectId={project.id}
                        label={latest ? 'Re-analyse' : 'Analyse'}
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
