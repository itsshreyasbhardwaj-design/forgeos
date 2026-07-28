import type { RepoSnapshot } from '../fs/types.js';
import { analyseFile, type FileComplexity } from './complexity.js';
import { detectLanguage, summariseLanguages, type LanguageBreakdown } from './languages.js';
import { collectManifests, mergeDependencies, type Dependency, type PackageManifest } from './manifests.js';
import { detectStack, describeStack, type DetectedTechnology } from './stack.js';
import { analyseDebt, type DebtReport } from './debt.js';
import { collectEnvironmentVariables, type EnvironmentVariable } from './environment.js';
import {
  buildModuleGraph,
  findCircularDependencies,
  findEntryPoints,
  summariseLayers,
  type CircularDependency,
  type LayerSummary,
  type ModuleGraph,
} from '../graph/module-graph.js';
import { discoverApiSurface, type ApiSurface } from '../graph/api-surface.js';
import { extractSchema, type ExtractedSchema } from '../graph/schema-extract.js';
import { deterministicId } from '../kernel/id.js';
import { round } from '../kernel/text.js';

/**
 * The repository analysis pipeline.
 *
 * One pass over the snapshot produces everything the Repository Intelligence,
 * Architecture and Documentation modules need. It is deliberately a single
 * function returning a single immutable object: the alternative — each module
 * re-reading files on demand — re-parses the same source a dozen times and
 * makes results inconsistent between panels.
 */
export interface DirectoryNode {
  readonly name: string;
  readonly path: string;
  readonly type: 'directory' | 'file';
  readonly bytes: number;
  readonly loc: number;
  readonly language: string | null;
  readonly children?: readonly DirectoryNode[];
}

export interface RepositoryOverview {
  readonly name: string;
  readonly description: string;
  readonly primaryLanguage: string | null;
  readonly stackSummary: string;
  readonly files: number;
  readonly code: number;
  readonly comment: number;
  readonly blank: number;
  readonly bytes: number;
  /** Comment lines as a share of all non-blank lines, 0–1. */
  readonly commentRatio: number;
  readonly testFiles: number;
  /** Test files as a share of source files, 0–1. A coverage proxy, not coverage. */
  readonly testRatio: number;
  readonly hasReadme: boolean;
  readonly hasLicense: boolean;
  readonly hasContributing: boolean;
  readonly hasCi: boolean;
  readonly hasTests: boolean;
  readonly hasDockerfile: boolean;
}

export interface Hotspot {
  readonly path: string;
  readonly complexity: number;
  readonly loc: number;
  readonly fanIn: number;
  readonly maintainability: number;
  /** Composite risk 0–100 combining complexity, size and blast radius. */
  readonly risk: number;
  readonly reason: string;
}

export interface RepositoryAnalysis {
  readonly id: string;
  readonly snapshot: {
    readonly name: string;
    readonly source: string;
    readonly collectedAt: number;
    readonly partial: boolean;
    readonly revision?: string;
  };
  readonly overview: RepositoryOverview;
  readonly languages: readonly LanguageBreakdown[];
  readonly stack: readonly DetectedTechnology[];
  readonly manifests: readonly PackageManifest[];
  readonly dependencies: readonly Dependency[];
  readonly files: readonly FileComplexity[];
  readonly tree: DirectoryNode;
  readonly graph: ModuleGraph;
  readonly layers: readonly LayerSummary[];
  readonly cycles: readonly CircularDependency[];
  readonly entryPoints: readonly string[];
  readonly hotspots: readonly Hotspot[];
  readonly api: ApiSurface;
  readonly schema: ExtractedSchema;
  readonly environment: readonly EnvironmentVariable[];
  readonly debt: DebtReport;
  readonly durationMs: number;
}

const TEST_PATTERN = /(\.|\/)(test|spec)\.[\w]+$|(^|\/)(tests?|__tests__|e2e|cypress)\//i;

export function isTestFile(path: string): boolean {
  return TEST_PATTERN.test(path);
}

