import { groupHits, type SearchKind } from '@forgeos/core';
import { route } from '@/lib/server/http';
import { getSearchIndex } from '@/lib/server/search';

export const dynamic = 'force-dynamic';

const VALID_KINDS: readonly SearchKind[] = [
  'repository',
  'file',
  'symbol',
  'document',
  'api',
  'memory',
  'workflow',
  'benchmark',
  'finding',
  'conversation',
];

export const GET = route(
  async ({ workspace, request }) => {
    const url = new URL(request.url);
    const query = (url.searchParams.get('q') ?? '').trim();
    if (query === '') return { results: [], groups: [], total: 0 };

    const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 20));
    const kinds = (url.searchParams.get('kinds') ?? '')
      .split(',')
      .map((kind) => kind.trim())
      .filter((kind): kind is SearchKind => (VALID_KINDS as readonly string[]).includes(kind));

    const index = await getSearchIndex(workspace.id);
    const hits = index.search(query, {
      limit,
      workspaceId: workspace.id,
      ...(kinds.length > 0 ? { kinds } : {}),
    });

    const results = hits.map((hit) => ({
      id: hit.document.id,
      kind: hit.document.kind,
      title: hit.document.title,
      href: hit.document.href,
      excerpt: hit.excerpt,
      score: hit.score,
      matched: hit.matched,
    }));

    return {
      results,
      groups: groupHits(hits).map((group) => ({ kind: group.kind, count: group.hits.length })),
      total: results.length,
      indexed: index.size,
    };
  },
  { limit: 300 }
);
