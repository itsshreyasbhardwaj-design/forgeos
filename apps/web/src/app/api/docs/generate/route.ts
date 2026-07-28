import { createId, generateAll } from '@forgeos/core';
import type { StoredDocument } from '@forgeos/db';
import { getContext } from '@/lib/server/context';
import { route, readJson, requireString } from '@/lib/server/http';
import { requireAnalysis } from '@/lib/server/projects';
import { invalidateSearchIndex } from '@/lib/server/search';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const POST = route(
  async ({ workspace, user, request }) => {
    const { store } = await getContext();
    const body = await readJson(request);
    const projectId = requireString(body, 'projectId', 64);

    const requested = Array.isArray(body.kinds)
      ? new Set((body.kinds as string[]).map(String))
      : null;

    const analysis = await requireAnalysis(workspace.id, projectId);
    const generated = generateAll(analysis).filter(
      (document) => !requested || requested.has(document.kind)
    );

    const now = Date.now();
    const saved: StoredDocument[] = [];

    for (const document of generated) {
      // Re-generating replaces the previous copy of the same kind for the same
      // project, and keeps the old text as a version rather than losing it.
      const existing = (await store.listDocuments(workspace.id, { projectId, limit: 100 })).find(
        (candidate) => candidate.kind === document.kind
      );

      const record: StoredDocument = {
        id: existing?.id ?? createId('doc', now),
        workspaceId: workspace.id,
        projectId,
        kind: document.kind,
        title: document.title,
        markdown: document.markdown,
        version: (existing?.version ?? 0) + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        authorId: user.id,
        hash: document.hash,
        gaps: document.gaps,
      };

      if (existing && existing.hash !== document.hash) {
        await store.saveDocumentVersion({
          id: createId('dvr', now),
          documentId: existing.id,
          version: existing.version,
          markdown: existing.markdown,
          createdAt: existing.updatedAt,
          authorId: existing.authorId,
          note: 'Superseded by regeneration',
        });
      }

      await store.saveDocument(record);
      saved.push(record);
    }

    await store.recordActivity({
      id: createId('act', now),
      workspaceId: workspace.id,
      kind: 'document.created',
      actorId: user.id,
      summary: `Generated ${saved.length} document${saved.length === 1 ? '' : 's'} for “${analysis.overview.name}”`,
      createdAt: now,
      targetHref: '/documentation',
    });

    invalidateSearchIndex(workspace.id);

    return {
      documents: saved.map((document) => ({
        id: document.id,
        kind: document.kind,
        title: document.title,
        version: document.version,
        words: document.markdown.split(/\s+/).filter(Boolean).length,
        gaps: document.gaps ?? [],
      })),
    };
  },
  { limit: 20, audit: 'docs.generate' }
);
