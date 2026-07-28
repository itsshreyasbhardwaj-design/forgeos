import {
  generateApiMarkdown,
  generateCurlExamples,
  generatePythonSdk,
  generateTypeScriptSdk,
  notFound,
} from '@forgeos/core';
import { getContext } from '@/lib/server/context';
import { route, readJson } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

function specIdFrom(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const index = segments.lastIndexOf('specs');
  return decodeURIComponent(segments[index + 1] ?? '');
}

export const POST = route(async ({ workspace, request }) => {
  const { store } = await getContext();
  const id = specIdFrom(request);
  const record = await store.getApiSpec(workspace.id, id);
  if (!record) throw notFound('specification', id);

  const body = await readJson(request);
  const language = typeof body.language === 'string' ? body.language : 'typescript';

  const files =
    language === 'python'
      ? [generatePythonSdk(record.spec)]
      : language === 'curl'
        ? [generateCurlExamples(record.spec)]
        : language === 'markdown'
          ? [generateApiMarkdown(record.spec)]
          : [generateTypeScriptSdk(record.spec)];

  return { files };
});
