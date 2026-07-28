import { notFound } from '@forgeos/core';
import { getContext } from '@/lib/server/context';
import { route } from '@/lib/server/http';
import { invalidateSearchIndex } from '@/lib/server/search';

export const dynamic = 'force-dynamic';

/** Extract `[id]` without depending on the framework's params plumbing. */
function projectIdFrom(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  // .../api/projects/<id>
  const index = segments.lastIndexOf('projects');
  return decodeURIComponent(segments[index + 1] ?? '');
}

export const GET = route(async ({ workspace, request }) => {
  const { store } = await getContext();
  const id = projectIdFrom(request);
  const project = await store.getProject(workspace.id, id);
  if (!project) throw notFound('project', id);

  const latest = await store.getLatestAnalysis(workspace.id, id);
  return {
    ...project,
    health: latest?.analysis.debt.score ?? null,
    grade: latest?.analysis.debt.grade ?? null,
    lastAnalysisId: latest?.id ?? null,
  };
});

export const DELETE = route(
  async ({ workspace, request }) => {
    const { store } = await getContext();
    const id = projectIdFrom(request);
    const deleted = await store.deleteProject(workspace.id, id);
    if (!deleted) throw notFound('project', id);
    invalidateSearchIndex(workspace.id);
    return { deleted: true };
  },
  { limit: 30, audit: 'project.delete' }
);
