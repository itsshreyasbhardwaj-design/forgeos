import 'server-only';
import {
  analyseRepository,
  createId,
  invalidInput,
  notFound,
  scanRepository,
  slugify,
  snapshotFromEntries,
  summariseAnalysis,
  type RepoSnapshot,
  type RepositoryAnalysis,
} from '@forgeos/core';
import { scanDirectory } from '@forgeos/core/node';
import type { Project, StoredAnalysis, StoredSecurityReport } from '@forgeos/db';
import { getContext } from './context';
import { SAMPLE_REPOSITORY } from './sample';

/**
 * Project and analysis services.
 *
 * The one security decision that matters here: a project's `source` is a path
 * on the server's filesystem, and users must not be able to point it anywhere
 * they like. {@link resolveSnapshot} enforces an allowlist rooted at
 * `FORGEOS_SCAN_ROOT`, defaulting to the process working directory, so a
 * malicious project definition cannot read `/etc` or another tenant's checkout.
 */
const SCAN_ROOT = process.env.FORGEOS_SCAN_ROOT ?? process.cwd();

export async function resolveSnapshot(project: Project): Promise<RepoSnapshot> {
  if (project.sourceKind === 'sample') {
    return snapshotFromEntries(SAMPLE_REPOSITORY, {
      name: project.name,
      source: 'sample',
      now: () => Date.now(),
    });
  }

  if (project.sourceKind !== 'local') {
    throw invalidInput(
      `Source kind '${project.sourceKind}' cannot be scanned by this instance yet. Use a local path or the bundled sample.`,
      { sourceKind: project.sourceKind }
    );
  }

  const { resolve, relative, isAbsolute } = await import('node:path');
  const target = resolve(project.source);
  const root = resolve(SCAN_ROOT);
  const rel = relative(root, target);

  // An empty relative path means target === root, which is allowed.
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw invalidInput(
      'That path is outside the directory this instance is allowed to scan. Set FORGEOS_SCAN_ROOT to widen it.',
      { root, requested: target }
    );
  }

  return scanDirectory(target, { name: project.name });
}

export interface CreateProjectInput {
  readonly workspaceId: string;
  readonly name: string;
  readonly source: string;
  readonly description?: string;
  readonly sourceKind?: Project['sourceKind'];
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const { store } = await getContext();
  const now = Date.now();

  const project: Project = {
    id: createId('repo', now),
    workspaceId: input.workspaceId,
    name: input.name,
    slug: slugify(input.name, 'project'),
    ...(input.description ? { description: input.description } : {}),
    source: input.source,
    sourceKind: input.sourceKind ?? (input.source === 'sample' ? 'sample' : 'local'),
    createdAt: now,
    updatedAt: now,
  };

  await store.createProject(project);
  await store.recordActivity({
    id: createId('act', now),
    workspaceId: input.workspaceId,
    kind: 'project.created',
    actorId: 'system',
    summary: `Added repository “${project.name}”`,
    createdAt: now,
    targetId: project.id,
    targetHref: `/repositories/${project.id}`,
  });

  return project;
}

export interface AnalyseResult {
  readonly project: Project;
  readonly stored: StoredAnalysis;
  readonly analysis: RepositoryAnalysis;
}

export async function analyseProject(
  workspaceId: string,
  projectId: string
): Promise<AnalyseResult> {
  const { store } = await getContext();
  const project = await store.getProject(workspaceId, projectId);
  if (!project) throw notFound('project', projectId);

  const snapshot = await resolveSnapshot(project);
  const analysis = analyseRepository(snapshot);
  const now = Date.now();

  const stored: StoredAnalysis = {
    id: createId('anl', now),
    workspaceId,
    projectId,
    createdAt: now,
    ...(analysis.snapshot.revision ? { revision: analysis.snapshot.revision } : {}),
    analysis,
  };

  await store.saveAnalysis(stored);
  const updated =
    (await store.updateProject(workspaceId, projectId, { lastAnalysedAt: now })) ?? project;

  await store.recordActivity({
    id: createId('act', now),
    workspaceId,
    kind: 'project.analysed',
    actorId: 'system',
    summary: `Analysed “${project.name}” — ${analysis.overview.code.toLocaleString()} LOC, health ${analysis.debt.score}`,
    createdAt: now,
    targetId: projectId,
    targetHref: `/repositories/${projectId}`,
    meta: { healthScore: analysis.debt.score, grade: analysis.debt.grade },
  });

  return { project: updated, stored, analysis };
}

/** The most recent analysis, running one on demand if none exists yet. */
export async function requireAnalysis(
  workspaceId: string,
  projectId: string
): Promise<RepositoryAnalysis> {
  const { store } = await getContext();
  const latest = await store.getLatestAnalysis(workspaceId, projectId);
  if (latest) return latest.analysis;
  const { analysis } = await analyseProject(workspaceId, projectId);
  return analysis;
}

export async function scanProjectSecurity(
  workspaceId: string,
  projectId: string
): Promise<StoredSecurityReport> {
  const { store } = await getContext();
  const project = await store.getProject(workspaceId, projectId);
  if (!project) throw notFound('project', projectId);

  const snapshot = await resolveSnapshot(project);
  const analysis = analyseRepository(snapshot);
  const report = await scanRepository(snapshot, analysis.dependencies);
  const now = Date.now();

  const stored: StoredSecurityReport = {
    id: createId('sec', now),
    workspaceId,
    projectId,
    createdAt: now,
    report,
  };

  await store.saveSecurityReport(stored);
  await store.recordActivity({
    id: createId('act', now),
    workspaceId,
    kind: 'security.scanned',
    actorId: 'system',
    summary: `Security scan of “${project.name}” — posture ${report.posture.score} (${report.posture.grade})`,
    createdAt: now,
    targetId: projectId,
    targetHref: `/security`,
  });

  return stored;
}

/** Create the bundled sample project so a new workspace is never empty. */
export async function ensureSampleProject(workspaceId: string): Promise<Project> {
  const { store } = await getContext();
  const existing = await store.listProjects(workspaceId, { limit: 100 });
  const sample = existing.find((project) => project.sourceKind === 'sample');
  if (sample) return sample;

  return createProject({
    workspaceId,
    name: 'Sample: orders-service',
    source: 'sample',
    sourceKind: 'sample',
    description:
      'A small but complete service bundled with ForgeOS so every module has real data to work with on first run.',
  });
}

export { summariseAnalysis };