/** Build a nested directory tree, aggregating size and LOC upward. */
export function buildTree(
  snapshot: RepoSnapshot,
  locByPath: ReadonlyMap<string, number>
): DirectoryNode {
  interface Mutable {
    name: string;
    path: string;
    type: 'directory' | 'file';
    bytes: number;
    loc: number;
    language: string | null;
    children: Map<string, Mutable>;
  }

  const root: Mutable = {
    name: snapshot.name,
    path: '',
    type: 'directory',
    bytes: 0,
    loc: 0,
    language: null,
    children: new Map(),
  };

  for (const file of snapshot.files) {
    const segments = file.path.split('/');
    let cursor = root;
    cursor.bytes += file.bytes;
    cursor.loc += locByPath.get(file.path) ?? 0;

    for (let i = 0; i < segments.length; i++) {
      const name = segments[i] as string;
      const isLeaf = i === segments.length - 1;
      const path = segments.slice(0, i + 1).join('/');
      let child = cursor.children.get(name);
      if (!child) {
        child = {
          name,
          path,
          type: isLeaf ? 'file' : 'directory',
          bytes: 0,
          loc: 0,
          language: isLeaf ? (detectLanguage(file.path)?.id ?? null) : null,
          children: new Map(),
        };
        cursor.children.set(name, child);
      }
      child.bytes += file.bytes;
      child.loc += locByPath.get(file.path) ?? 0;
      cursor = child;
    }
  }

  const freeze = (node: Mutable): DirectoryNode => {
    const children = [...node.children.values()]
      .sort(
        (a, b) =>
          Number(b.type === 'directory') - Number(a.type === 'directory') ||
          a.name.localeCompare(b.name)
      )
      .map(freeze);
    return {
      name: node.name,
      path: node.path,
      type: node.type,
      bytes: node.bytes,
      loc: node.loc,
      language: node.language,
      ...(node.type === 'directory' ? { children } : {}),
    };
  };

  return freeze(root);
}

function computeHotspots(
  files: readonly FileComplexity[],
  graph: ModuleGraph,
  limit = 25
): Hotspot[] {
  const fanIn = new Map(graph.nodes.map((node) => [node.path, node.fanIn]));
  const maxComplexity = Math.max(1, ...files.map((file) => file.complexity));
  const maxFanIn = Math.max(1, ...graph.nodes.map((node) => node.fanIn));
  const maxLoc = Math.max(1, ...files.map((file) => file.code));

  return files
    .filter((file) => !isTestFile(file.path))
    .map((file) => {
      const inbound = fanIn.get(file.path) ?? 0;
      // Risk is dominated by complexity, amplified by how many modules depend
      // on the file: complex code nobody imports is a much smaller problem.
      const complexityScore = file.complexity / maxComplexity;
      const couplingScore = inbound / maxFanIn;
      const sizeScore = file.code / maxLoc;
      const risk = round(
        Math.min(100, (complexityScore * 0.5 + couplingScore * 0.3 + sizeScore * 0.2) * 100),
        1
      );

      const reasons: string[] = [];
      if (complexityScore > 0.5) reasons.push(`complexity ${file.complexity}`);
      if (inbound > 5) reasons.push(`${inbound} dependents`);
      if (file.code > 400) reasons.push(`${file.code} LOC`);
      if (file.maintainability < 50) reasons.push(`maintainability ${file.maintainability}`);

      return {
        path: file.path,
        complexity: file.complexity,
        loc: file.code,
        fanIn: inbound,
        maintainability: file.maintainability,
        risk,
        reason: reasons.length > 0 ? reasons.join(', ') : 'above-average size and complexity',
      };
    })
    .sort((a, b) => b.risk - a.risk)
    .slice(0, limit);
}

