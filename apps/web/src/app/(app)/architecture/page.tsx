import Link from 'next/link';
import { Badge, Card, EmptyState } from '@forgeos/ui';
import { Network } from 'lucide-react';
import { toMermaidErd, toMermaidLayerDiagram, findLayerViolations } from '@forgeos/core';
import { getActiveWorkspace, getContext } from '@/lib/server/context';
import { requireAnalysis } from '@/lib/server/projects';
import { PageHeader, Section, ScrollTable, Td, Th, Mono } from '@/components/primitives';
import { ModuleGraphView, LayerLegend } from '@/components/module-graph';
import { MermaidDiagram } from '@/components/mermaid';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export const metadata = { title: 'Architecture' };

export default async function ArchitecturePage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project: requested } = await searchParams;
  const workspace = await getActiveWorkspace();
  const { store } = await getContext();
  const projects = await store.listProjects(workspace.id, { limit: 100 });

  if (projects.length === 0) {
    return (
      <>
        <PageHeader title="Architecture" description="Interactive views of how a codebase fits together." />
        <Section>
          <Card>
            <EmptyState
              icon={<Network className="h-5 w-5" />}
              title="No repositories to visualise"
              description="Add a repository first — the architecture views are derived from its analysis."
              action={
                <Link
                  href="/repositories"
                  className="rounded-[var(--forge-radius)] bg-[var(--forge-accent)] px-4 py-2 text-[13px] font-medium text-white"
                >
                  Add a repository
                </Link>
              }
            />
          </Card>
        </Section>
      </>
    );
  }

  const selected = projects.find((entry) => entry.id === requested) ?? projects[0];
  if (!selected) return null;

  const analysis = await requireAnalysis(workspace.id, selected.id);
  const violations = findLayerViolations(analysis.graph);

  return (
    <>
      <PageHeader
        title="Architecture"
        description="Module graph, layering, data model and HTTP surface — all derived from the code, not from a diagram someone drew once."
        meta={
          <div className="flex flex-wrap gap-1.5">
            {projects.map((entry) => (
              <Link key={entry.id} href={`/architecture?project=${entry.id}`}>
                <Badge tone={entry.id === selected.id ? 'accent' : 'neutral'}>{entry.name}</Badge>
              </Link>
            ))}
          </div>
        }
      />

      <Section
        title="Module graph"
        description={`${analysis.graph.nodes.length} modules, ${analysis.graph.edges.length} import relationships. Hover to isolate a neighbourhood.`}
      >
        <div className="mb-3">
          <LayerLegend layers={analysis.layers.map((layer) => layer.layer)} />
        </div>
        <ModuleGraphView graph={analysis.graph} maxNodes={60} />
      </Section>

      {analysis.layers.length > 0 ? (
        <Section
          title="Layers"
          description={
            violations.length > 0
              ? `${violations.length} import${violations.length === 1 ? '' : 's'} point against the intended dependency direction.`
              : 'Dependencies flow in the expected direction.'
          }
        >
          <div className="grid gap-6 lg:grid-cols-2">
            <MermaidDiagram chart={toMermaidLayerDiagram(analysis.layers, violations)} />
            <div>
              <ScrollTable>
                <thead>
                  <tr>
                    <Th>Layer</Th>
                    <Th align="right">Modules</Th>
                    <Th align="right">LOC</Th>
                    <Th>Depends on</Th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.layers.map((layer) => (
                    <tr key={layer.layer}>
                      <Td>{layer.layer}</Td>
                      <Td align="right">{layer.modules}</Td>
                      <Td align="right">{layer.loc.toLocaleString()}</Td>
                      <Td>
                        <span className="text-[12px] text-[var(--forge-text-muted)]">
                          {Object.entries(layer.dependsOn)
                            .map(([target, count]) => `${target} (${count})`)
                            .join(', ') || '—'}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </ScrollTable>

              {violations.length > 0 ? (
                <div className="mt-4 rounded-[var(--forge-radius-lg)] border border-[var(--forge-warning)] bg-[var(--forge-warning-subtle)] p-4">
                  <h4 className="text-[13px] font-semibold">Layering violations</h4>
                  <ul className="mt-2 space-y-1">
                    {violations.slice(0, 8).map((violation, index) => (
                      <li key={index} className="text-[12px]">
                        <Mono>{violation.from}</Mono>{' '}
                        <span className="text-[var(--forge-text-muted)]">
                          ({violation.fromLayer}) imports
                        </span>{' '}
                        <Mono>{violation.to}</Mono>{' '}
                        <span className="text-[var(--forge-text-muted)]">({violation.toLayer})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
        </Section>
      ) : null}

      {analysis.schema.entities.length > 0 ? (
        <Section
          title="Data model"
          description={`${analysis.schema.entities.length} entities extracted from ${analysis.schema.sources.join(', ')} (${analysis.schema.dialect}).`}
        >
          <MermaidDiagram chart={toMermaidErd(analysis.schema.entities, analysis.schema.relations)} />
        </Section>
      ) : null}

      {analysis.api.routes.length > 0 ? (
        <Section
          title="HTTP surface"
          description={`${analysis.api.routes.length} endpoints discovered via ${analysis.api.frameworks.join(', ')}.`}
        >
          <ScrollTable>
            <thead>
              <tr>
                <Th>Method</Th>
                <Th>Path</Th>
                <Th>Defined in</Th>
                <Th>Framework</Th>
              </tr>
            </thead>
            <tbody>
              {analysis.api.routes.map((route) => (
                <tr key={`${route.method} ${route.path}`}>
                  <Td>
                    <Badge tone={route.method === 'GET' ? 'info' : route.method === 'DELETE' ? 'danger' : 'accent'}>
                      {route.method}
                    </Badge>
                  </Td>
                  <Td>
                    <Mono>{route.path}</Mono>
                  </Td>
                  <Td>
                    <span className="font-[var(--forge-font-mono)] text-[11px] text-[var(--forge-text-muted)]">
                      {route.file}
                      {route.line > 1 ? `:${route.line}` : ''}
                    </span>
                  </Td>
                  <Td>{route.framework}</Td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        </Section>
      ) : null}

      <Section title="External dependencies" description="Packages imported by this codebase, ranked by how many modules use them.">
        <div className="flex flex-wrap gap-2">
          {analysis.graph.externals.slice(0, 40).map((external) => (
            <span
              key={external.name}
              className="inline-flex items-center gap-2 rounded-full border border-[var(--forge-border)] px-3 py-1 text-[12px]"
              title={`Imported by ${external.count} module(s)`}
            >
              <span className="font-[var(--forge-font-mono)]">{external.name}</span>
              <span className="tabular-nums text-[var(--forge-text-subtle)]">{external.count}</span>
            </span>
          ))}
        </div>
      </Section>
    </>
  );
}
