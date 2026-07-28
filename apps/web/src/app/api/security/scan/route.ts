import { route, readJson, requireString } from '@/lib/server/http';
import { scanProjectSecurity } from '@/lib/server/projects';
import { invalidateSearchIndex } from '@/lib/server/search';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const POST = route(
  async ({ workspace, request }) => {
    const body = await readJson(request);
    const projectId = requireString(body, 'projectId', 64);
    const stored = await scanProjectSecurity(workspace.id, projectId);
    invalidateSearchIndex(workspace.id);
    return stored.report;
  },
  { limit: 15, windowMs: 60_000, audit: 'security.scan' }
);