function readDescription(
  snapshot: RepoSnapshot,
  manifests: readonly PackageManifest[]
): string {
  const declared = manifests.find((manifest) => manifest.description)?.description;
  if (declared) return declared;

  const readme = snapshot.files.find(
    (file) => /^readme(\.md|\.rst|\.txt)?$/i.test(file.path) && file.text !== null
  );
  if (!readme?.text) return '';

  for (const rawLine of readme.text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!') || line.startsWith('[![')) {
      continue;
    }
    return line.replace(/^[>*-]\s*/, '').slice(0, 300);
  }
  return '';
}

export interface AnalyseOptions {
  /** Cap module-graph size for very large repositories. */
  readonly maxGraphNodes?: number;
  readonly now?: () => number;
}

export function analyseRepository(
  snapshot: RepoSnapshot,
  options: AnalyseOptions = {}
): RepositoryAnalysis {
  const now = options.now ?? Date.now;
  const startedAt = now();

  const analysable = snapshot.files.filter(
    (file): file is typeof file & { text: string } =>
      file.text !== null && detectLanguage(file.path) !== undefined
  );

  const files = analysable.map((file) => analyseFile(file.path, file.text));
  const locByPath = new Map(files.map((file) => [file.path, file.code + file.comment]));

  const languages = summariseLanguages(
    snapshot.files.map((file) => ({ path: file.path, text: file.text, bytes: file.bytes }))
  );
  const manifests = collectManifests(snapshot);
  const dependencies = mergeDependencies(manifests);
  const stack = detectStack(snapshot, manifests);

  const graph = buildModuleGraph(snapshot, {
    ...(options.maxGraphNodes ? { maxNodes: options.maxGraphNodes } : {}),
  });
  const layers = summariseLayers(graph);
  const cycles = findCircularDependencies(graph);
  const entryPoints = findEntryPoints(graph).slice(0, 40);

  const testFiles = snapshot.files.filter((file) => isTestFile(file.path)).map((file) => file.path);
  const sourceFiles = files.filter((file) => !isTestFile(file.path));

  const totals = files.reduce(
    (accumulator, file) => ({
      code: accumulator.code + file.code,
      comment: accumulator.comment + file.comment,
      blank: accumulator.blank + file.blank,
    }),
    { code: 0, comment: 0, blank: 0 }
  );

  const has = (pattern: RegExp): boolean => snapshot.files.some((file) => pattern.test(file.path));

  const overview: RepositoryOverview = {
    name: snapshot.name,
    description: readDescription(snapshot, manifests),
    primaryLanguage: languages[0]?.name ?? null,
    stackSummary: describeStack(stack),
    files: snapshot.files.length,
    code: totals.code,
    comment: totals.comment,
    blank: totals.blank,
    bytes: snapshot.stats.totalBytes,
    commentRatio:
      totals.code + totals.comment === 0
        ? 0
        : round(totals.comment / (totals.code + totals.comment), 3),
    testFiles: testFiles.length,
    testRatio:
      sourceFiles.length === 0 ? 0 : round(testFiles.length / Math.max(1, sourceFiles.length), 3),
    hasReadme: has(/^readme(\.[\w]+)?$/i),
    hasLicense: has(/^licen[sc]e(\.[\w]+)?$/i),
    hasContributing: has(/^contributing(\.[\w]+)?$/i),
    hasCi: has(/^\.github\/workflows\/|^\.gitlab-ci\.yml$|^\.circleci\//),
    hasTests: testFiles.length > 0,
    hasDockerfile: has(/(^|\/)dockerfile$/i),
  };

  const debt = analyseDebt({ snapshot, files, graph, testFiles });

  return {
    id: deterministicId('anl', snapshot.source, snapshot.revision ?? String(snapshot.collectedAt)),
    snapshot: {
      name: snapshot.name,
      source: snapshot.source,
      collectedAt: snapshot.collectedAt,
      partial: snapshot.partial,
      ...(snapshot.revision ? { revision: snapshot.revision } : {}),
    },
    overview,
    languages,
    stack,
    manifests,
    dependencies,
    files,
    tree: buildTree(snapshot, locByPath),
    graph,
    layers,
    cycles,
    entryPoints,
    hotspots: computeHotspots(files, graph),
    api: discoverApiSurface(
      snapshot,
      dependencies.map((dependency) => dependency.name)
    ),
    schema: extractSchema(snapshot),
    environment: collectEnvironmentVariables(snapshot),
    debt,
    durationMs: Math.max(0, now() - startedAt),
  };
}

/**
 * A compact projection of an analysis, small enough to embed in an AI prompt,
 * a search index document or an API list response.
 */
export interface AnalysisSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly primaryLanguage: string | null;
  readonly stackSummary: string;
  readonly files: number;
  readonly code: number;
  readonly healthScore: number;
  readonly grade: DebtReport['grade'];
  readonly criticalFindings: number;
  readonly cycles: number;
  readonly routes: number;
  readonly entities: number;
  readonly collectedAt: number;
}

export function summariseAnalysis(analysis: RepositoryAnalysis): AnalysisSummary {
  return {
    id: analysis.id,
    name: analysis.overview.name,
    description: analysis.overview.description,
    primaryLanguage: analysis.overview.primaryLanguage,
    stackSummary: analysis.overview.stackSummary,
    files: analysis.overview.files,
    code: analysis.overview.code,
    healthScore: analysis.debt.score,
    grade: analysis.debt.grade,
    criticalFindings: analysis.debt.bySeverity.critical,
    cycles: analysis.cycles.length,
    routes: analysis.api.routes.length,
    entities: analysis.schema.entities.length,
    collectedAt: analysis.snapshot.collectedAt,
  };
}
