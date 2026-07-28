import { getContext } from '@/lib/server/context';
import { route } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ workspace, request }) => {
  const { store } = await getContext();
  const url = new URL(request.url);
  const projectId = url.searchParams.get('projectId') ?? undefined;
  const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 50));
  const includeBody = url.searchParams.get('body') === 'true';

  const documents = await store.listDocuments(workspace.id, {
    limit,
    ...(projectId ? { projectId } : {}),
  });

  return {
    items: documents.map((document) => ({
      id: document.id,
      kind: document.kind,
      title: document.title,
      version: document.version,
      updatedAt: document.updatedAt,
      projectId: document.projectId ?? null,
      gaps: document.gaps ?? [],
      words: document.markdown.split(/\s+/).filter(Boolean).length,
      ...(includeBody ? { markdown: document.markdown } : {}),
    })),
    total: documents.length,
  };
});
