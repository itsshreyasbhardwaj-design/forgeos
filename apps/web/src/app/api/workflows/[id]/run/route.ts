import { createId, notFound } from '@forgeos/core';
import { getContext } from '@/lib/server/context';
import { route, readJson } from '@/lib/server/http';
import { createWorkflowEngine } from '@/lib/server/workflow-nodes';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function workflowIdFrom(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const index = segments.lastIndexOf('workflows');
  return decodeURIComponent(segments[index + 1] ?? '');
}

export const POST = route(
  async ({ workspace, request }) => {
    const { store, logger } = await getContext();
    const id = workflowIdFrom(request);

    const workflow = await store.getWorkflow(workspace.id, id);
    if (!workflow) throw notFound('workflow', id);

    const body = await readJson(request);
    const engine = createWorkflowEngine(workspace.id);

    const run = await engine.execute(workflow.definition, {
      workspaceId: workspace.id,
      input: body.input ?? null,
      logger: logger.child('workflow', { workflowId: id }),
    });

    const now = Date.now();
    await store.saveWorkflowRun({
      id: run.id,
      workspaceId: workspace.id,
      workflowId: id,
      createdAt: now,
      run,
    });
    await store.saveWorkflow({ ...workflow, lastRunAt: now });
    await store.recordActivity({
      id: createId('act', now),
      workspaceId: workspace.id,
      kind: 'workflow.run',
      actorId: 'system',
      summary: `Ran “${workflow.definition.name}” — ${run.status} in ${run.durationMs}ms`,
      createdAt: now,
      targetId: id,
      targetHref: '/workflows',
    });

    return run;
  },
  { limit: 30, audit: 'workflow.run' }
);
