import {
  createId,
  createSpec,
  fromOpenApiDocument,
  specFromRoutes,
  validateSpec,
  type ApiSpec,
} from '@forgeos/core';
import type { StoredApiSpec } from '@forgeos/db';
import { getContext } from '@/lib/server/context';
import { route, readJson, requireString, optionalString } from '@/lib/server/http';
import { requireAnalysis } from '@/lib/server/projects';
import { invalidateSearchIndex } from '@/lib/server/search';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ workspace }) => {
  const { store } = await getContext();
  const specs = await store.listApiSpecs(workspace.id, { limit: 200 });
  return {
    items: specs.map((record) => ({
      id: record.id,
      name: record.name,
      version: record.spec.info.version,
      operations: record.spec.operations.length,
      updatedAt: record.updatedAt,
      projectId: record.projectId ?? null,
      issues: validateSpec(record.spec).length,
    })),
    total: specs.length,
  };
});

/**
 * Create a specification three ways: empty, imported from an OpenAPI document,
 * or derived from the routes ForgeOS discovered in a repository. The third is
 * the one that makes this module immediately useful.
 */
export const POST = route(
  async ({ workspace, request }) => {
    const { store } = await getContext();
    const body = await readJson(request);
    const name = requireString(body, 'name', 120);
    const projectId = optionalString(body, 'projectId');

    let spec: ApiSpec;

    if (body.document && typeof body.document === 'object') {
      spec = fromOpenApiDocument(body.document as Record<string, unknown>);
    } else if (projectId) {
      const analysis = await requireAnalysis(workspace.id, projectId);
      spec = specFromRoutes(analysis.api.routes, {
        title: name,
        version: '1.0.0',
        description: `Derived from ${analysis.api.routes.length} routes discovered in ${analysis.overview.name}.`,
      });
    } else {
      spec = createSpec({ title: name, version: '1.0.0' });
    }

    const now = Date.now();
    const record: StoredApiSpec = {
      id: createId('api', now),
      workspaceId: workspace.id,
      ...(projectId ? { projectId } : {}),
      name,
      createdAt: now,
      updatedAt: now,
      spec,
    };

    await store.saveApiSpec(record);
    await store.recordActivity({
      id: createId('act', now),
      workspaceId: workspace.id,
      kind: 'api.created',
      actorId: 'system',
      summary: `Created API specification “${name}” with ${spec.operations.length} operations`,
      createdAt: now,
      targetId: record.id,
      targetHref: `/apis/${record.id}`,
    });

    invalidateSearchIndex(workspace.id);
    return { spec: record, issues: validateSpec(spec) };
  },
  { limit: 40, audit: 'spec.create' }
);
