import 'server-only';
import { SearchIndex, type SearchDocument } from '@forgeos/core';
import { getContext } from './context';

/**
 * Workspace-wide search index.
 *
 * Rebuilt from storage on demand and cached briefly. A short TTL is the right
 * trade here: an index that lags by seconds is invisible to users, whereas
 * incremental maintenance across nine modules is a large amount of code whose
 * failure mode — silently stale results — is much harder to notice.
 */
interface CachedIndex {
  readonly index: SearchIndex;
  readonly builtAt: number;
}

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, CachedIndex>();

export function invalidateSearchIndex(workspaceId: string): void {
  cache.delete(workspaceId);
}

export async function getSearchIndex(workspaceId: string): Promise<SearchIndex> {
  const cached = cache.get(workspaceId);
  if (cached && Date.now() - cached.builtAt < CACHE_TTL_MS) return cached.index;

  const { store } = await getContext();
  const index = new SearchIndex();

  const [projects, documents, memories, workflows, specs, benchmarks, reports, conversations] =
    await Promise.all([
      store.listProjects(workspaceId, { limit: 500 }),
      store.listDocuments(workspaceId, { limit: 500 }),
      store.listMemories(workspaceId, { limit: 1000 }),
      store.listWorkflows(workspaceId, { limit: 200 }),
      store.listApiSpecs(workspaceId, { limit: 200 }),
      store.listBenchmarks(workspaceId, { limit: 200 }),
      store.listSecurityReports(workspaceId, undefined, { limit: 50 }),
      store.listConversations(workspaceId, { limit: 200 }),
    ]);

  const documentsToIndex: SearchDocument[] = [];

  for (const project of projects) {
    documentsToIndex.push({
      id: project.id,
      kind: 'repository',
      title: project.name,
      body: `${project.description ?? ''} ${project.source}`,
      href: `/repositories/${project.id}`,
      workspaceId,
      updatedAt: project.updatedAt,
      boost: 1.4,
    });

    // Index the file tree and the highest-risk modules from the latest analysis
    // so that searching for a filename actually finds the file.
    const latest = await store.getLatestAnalysis(workspaceId, project.id);
    if (!latest) continue;

    for (const file of latest.analysis.files.slice(0, 400)) {
      documentsToIndex.push({
        id: `${project.id}:${file.path}`,
        kind: 'file',
        title: file.path,
        body: `${file.language ?? ''} ${file.functions.map((fn) => fn.name).join(' ')}`,
        href: `/repositories/${project.id}?file=${encodeURIComponent(file.path)}`,
        workspaceId,
        projectId: project.id,
        updatedAt: latest.createdAt,
        meta: { loc: file.code, complexity: file.complexity },
      });
    }

    for (const route of latest.analysis.api.routes) {
      documentsToIndex.push({
        id: `${project.id}:route:${route.method}:${route.path}`,
        kind: 'api',
        title: `${route.method} ${route.path}`,
        body: `${route.framework} ${route.file}`,
        href: `/architecture?project=${project.id}&tab=api`,
        workspaceId,
        projectId: project.id,
        updatedAt: latest.createdAt,
      });
    }

    for (const finding of latest.analysis.debt.findings.slice(0, 200)) {
      documentsToIndex.push({
        id: `${project.id}:${finding.id}`,
        kind: 'finding',
        title: finding.title,
        body: `${finding.detail} ${finding.file} ${finding.recommendation}`,
        href: `/repositories/${project.id}?finding=${finding.id}`,
        workspaceId,
        projectId: project.id,
        updatedAt: latest.createdAt,
      });
    }
  }

  for (const document of documents) {
    documentsToIndex.push({
      id: document.id,
      kind: 'document',
      title: document.title,
      body: document.markdown.slice(0, 20_000),
      href: `/docs/${document.id}`,
      workspaceId,
      ...(document.projectId ? { projectId: document.projectId } : {}),
      updatedAt: document.updatedAt,
      boost: 1.2,
    });
  }

  for (const memory of memories) {
    documentsToIndex.push({
      id: memory.id,
      kind: 'memory',
      title: memory.content.slice(0, 80),
      body: `${memory.content} ${memory.tags.join(' ')}`,
      href: `/memory?highlight=${memory.id}`,
      workspaceId,
      updatedAt: memory.updatedAt,
    });
  }

  for (const workflow of workflows) {
    documentsToIndex.push({
      id: workflow.id,
      kind: 'workflow',
      title: workflow.definition.name,
      body: `${workflow.definition.description ?? ''} ${workflow.definition.nodes.map((node) => node.label).join(' ')}`,
      href: `/workflows/${workflow.id}`,
      workspaceId,
      updatedAt: workflow.updatedAt,
    });
  }

  for (const spec of specs) {
    documentsToIndex.push({
      id: spec.id,
      kind: 'api',
      title: spec.name,
      body: spec.spec.operations.map((operation) => `${operation.method} ${operation.path} ${operation.summary ?? ''}`).join(' '),
      href: `/apis/${spec.id}`,
      workspaceId,
      updatedAt: spec.updatedAt,
    });
  }

  for (const benchmark of benchmarks) {
    documentsToIndex.push({
      id: benchmark.id,
      kind: 'benchmark',
      title: benchmark.name,
      body: benchmark.run.variants.map((variant) => `${variant.label} ${variant.model}`).join(' '),
      href: `/evaluation/${benchmark.id}`,
      workspaceId,
      updatedAt: benchmark.createdAt,
    });
  }

  for (const report of reports) {
    for (const finding of report.report.code.slice(0, 100)) {
      documentsToIndex.push({
        id: `${report.id}:${finding.id}`,
        kind: 'finding',
        title: finding.title,
        body: `${finding.detail} ${finding.file} ${finding.remediation}`,
        href: `/security?report=${report.id}`,
        workspaceId,
        projectId: report.projectId,
        updatedAt: report.createdAt,
      });
    }
  }

  for (const conversation of conversations) {
    documentsToIndex.push({
      id: conversation.id,
      kind: 'conversation',
      title: conversation.title,
      body: conversation.title,
      href: `/assistant/${conversation.id}`,
      workspaceId,
      updatedAt: conversation.updatedAt,
    });
  }

  index.addAll(documentsToIndex);
  cache.set(workspaceId, { index, builtAt: Date.now() });
  return index;
}
