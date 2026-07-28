import { Badge, Card, CardContent, EmptyState } from '@forgeos/ui';
import { Workflow as WorkflowIcon, CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import { getActiveWorkspace, getContext } from '@/lib/server/context';
import { createWorkflowEngine } from '@/lib/server/workflow-nodes';
import { PageHeader, Section, Mono } from '@/components/primitives';
import { RunWorkflowButton } from '@/components/actions';
import { SeedWorkflowButton } from '@/components/seed-workflow';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export const metadata = { title: 'Workflows' };

const STATUS_ICON = {
  succeeded: CheckCircle2,
  failed: XCircle,
  skipped: MinusCircle,
  running: MinusCircle,
  pending: MinusCircle,
} as const;

export default async function WorkflowsPage() {
  const workspace = await getActiveWorkspace();
  const { store } = await getContext();
  const engine = createWorkflowEngine(workspace.id);

  const workflows = await store.listWorkflows(workspace.id, { limit: 100 });
  const runs = await store.listWorkflowRuns(workspace.id, undefined, { limit: 10 });
  const projects = await store.listProjects(workspace.id, { limit: 5 });

  return (
    <>
      <PageHeader
        title="Workflows"
        description="Compose the modules into multi-step automations. Every run records a complete trace: inputs, outputs, retries and timings for each node."
        actions={projects[0] ? <SeedWorkflowButton projectId={projects[0].id} /> : null}
      />

      <Section
        title="Available node types"
        description="Nodes wrap the same engines the rest of the product uses, so a workflow produces exactly what the corresponding module would."
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {engine.nodeTypes.map((node) => (
            <Card key={node.type}>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold">{node.label}</span>
                  <Badge tone="neutral">{node.category}</Badge>
                </div>
                <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--forge-text-muted)]">
                  {node.description}
                </p>
                <div className="mt-2">
                  <Mono>{node.type}</Mono>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </Section>

      <Section title={`${workflows.length} workflow${workflows.length === 1 ? '' : 's'}`}>
        {workflows.length === 0 ? (
          <Card>
            <EmptyState
              icon={<WorkflowIcon className="h-5 w-5" />}
              title="No workflows yet"
              description="Create a starter workflow that analyses a repository, scans it for security problems, and produces a written summary."
            />
          </Card>
        ) : (
          <div className="space-y-3">
            {workflows.map((workflow) => {
              const issues = engine.validate(workflow.definition);
              const errors = issues.filter((issue) => issue.severity === 'error');
              return (
                <Card key={workflow.id}>
                  <CardContent className="pt-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold">{workflow.definition.name}</span>
                          <Badge tone={workflow.enabled ? 'success' : 'neutral'}>
                            {workflow.enabled ? 'enabled' : 'disabled'}
                          </Badge>
                          {errors.length > 0 ? (
                            <Badge tone="danger">{errors.length} errors</Badge>
                          ) : (
                            <Badge tone="success">valid</Badge>
                          )}
                        </div>
                        {workflow.definition.description ? (
                          <p className="mt-1 text-[13px] text-[var(--forge-text-muted)]">
                            {workflow.definition.description}
                          </p>
                        ) : null}
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {workflow.definition.nodes.map((node) => (
                            <span
                              key={node.id}
                              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--forge-border)] px-2.5 py-1 text-[11px]"
                            >
                              {node.label}
                            </span>
                          ))}
                        </div>
                      </div>
                      <RunWorkflowButton workflowId={workflow.id} />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </Section>

      {runs.length > 0 ? (
        <Section title="Recent runs" description="Full execution traces — this is what makes a visual builder debuggable.">
          <div className="space-y-3">
            {runs.map((entry) => (
              <Card key={entry.id}>
                <CardContent className="pt-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        entry.run.status === 'succeeded'
                          ? 'success'
                          : entry.run.status === 'failed'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {entry.run.status}
                    </Badge>
                    <span className="text-[12px] text-[var(--forge-text-muted)]">
                      {entry.run.durationMs}ms · {new Date(entry.createdAt).toLocaleString()}
                    </span>
                    {entry.run.error ? (
                      <span className="text-[12px] text-[var(--forge-danger)]">
                        {entry.run.error}
                      </span>
                    ) : null}
                  </div>

                  <ol className="space-y-1.5">
                    {entry.run.trace.map((step) => {
                      const Icon = STATUS_ICON[step.status] ?? MinusCircle;
                      return (
                        <li key={step.nodeId} className="flex items-start gap-2.5 text-[12px]">
                          <Icon
                            className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                              step.status === 'succeeded'
                                ? 'text-[var(--forge-success)]'
                                : step.status === 'failed'
                                  ? 'text-[var(--forge-danger)]'
                                  : 'text-[var(--forge-text-subtle)]'
                            }`}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{step.label}</span>
                              <Mono>{step.type}</Mono>
                              <span className="text-[var(--forge-text-subtle)]">
                                {step.durationMs}ms
                                {step.attempts > 1 ? ` · ${step.attempts} attempts` : ''}
                              </span>
                            </div>
                            {step.error ? (
                              <div className="mt-0.5 text-[var(--forge-danger)]">{step.error}</div>
                            ) : null}
                            {step.skippedReason ? (
                              <div className="mt-0.5 text-[var(--forge-text-subtle)]">
                                {step.skippedReason}
                              </div>
                            ) : null}
                            {step.logs.length > 0 ? (
                              <ul className="mt-1 space-y-0.5">
                                {step.logs.map((log, index) => (
                                  <li key={index} className="text-[11px] text-[var(--forge-text-muted)]">
                                    · {log.message}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </CardContent>
              </Card>
            ))}
          </div>
        </Section>
      ) : null}
    </>
  );
}
