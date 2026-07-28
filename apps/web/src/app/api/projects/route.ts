import { getContext } from '@/lib/server/context';
import { route, readJson, requireString, optionalString } from '@/lib/server/http';
import { createProject } from '@/lib/server/projects';
import { invalidateSearchIndex } from '@/lib/server/search';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ workspace, request }) => {
  const { store } = await getContext();
  const url = new URL(request.url);
  const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 50));
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));

  const projects = await store.listProjects(workspace.id, { limit, offset });
  const items = await Promise.all(
    projects.map(async (project) => {
      const latest = await store.getLatestAnalysis(workspace.id, project.id);
      return {
        ...project,
        health: latest?.analysis.debt.score ?? null,
        grade: latest?.analysis.debt.grade ?? null,
        code: latest?.analysis.overview.code ?? null,
        primaryLanguage: latest?.analysis.overview.primaryLanguage ?? null,
      };
    })
  );

  return { items, total: items.length, limit, offset };
});

export const POST = route(
  async ({ workspace, request }) => {
    const body = await readJson(request);
    const name = requireString(body, 'name', 120);
    const source = requireString(body, 'source', 1000);
    const description = optionalString(body, 'description');

    const project = await createProject({
      workspaceId: workspace.id,
      name,
      source,
      ...(description ? { description } : {}),
      ...(source === 'sample' ? { sourceKind: 'sample' as const } : {}),
    });

    invalidateSearchIndex(workspace.id);
    return project;
  },
  { limit: 30, audit: 'project.create' }
);
