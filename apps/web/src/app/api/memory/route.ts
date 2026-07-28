import { buildKnowledgeGraph, centralEntities, createId } from '@forgeos/core';
import { getContext, hydrateMemory } from '@/lib/server/context';
import { route, readJson, requireString } from '@/lib/server/http';
import { invalidateSearchIndex } from '@/lib/server/search';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ workspace, request }) => {
  const { store } = await getContext();
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') ?? '').trim();
  const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 20));

  if (query === '') {
    const memories = await store.listMemories(workspace.id, { limit });
    const graph = buildKnowledgeGraph(memories);
    return {
      results: memories.map((memory) => ({ memory, score: 0, similarity: 0 })),
      total: memories.length,
      graph: {
        entities: graph.entities.slice(0, 60),
        edges: graph.edges.slice(0, 120),
        central: centralEntities(graph, 8),
      },
    };
  }

  const memory = await hydrateMemory(workspace.id);
  const results = await memory.retrieve(workspace.id, query, { limit });

  return {
    results: results.map((result) => ({
      memory: result.memory,
      score: result.score,
      similarity: result.similarity,
      lexicalRank: result.lexicalRank,
      semanticRank: result.semanticRank,
    })),
    total: results.length,
  };
});

export const POST = route(
  async ({ workspace, request }) => {
    const { store } = await getContext();
    const body = await readJson(request);
    const content = requireString(body, 'content', 8000);

    const memoryStore = await hydrateMemory(workspace.id);
    const created = await memoryStore.remember({
      workspaceId: workspace.id,
      content,
      kind: (typeof body.kind === 'string' ? body.kind : 'fact') as 'fact',
      tags: Array.isArray(body.tags) ? (body.tags as string[]).slice(0, 12).map(String) : [],
      source: typeof body.source === 'string' ? body.source : 'manual',
      ...(typeof body.importance === 'number' ? { importance: body.importance } : {}),
      ...(typeof body.projectId === 'string' ? { projectId: body.projectId } : {}),
    });

    await store.saveMemory(created);
    await store.recordActivity({
      id: createId('act'),
      workspaceId: workspace.id,
      kind: 'memory.created',
      actorId: 'system',
      summary: `Remembered: ${created.content.slice(0, 80)}`,
      createdAt: Date.now(),
      targetId: created.id,
      targetHref: '/memory',
    });

    invalidateSearchIndex(workspace.id);
    return created;
  },
  { limit: 120, audit: 'memory.create' }
);
