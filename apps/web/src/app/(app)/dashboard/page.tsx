import Link from 'next/link';
import { Card, CardContent, ScoreRing, Stat, Badge, EmptyState } from '@forgeos/ui';
import { Activity, Boxes, ShieldCheck, GitBranch } from 'lucide-react';
import { getActiveWorkspace, getContext, getRuntimeStatus } from '@/lib/server/context';
import { PageHeader, Section, CompositionBar, GradeBadge } from '@/components/primitives';
import { MODULES } from '@/lib/modules';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dashboard' };

function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default async function DashboardPage() {
  const workspace = await getActiveWorkspace();
  const { store } = await getContext();
  const runtime = await getRuntimeStatus();

  const projects = await store.listProjects(workspace.id, { limit: 50 });
  const analyses = await Promise.all(
    projects.map(async (project) => ({
      project,
      latest: await store.getLatestAnalysis(workspace.id, project.id),
    }))
  );

  const analysed = analyses.filter((entry) => entry.latest !== null);
  const activity = await store.listActivity(workspace.id, { limit: 12 });
  const reports = await store.listSecurityReports(workspace.id, undefined, { limit: 20 });

  const totalCode = analysed.reduce(
    (sum, entry) => sum + (entry.latest?.analysis.overview.code ?? 0),
    0
  );
  const averageHealth =
    analysed.length === 0
      ? 0
      : analysed.reduce((sum, entry) => sum + (entry.latest?.analysis.debt.score ?? 0), 0) /
        analysed.length;
  const totalCritical = analysed.reduce(
    (sum, entry) => sum + (entry.latest?.analysis.debt.bySeverity.critical ?? 0),
    0
  );
  const totalCycles = analysed.reduce((sum, entry) => sum + (entry.latest?.analysis.cycles.length ?? 0), 0);

  // Aggregate language composition across every analysed repository.
  const languageTotals = new Map<string, { code: number; color: string }>();
  for (const entry of analysed) {
    for (const language of entry.latest?.analysis.languages ?? []) {
      const existing = languageTotals.get(language.name);
      languageTotals.set(language.name, {
        code: (existing?.code ?? 0) + language.code,
        color: language.color,
      });
    }
  }
  const languages = [...languageTotals.entries()]
    .map(([label, value]) => ({ label, value: value.code, color: value.color }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  const latestReport = reports[0];

  return (
    <>
      <PageHeader
        title={workspace.name}
        description="Everything ForgeOS knows about this workspace, and what needs attention."
        meta={
          <>
            <Badge tone="neutral" dot>
              {runtime.storage}
            </Badge>
            <Badge tone="accent">{runtime.defaultModel}</Badge>
            <Badge tone={runtime.auth === 'clerk' ? 'success' : 'neutral'}>
              auth: {runtime.auth}
            </Badge>
          </>
        }
      />

      <Section>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Card>
            <CardContent className="flex items-center gap-4 pt-5">
              <ScoreRing value={averageHealth} label="Average health" />
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--forge-text-subtle)]">
                  Average health
                </div>
                <div className="mt-1 text-[13px] text-[var(--forge-text-muted)]">
                  across {analysed.length} analysed repositor{analysed.length === 1 ? 'y' : 'ies'}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5">
              <Stat
                label="Repositories"
                value={projects.length}
                hint={`${analysed.length} analysed · ${projects.length - analysed.length} pending`}
              />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5">
              <Stat
                label="Lines of code"
                value={totalCode.toLocaleString()}
                hint={languages[0] ? `mostly ${languages[0].label}` : 'no analysis yet'}
              />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5">
              <Stat
                label="Needs attention"
                value={totalCritical + totalCycles}
                hint={`${totalCritical} critical findings · ${totalCycles} dependency cycles`}
              />
            </CardContent>
          </Card>
        </div>

        {languages.length > 0 ? (
          <div className="mt-4 rounded-[var(--forge-radius-lg)] border border-[var(--forge-border)] p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--forge-text-subtle)]">
                Language composition
              </span>
              <span className="text-[12px] text-[var(--forge-text-muted)]">
                {languages.length} languages
              </span>
            </div>
            <CompositionBar segments={languages} height={10} />
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
              {languages.map((language) => (
                <span
                  key={language.label}
                  className="flex items-center gap-1.5 text-[12px] text-[var(--forge-text-muted)]"
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: language.color }}
                  />
                  {language.label}
                  <span className="tabular-nums text-[var(--forge-text-subtle)]">
                    {((language.value / totalCode) * 100).toFixed(1)}%
                  </span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </Section>

      <div className="grid gap-6 px-6 pb-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h2 className="mb-4 text-[13px] font-semibold uppercase tracking-wider text-[var(--forge-text-subtle)]">
            Repositories
          </h2>
          {projects.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Boxes className="h-5 w-5" />}
                title="No repositories yet"
                description="Add a local path to analyse a codebase, or start with the bundled sample."
              />
            </Card>
          ) : (
            <div className="space-y-2">
              {analyses.map(({ project, latest }) => (
                <Link key={project.id} href={`/repositories/${project.id}`} className="block">
                  <Card interactive>
                    <CardContent className="flex flex-wrap items-center gap-4 pt-5">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{project.name}</span>
                          {latest ? <GradeBadge grade={latest.analysis.debt.grade} /> : (
                            <Badge tone="neutral">not analysed</Badge>
                          )}
                        </div>
                        <p className="mt-1 truncate text-[12px] text-[var(--forge-text-muted)]">
                          {latest
                            ? `${latest.analysis.overview.stackSummary} · ${latest.analysis.overview.code.toLocaleString()} LOC · ${latest.analysis.graph.nodes.length} modules`
                            : (project.description ?? project.source)}
                        </p>
                      </div>
                      {latest ? (
                        <div className="flex items-center gap-6">
                          <div className="text-right">
                            <div className="text-[11px] text-[var(--forge-text-subtle)]">
                              Findings
                            </div>
                            <div className="text-sm font-medium tabular-nums">
                              {latest.analysis.debt.findings.length}
                            </div>
                          </div>
                          <ScoreRing value={latest.analysis.debt.score} size={40} label={project.name} />
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div>
            <h2 className="mb-4 text-[13px] font-semibold uppercase tracking-wider text-[var(--forge-text-subtle)]">
              Security
            </h2>
            <Card>
              <CardContent className="pt-5">
                {latestReport ? (
                  <>
                    <div className="flex items-center gap-4">
                      <ScoreRing value={latestReport.report.posture.score} size={52} label="Posture" />
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium">
                          {latestReport.report.repository}
                        </div>
                        <p className="mt-0.5 text-[12px] leading-snug text-[var(--forge-text-muted)]">
                          {latestReport.report.posture.summary}
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {(['critical', 'high', 'moderate', 'low'] as const).map((severity) => (
                        <Badge key={severity} tone={severity === 'critical' ? 'critical' : severity}>
                          {latestReport.report.counts[severity]} {severity}
                        </Badge>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="flex items-start gap-3">
                    <ShieldCheck className="mt-0.5 h-4 w-4 text-[var(--forge-text-subtle)]" />
                    <p className="text-[13px] text-[var(--forge-text-muted)]">
                      No security scan has been run yet.{' '}
                      <Link href="/security" className="text-[var(--forge-accent-text)] underline">
                        Run one
                      </Link>
                      .
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div>
            <h2 className="mb-4 text-[13px] font-semibold uppercase tracking-wider text-[var(--forge-text-subtle)]">
              Activity
            </h2>
            <Card>
              <CardContent className="pt-5">
                {activity.length === 0 ? (
                  <div className="flex items-start gap-3">
                    <Activity className="mt-0.5 h-4 w-4 text-[var(--forge-text-subtle)]" />
                    <p className="text-[13px] text-[var(--forge-text-muted)]">
                      Nothing has happened in this workspace yet.
                    </p>
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {activity.map((entry) => (
                      <li key={entry.id} className="flex gap-3">
                        <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--forge-text-subtle)]" />
                        <div className="min-w-0">
                          <p className="text-[13px] leading-snug text-[var(--forge-text)]">
                            {entry.targetHref ? (
                              <Link href={entry.targetHref} className="hover:underline">
                                {entry.summary}
                              </Link>
                            ) : (
                              entry.summary
                            )}
                          </p>
                          <span className="text-[11px] text-[var(--forge-text-subtle)]">
                            {relativeTime(entry.createdAt)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      <Section title="Modules" description="Everything ForgeOS replaces, in one place.">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {MODULES.filter((module) => module.group !== 'system' && module.id !== 'dashboard').map(
            (module) => {
              const Icon = module.icon;
              return (
                <Link key={module.id} href={module.href}>
                  <Card interactive className="h-full">
                    <CardContent className="pt-5">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-7 w-7 items-center justify-center rounded-[var(--forge-radius-sm)] bg-[var(--forge-accent-subtle)] text-[var(--forge-accent-text)]">
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="text-sm font-medium">{module.name}</span>
                      </div>
                      <p className="mt-2.5 text-[13px] leading-relaxed text-[var(--forge-text-muted)]">
                        {module.summary}
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              );
            }
          )}
        </div>
      </Section>
    </>
  );
}
