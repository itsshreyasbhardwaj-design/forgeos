import { createId, type Workflow } from '@forgeos/core';
import type { StoredWorkflow } from '@forgeos/db';
import { getContext } from '@/lib/server/context';
import { route, readJson, requireString } from '@/lib/server/http';
import { createWorkflowEngine } from '@/lib/server/workflow-nodes';
import { invalidateSearchIndex } from '@/lib/server/search';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ workspace }) => {
  const { store } = await getContext();
  const engine = createWorkflowEngine(workspace.id);
  const workflows = await store.listWorkflows(workspace.id, { limit: 200 });

  return {
    items: await Promise.all(
      workflows.map(async (workflow) => {
        const runs = await store.listWorkflowRuns(workspace.id, workflow.id, { limit: 5 });
        return {
          id: workflow.id,
          name: workflow.definition.name,
          description: workflow.definition.description ?? null,
          nodes: workflow.definition.nodes.length,
          edges: workflow.definition.edges.length,
          enabled: workflow.enabled,
          updatedAt: workflow.updatedAt,
          lastRunAt: workflow.lastRunAt ?? null,
          recentRuns: runs.map((entry) => ({
            id: entry.id,
            status: entry.run.status,
            durationMs: entry.run.durationMs,
            createdAt: entry.createdAt,
          })),
          issues: engine.validate(workflow.definition),
        };
      })
    ),
    nodeTypes: engine.nodeTypes.map((node) => ({
      type: node.type,
      label: node.label,
      description: node.description,
      category: node.category,
      fields: node.fields ?? [],
    })),
  };
});

export const POST = route(
  async ({ workspace, request }) => {
    const { store } = await getContext();
    const body = await readJson(request);
    const name = requireString(body, 'name', 120);

    const definition: Workflow = {
      id: typeof body.id === 'string' ? body.id : createId('wfl'),
      name,
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      nodes: Array.isArray(body.nodes) ? (body.nodes as Workflow['nodes']) : [],
      edges: Array.isArray(body.edges) ? (body.edges as Workflow['edges']) : [],
      version: 1,
    };

    const engine = createWorkflowEngine(workspace.id);
    const issues = engine.validate(definition);

    const now = Date.now();
    const existing = await store.getWorkflow(workspace.id, definition.id);

    const record: StoredWorkflow = {
      id: definition.id,
      workspaceId: workspace.id,
      definition: { ...definition, version: (existing?.definition.version ?? 0) + 1 },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      enabled: body.enabled !== false,
    };

    await store.saveWorkflow(record);
    await store.recordActivity({
      id: createId('act', now),
      workspaceId: workspace.id,
      kind: 'workflow.created',
      actorId: 'system',
      summary: `${existing ? 'Updated' : 'Created'} workflow “${definition.name}”`,
      createdAt: now,
      targetId: record.id,
      targetHref: `/workflows`,
    });

    invalidateSearchIndex(workspace.id);
    return { workflow: record, issues };
  },
  { limit: 60, audit: 'workflow.save' }
);
