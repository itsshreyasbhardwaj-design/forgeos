import Link from 'next/link';
import { Badge, Card, CardContent, EmptyState, ScoreRing, Stat } from '@forgeos/ui';
import { ShieldCheck } from 'lucide-react';
import { getActiveWorkspace, getContext } from '@/lib/server/context';
import {
  PageHeader,
  Section,
  Mono,
  ScrollTable,
  SeverityBadge,
  Td,
  Th,
} from '@/components/primitives';
import { ScanButton } from '@/components/actions';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export const metadata = { title: 'Security' };

export default async function SecurityPage() {
  const workspace = await getActiveWorkspace();
  const { store } = await getContext();
  const projects = await store.listProjects(workspace.id, { limit: 100 });
  const reports = await store.listSecurityReports(workspace.id, undefined, { limit: 20 });
  const latest = reports[0];

  return (
    <>
      <PageHeader
        title="Security"
        description="Secret detection, insecure-pattern analysis and dependency advisories — including the AI-specific risks conventional scanners do not model."
        actions={projects[0] ? <ScanButton projectId={latest?.projectId ?? projects[0].id} /> : null}
      />

      {!latest ? (
        <Section>
          <Card>
            <EmptyState
              icon={<ShieldCheck className="h-5 w-5" />}
              title="No scan has been run yet"
              description={
                projects.length === 0
                  ? 'Add a repository first, then run a scan.'
                  : 'Run a scan to check for exposed credentials, insecure patterns and vulnerable dependencies.'
              }
              action={
                projects.length === 0 ? (
                  <Link
                    href="/repositories"
                    className="rounded-[var(--forge-radius)] bg-[var(--forge-accent)] px-4 py-2 text-[13px] font-medium text-white"
                  >
                    Add a repository
                  </Link>
                ) : null
              }
            />
          </Card>
        </Section>
      ) : (
        <>
          <Section>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <Card>
                <CardContent className="flex items-center gap-4 pt-5">
                  <ScoreRing value={latest.report.posture.score} label="Security posture" />
                  <div>
                    <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--forge-text-subtle)]">
                      Posture
                    </div>
                    <div className="mt-1 text-[13px] leading-snug text-[var(--forge-text-muted)]">
                      {latest.report.posture.summary}
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-5">
                  <Stat
                    label="Credentials"
                    value={latest.report.secrets.length}
                    hint={`${latest.report.secrets.filter((secret) => secret.confidence === 'high').length} high confidence`}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-5">
                  <Stat
                    label="Code findings"
                    value={latest.report.code.length}
                    hint={`${latest.report.code.filter((finding) => finding.category === 'ai').length} AI-specific`}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-5">
                  <Stat
                    label="Vulnerable dependencies"
                    value={latest.report.dependencies.length}
                    hint={`${latest.report.dependencies.filter((match) => match.fixAvailable).length} have a published fix`}
                  />
                </CardContent>
              </Card>
            </div>

            <p className="mt-4 text-[12px] text-[var(--forge-text-subtle)]">
              Advisory sources consulted: {latest.report.advisorySources.join(', ')}. The bundled set
              is curated, not exhaustive — configure an OSV feed for full coverage.
            </p>
          </Section>

          {latest.report.remediation.length > 0 ? (
            <Section title="Remediation plan" description="Ordered by exploitability, then by cost to fix.">
              <div className="space-y-2">
                {latest.report.remediation.map((step) => (
                  <Card key={step.title}>
                    <CardContent className="pt-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={step.priority <= 2 ? 'critical' : step.priority === 3 ? 'high' : 'moderate'}>
                          Priority {step.priority}
                        </Badge>
                        <span className="text-[13px] font-semibold">{step.title}</span>
                        <Badge tone="neutral">{step.effort}</Badge>
                      </div>
                      <p className="mt-2 text-[13px] leading-relaxed text-[var(--forge-text-muted)]">
                        {step.detail}
                      </p>
                      {step.affected.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {step.affected.slice(0, 8).map((item) => (
                            <Mono key={item}>{item}</Mono>
                          ))}
                          {step.affected.length > 8 ? (
                            <span className="text-[11px] text-[var(--forge-text-subtle)]">
                              +{step.affected.length - 8} more
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </Section>
          ) : null}

          {latest.report.secrets.length > 0 ? (
            <Section
              title="Potential credentials"
              description="Values are previewed, never stored in full — a scanner that copies secrets into its own database has made the problem worse."
            >
              <ScrollTable>
                <thead>
                  <tr>
                    <Th>Confidence</Th>
                    <Th>Type</Th>
                    <Th>Location</Th>
                    <Th>Preview</Th>
                    <Th align="right">Entropy</Th>
                  </tr>
                </thead>
                <tbody>
                  {latest.report.secrets.slice(0, 25).map((secret) => (
                    <tr key={secret.id}>
                      <Td>
                        <Badge
                          tone={
                            secret.confidence === 'high'
                              ? 'critical'
                              : secret.confidence === 'medium'
                                ? 'high'
                                : 'low'
                          }
                        >
                          {secret.confidence}
                        </Badge>
                      </Td>
                      <Td>
                        <div className="font-medium">{secret.description}</div>
                        <div className="mt-0.5 text-[12px] text-[var(--forge-text-muted)]">
                          {secret.remediation}
                        </div>
                      </Td>
                      <Td>
                        <Mono>
                          {secret.file}:{secret.line}
                        </Mono>
                      </Td>
                      <Td>
                        <Mono>{secret.preview}</Mono>
                      </Td>
                      <Td align="right">{secret.entropy}</Td>
                    </tr>
                  ))}
                </tbody>
              </ScrollTable>
            </Section>
          ) : null}

          {latest.report.code.length > 0 ? (
            <Section title="Insecure patterns">
              <ScrollTable>
                <thead>
                  <tr>
                    <Th>Severity</Th>
                    <Th>Finding</Th>
                    <Th>Location</Th>
                    <Th>Standard</Th>
                  </tr>
                </thead>
                <tbody>
                  {latest.report.code.map((finding) => (
                    <tr key={finding.id}>
                      <Td>
                        <SeverityBadge severity={finding.severity} />
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{finding.title}</span>
                          {finding.category === 'ai' ? <Badge tone="accent">AI</Badge> : null}
                        </div>
                        <div className="mt-0.5 text-[12px] text-[var(--forge-text-muted)]">
                          {finding.detail}
                        </div>
                        <div className="mt-1 text-[12px] text-[var(--forge-accent-text)]">
                          {finding.remediation}
                        </div>
                      </Td>
                      <Td>
                        <Mono>
                          {finding.file}:{finding.line}
                        </Mono>
                      </Td>
                      <Td>
                        <span className="text-[11px] text-[var(--forge-text-muted)]">
                          {finding.owasp ?? '—'}
                          {finding.cwe ? ` · ${finding.cwe}` : ''}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </ScrollTable>
            </Section>
          ) : null}

          {latest.report.dependencies.length > 0 ? (
            <Section title="Vulnerable dependencies">
              <ScrollTable>
                <thead>
                  <tr>
                    <Th>Severity</Th>
                    <Th>Package</Th>
                    <Th>Advisory</Th>
                    <Th>Fix</Th>
                  </tr>
                </thead>
                <tbody>
                  {latest.report.dependencies.map((match) => (
                    <tr key={`${match.advisory.id}-${match.dependency.name}`}>
                      <Td>
                        <SeverityBadge severity={match.advisory.severity} />
                      </Td>
                      <Td>
                        <Mono>
                          {match.dependency.name}@{match.resolvedVersion}
                        </Mono>
                        <div className="mt-0.5 text-[11px] text-[var(--forge-text-subtle)]">
                          declared as {match.dependency.range} · {match.matchKind} match
                        </div>
                      </Td>
                      <Td>
                        <div>{match.advisory.summary}</div>
                        <div className="mt-0.5 text-[11px] text-[var(--forge-text-subtle)]">
                          {(match.advisory.aliases ?? [match.advisory.id]).join(', ')}
                        </div>
                      </Td>
                      <Td>
                        {match.advisory.patchedVersion ? (
                          <Badge tone="success">→ {match.advisory.patchedVersion}</Badge>
                        ) : (
                          <Badge tone="warning">no fix published</Badge>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </ScrollTable>
            </Section>
          ) : null}

          <Section
            title="Compliance"
            description="Controls with no corresponding scanner are reported as not assessed — never as passing."
          >
            <ScrollTable>
              <thead>
                <tr>
                  <Th>Framework</Th>
                  <Th>Control</Th>
                  <Th>Status</Th>
                  <Th align="right">Findings</Th>
                </tr>
              </thead>
              <tbody>
                {latest.report.compliance.map((control) => (
                  <tr key={`${control.framework}-${control.id}`}>
                    <Td>
                      <span className="text-[12px] text-[var(--forge-text-muted)]">
                        {control.framework}
                      </span>
                    </Td>
                    <Td>
                      <div className="font-medium">
                        {control.id} — {control.title}
                      </div>
                      <div className="mt-0.5 text-[12px] text-[var(--forge-text-muted)]">
                        {control.detail}
                      </div>
                    </Td>
                    <Td>
                      <Badge
                        tone={
                          control.status === 'pass'
                            ? 'success'
                            : control.status === 'fail'
                              ? 'danger'
                              : 'neutral'
                        }
                      >
                        {control.status.replace('-', ' ')}
                      </Badge>
                    </Td>
                    <Td align="right">{control.findings}</Td>
                  </tr>
                ))}
              </tbody>
            </ScrollTable>
          </Section>
        </>
      )}
    </>
  );
}
