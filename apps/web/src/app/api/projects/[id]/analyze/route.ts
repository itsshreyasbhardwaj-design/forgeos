import { summariseAnalysis } from '@forgeos/core';
import { route } from '@/lib/server/http';
import { analyseProject } from '@/lib/server/projects';
import { invalidateSearchIndex } from '@/lib/server/search';

export const dynamic = 'force-dynamic';
// Analysis of a large repository is slow; give it room before the platform
// times the function out.
export const maxDuration = 300;

function projectIdFrom(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const index = segments.lastIndexOf('projects');
  return decodeURIComponent(segments[index + 1] ?? '');
}

export const POST = route(
  async ({ workspace, request }) => {
    const { analysis } = await analyseProject(workspace.id, projectIdFrom(request));
    invalidateSearchIndex(workspace.id);
    return summariseAnalysis(analysis);
  },
  // Analysis is the most expensive operation in the product; rate limit it hard.
  { limit: 10, windowMs: 60_000, audit: 'project.analyze' }
);
