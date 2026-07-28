import { route } from '@/lib/server/http';
import { requireAnalysis } from '@/lib/server/projects';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function projectIdFrom(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const index = segments.lastIndexOf('projects');
  return decodeURIComponent(segments[index + 1] ?? '');
}

/**
 * The full analysis document.
 *
 * `?view=` trims the payload: a repository with 20k files produces a large
 * object, and most consumers want one section of it.
 */
export const GET = route(async ({ workspace, request }) => {
  const analysis = await requireAnalysis(workspace.id, projectIdFrom(request));
  const view = new URL(request.url).searchParams.get('view');

  switch (view) {
    case 'graph':
      return { graph: analysis.graph, layers: analysis.layers, cycles: analysis.cycles };
    case 'debt':
      return { debt: analysis.debt, hotspots: analysis.hotspots };
    case 'api':
      return { api: analysis.api, schema: analysis.schema };
    case 'tree':
      return { tree: analysis.tree };
    case 'overview':
      return {
        overview: analysis.overview,
        languages: analysis.languages,
        stack: analysis.stack,
        environment: analysis.environment,
      };
    default:
      return analysis;
  }
});
