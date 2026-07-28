import { Badge, Card, CardContent, EmptyState } from '@forgeos/ui';
import { Braces } from 'lucide-react';
import { exampleForSchema, handleMockRequest, validateSpec } from '@forgeos/core';
import { getActiveWorkspace, getContext } from '@/lib/server/context';
import { PageHeader, Section, Mono, ScrollTable, Td, Th } from '@/components/primitives';
import { CreateSpecButton } from '@/components/actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'API platform' };

export default async function ApisPage() {
  const workspace = await getActiveWorkspace();
  const { store } = await getContext();

  const specs = await store.listApiSpecs(workspace.id, { limit: 100 });
  const projects = await store.listProjects(workspace.id, { limit: 20 });

  // Pick a repository that actually exposes routes, so "derive from routes" is
  // offered only when it would produce something.
  let derivable: { id: string; name: string } | null = null;
  for (const project of projects) {
    const latest = await store.getLatestAnalysis(workspace.id, project.id);
    if (latest && latest.analysis.api.routes.length > 0) {
      derivable = { id: project.id, name: project.name };
      break;
    }
  }

  const selected = specs[0];
  const issues = selected ? validateSpec(selected.spec) : [];

  // Exercise the mock server so the page shows a real response, not a mock-up.
  const sampleOperation = selected?.spec.operations[0];
  const sampleResponse = selected && sampleOperation
    ? handleMockRequest(selected.spec, {
        method: sampleOperation.method,
        path: sampleOperation.path.replace(/:(\w+)/g, 'example'),
      })
    : null;

  return (
    <>
      <PageHeader
        title="API platform"
        description="Design a specification, mock it, validate requests against it, and generate typed SDKs — from one source of truth."
        actions={
          <div className="flex gap-2">
            {derivable ? <CreateSpecButton projectId={derivable.id} name={`${derivable.name} API`} /> : null}
            <CreateSpecButton name="New API" />
          </div>
        }
      />

      {specs.length === 0 ? (
        <Section>
          <Card>
            <EmptyState
              icon={<Braces className="h-5 w-5" />}
              title="No specifications yet"
              description={
                derivable
                  ? `ForgeOS found HTTP routes in ${derivable.name}. Derive a specification from them in one click, then refine it.`
                  : 'Create an empty specification, or analyse a repository with HTTP routes and derive one automatically.'
              }
            />
          </Card>
        </Section>
      ) : (
        <>
          <Section title={`${specs.length} specification${specs.length === 1 ? '' : 's'}`}>
            <div className="space-y-2">
              {specs.map((record) => (
                <Card key={record.id}>
                  <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">{record.name}</span>
                        <Badge tone="neutral">v{record.spec.info.version}</Badge>
                      </div>
                      <p className="mt-1 text-[12px] text-[var(--forge-text-muted)]">
                        {record.spec.operations.length} operations ·{' '}
                        {Object.keys(record.spec.schemas).length} schemas ·{' '}
                        {record.spec.securitySchemes.length} security schemes
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {validateSpec(record.spec).filter((issue) => issue.severity === 'error')
                        .length > 0 ? (
                        <Badge tone="danger">
                          {validateSpec(record.spec).filter((issue) => issue.severity === 'error').length}{' '}
                          errors
                        </Badge>
                      ) : (
                        <Badge tone="success">valid</Badge>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </Section>

          {selected ? (
            <>
              <Section
                title="Operations"
                description={`${selected.name} — ${selected.spec.operations.length} operations.`}
              >
                <ScrollTable>
                  <thead>
                    <tr>
                      <Th>Method</Th>
                      <Th>Path</Th>
                      <Th>Operation id</Th>
                      <Th>Responses</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.spec.operations.map((operation) => (
                      <tr key={operation.id}>
                        <Td>
                          <Badge tone={operation.method === 'get' ? 'info' : 'accent'}>
                            {operation.method.toUpperCase()}
                          </Badge>
                        </Td>
                        <Td>
                          <Mono>{operation.path}</Mono>
                          {operation.summary ? (
                            <div className="mt-0.5 text-[12px] text-[var(--forge-text-muted)]">
                              {operation.summary}
                            </div>
                          ) : null}
                        </Td>
                        <Td>
                          <Mono>{operation.id}</Mono>
                        </Td>
                        <Td>
                          <div className="flex flex-wrap gap-1">
                            {operation.responses.map((response) => (
                              <Badge
                                key={response.status}
                                tone={
                                  response.status.startsWith('2')
                                    ? 'success'
                                    : response.status.startsWith('4')
                                      ? 'warning'
                                      : 'danger'
                                }
                              >
                                {response.status}
                              </Badge>
                            ))}
                          </div>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </ScrollTable>
              </Section>

              {sampleResponse && sampleOperation ? (
                <Section
                  title="Mock server"
                  description="Responses are deterministic per operation and status, which is what makes a mock usable as a test fixture."
                >
                  <Card>
                    <CardContent className="pt-5">
                      <div className="mb-3 flex items-center gap-2">
                        <Badge tone="accent">
                          {sampleOperation.method.toUpperCase()} {sampleOperation.path}
                        </Badge>
                        <Badge tone={sampleResponse.status < 400 ? 'success' : 'danger'}>
                          {sampleResponse.status}
                        </Badge>
                      </div>
                      <pre className="overflow-x-auto rounded-[var(--forge-radius)] border border-[var(--forge-border)] bg-[var(--forge-bg-subtle)] p-3 text-[11px]">
                        <code>{JSON.stringify(sampleResponse.body, null, 2)}</code>
                      </pre>
                    </CardContent>
                  </Card>
                </Section>
              ) : null}

              {Object.keys(selected.spec.schemas).length > 0 ? (
                <Section title="Schemas">
                  <div className="grid gap-3 md:grid-cols-2">
                    {Object.entries(selected.spec.schemas).map(([name, schema]) => (
                      <Card key={name}>
                        <CardContent className="pt-4">
                          <h4 className="mb-2 text-[13px] font-semibold">{name}</h4>
                          <pre className="overflow-x-auto rounded-[var(--forge-radius)] border border-[var(--forge-border)] bg-[var(--forge-bg-subtle)] p-3 text-[11px]">
                            <code>
                              {JSON.stringify(exampleForSchema(schema, selected.spec, name), null, 2)}
                            </code>
                          </pre>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </Section>
              ) : null}

              {issues.length > 0 ? (
                <Section
                  title="Specification review"
                  description="Problems that make an API painful to consume — undocumented errors, missing operation ids, undeclared parameters."
                >
                  <ScrollTable>
                    <thead>
                      <tr>
                        <Th>Severity</Th>
                        <Th>Location</Th>
                        <Th>Issue</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {issues.map((issue, index) => (
                        <tr key={index}>
                          <Td>
                            <Badge tone={issue.severity === 'error' ? 'danger' : 'warning'}>
                              {issue.severity}
                            </Badge>
                          </Td>
                          <Td>
                            <Mono>{issue.path}</Mono>
                          </Td>
                          <Td>{issue.message}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </ScrollTable>
                </Section>
              ) : null}

              <Section title="SDK generation">
                <Card>
                  <CardContent className="pt-5">
                    <p className="text-[13px] text-[var(--forge-text-muted)]">
                      Generate a dependency-free client in TypeScript or Python, plus curl examples
                      and Markdown reference documentation:
                    </p>
                    <pre className="mt-3 overflow-x-auto rounded-[var(--forge-radius)] border border-[var(--forge-border)] bg-[var(--forge-bg-subtle)] p-3 text-[11px]">
                      <code>{`curl -X POST /api/specs/${selected.id}/sdk \\
  -H 'content-type: application/json' \\
  -d '{"language":"typescript"}'`}</code>
                    </pre>
                  </CardContent>
                </Card>
              </Section>
            </>
          ) : null}
        </>
      )}
    </>
  );
}
