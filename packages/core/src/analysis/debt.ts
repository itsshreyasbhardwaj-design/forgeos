import type { RepoSnapshot } from '../fs/types.js';
import { detectLanguage, getLanguageById } from './languages.js';
import { stripNonCode, type FileComplexity } from './complexity.js';
import type { ModuleGraph } from '../graph/module-graph.js';
import { findCircularDependencies, findLayerViolations, findOrphans } from '../graph/module-graph.js';
import { fnv1a32 } from '../kernel/hash.js';
import { clamp, round } from '../kernel/text.js';

/**
 * Technical debt detection.
 *
 * Every finding must be *actionable* and *located*: a file, a line, and a
 * concrete thing to do. Findings that amount to "this file is long" without a
 * reason are noise, so each rule carries a threshold chosen to fire on genuine
 * outliers rather than on the whole codebase.
 */
export type DebtSeverity = 'critical' | 'high' | 'medium' | 'low';

export type DebtCategory =
  | 'complexity'
  | 'duplication'
  | 'size'
  | 'coupling'
  | 'documentation'
  | 'testing'
  | 'markers'
  | 'architecture'
  | 'dead-code';

export interface DebtFinding {
  readonly id: string;
  readonly category: DebtCategory;
  readonly severity: DebtSeverity;
  readonly title: string;
  readonly detail: string;
  readonly file: string;
  readonly line?: number;
  /** Rough remediation cost, in hours. Used to total up "debt in days". */
  readonly effortHours: number;
  readonly recommendation: string;
}

export interface DebtReport {
  readonly findings: readonly DebtFinding[];
  /** 0–100, higher is healthier. */
  readonly score: number;
  readonly grade: 'A' | 'B' | 'C' | 'D' | 'F';
  readonly estimatedDays: number;
  readonly byCategory: Readonly<Record<DebtCategory, number>>;
  readonly bySeverity: Readonly<Record<DebtSeverity, number>>;
}

const SEVERITY_WEIGHT: Record<DebtSeverity, number> = {
  critical: 20,
  high: 8,
  medium: 3,
  low: 1,
};

/**
 * Weighted-penalty density at which the health score reaches 50. Chosen so that
 * a well-maintained codebase scores 80+ and a neglected one scores under 30.
 */
export const DEBT_SCORE_HALF_LIFE = 22;

const MARKER_PATTERN = /\b(TODO|FIXME|HACK|XXX|BUG|DEPRECATED|REFACTOR)\b[:\s-]*(.{0,120})/gi;

const MARKER_SEVERITY: Record<string, DebtSeverity> = {
  FIXME: 'high',
  BUG: 'high',
  HACK: 'medium',
  XXX: 'medium',
  DEPRECATED: 'medium',
  TODO: 'low',
  REFACTOR: 'low',
};

function findingId(category: string, file: string, extra: string): string {
  return `${category}_${fnv1a32(`${file}:${extra}`).toString(36)}`;
}

/** Comment markers left in source: the most honest debt signal there is. */
export function findMarkers(snapshot: RepoSnapshot): DebtFinding[] {
  const findings: DebtFinding[] = [];

  for (const file of snapshot.files) {
    if (file.text === null || !detectLanguage(file.path)) continue;
    const lines = file.text.split('\n');

    lines.forEach((line, index) => {
      // Only look at comment lines, so a string containing "TODO" is ignored.
      if (!/^\s*(\/\/|#|\*|<!--|--)/.test(line)) return;
      const pattern = new RegExp(MARKER_PATTERN.source, MARKER_PATTERN.flags);
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const marker = (match[1] ?? 'TODO').toUpperCase();
        const note = (match[2] ?? '').trim().replace(/\*\/\s*$/, '').replace(/-->\s*$/, '');
        findings.push({
          id: findingId('marker', file.path, `${index}:${marker}`),
          category: 'markers',
          severity: MARKER_SEVERITY[marker] ?? 'low',
          title: `${marker} left in source`,
          detail: note === '' ? `A ${marker} marker with no explanation.` : note,
          file: file.path,
          line: index + 1,
          effortHours: marker === 'FIXME' || marker === 'BUG' ? 2 : 0.5,
          recommendation:
            marker === 'TODO'
              ? 'Convert to a tracked issue or delete it — an untracked TODO is invisible work.'
              : `Resolve the ${marker} or document why it is acceptable.`,
        });
      }
    });
  }

  return findings;
}

/**
 * Duplicate block detection using a rolling window of normalised tokens.
 *
 * Lines are normalised (identifiers and literals collapsed) so that
 * copy-pasted code that was subsequently renamed is still detected — which is
 * the case that matters, because verbatim copies are easy to spot by eye.
 */
export interface DuplicateBlock {
  readonly hash: string;
  readonly lines: number;
  readonly occurrences: readonly { file: string; line: number }[];
}

function normaliseLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length < 12) return null;
  return trimmed
    .replace(/["'`][^"'`]*["'`]/g, 'S')
    .replace(/\b\d+(\.\d+)?\b/g, 'N')
    .replace(/\b[A-Za-z_$][\w$]*\b/g, 'I')
    .replace(/\s+/g, ' ');
}

export function findDuplicateBlocks(
  snapshot: RepoSnapshot,
  windowSize = 8,
  minOccurrences = 2
): DuplicateBlock[] {
  const buckets = new Map<string, { file: string; line: number }[]>();

  for (const file of snapshot.files) {
    if (file.text === null) continue;
    const language = detectLanguage(file.path);
    if (!language || language.category !== 'programming') continue;
    // Generated and test fixtures duplicate legitimately.
    if (/(\.|\/)(test|spec)\.|__(snapshots|fixtures)__|\.generated\./i.test(file.path)) continue;

    const source = stripNonCode(file.text, language).split('\n');
    const normalised: { text: string; line: number }[] = [];
    source.forEach((line, index) => {
      const value = normaliseLine(line);
      if (value !== null) normalised.push({ text: value, line: index + 1 });
    });

    for (let i = 0; i + windowSize <= normalised.length; i++) {
      const window = normalised.slice(i, i + windowSize);
      const key = fnv1a32(window.map((entry) => entry.text).join('\n')).toString(36);
      const bucket = buckets.get(key) ?? [];
      bucket.push({ file: file.path, line: window[0]?.line ?? 1 });
      buckets.set(key, bucket);
    }
  }

  const blocks: DuplicateBlock[] = [];
  for (const [hash, occurrences] of buckets) {
    if (occurrences.length < minOccurrences) continue;
    // Overlapping windows within one file inflate counts; keep distinct sites.
    const distinct = occurrences.filter(
      (occurrence, index) =>
        !occurrences.some(
          (other, otherIndex) =>
            otherIndex < index &&
            other.file === occurrence.file &&
            Math.abs(other.line - occurrence.line) < windowSize
        )
    );
    if (distinct.length < minOccurrences) continue;
    blocks.push({ hash, lines: windowSize, occurrences: distinct });
  }

  return blocks
    .sort((a, b) => b.occurrences.length - a.occurrences.length)
    .slice(0, 200);
}

export interface DebtInput {
  readonly snapshot: RepoSnapshot;
  readonly files: readonly FileComplexity[];
  readonly graph: ModuleGraph;
  /** Paths recognised as tests, used for the coverage-proxy rule. */
  readonly testFiles: readonly string[];
}

/**
 * Structural rules — complexity, size, testing, dead code — only make sense for
 * executable code. Applying them to documentation or configuration produces
 * findings that are not merely useless but actively misleading.
 */
function isCode(languageId: string | null): boolean {
  return languageId !== null && getLanguageById(languageId)?.category === 'programming';
}

/** Thresholds, gathered here so they can be reviewed in one place. */
export const DEBT_THRESHOLDS = {
  /** Decision points per line above which a file stops being scannable. */
  fileComplexityDensity: 0.2,
  /** Absolute floor so tiny dense files do not dominate the report. */
  fileComplexityFloor: 40,
  functionComplexity: 20,
  functionLines: 120,
  fileLines: 600,
  nesting: 5,
  parameters: 6,
  couplingFanOut: 20,
  couplingFanIn: 25,
} as const;

export function analyseDebt(input: DebtInput): DebtReport {
  const findings: DebtFinding[] = [...findMarkers(input.snapshot)];

  for (const file of input.files) {
    // Structural rules are about production code. A long, branchy test file is
    // usually thorough rather than unhealthy, and flagging them buries the
    // findings that matter.
    const isTest = /(\.|\/)(test|spec)\.|(^|\/)(tests?|__tests__|e2e|cypress)\//i.test(file.path);
    if (isTest || !isCode(file.language)) continue;

    // Density, not raw count: a 1,200-line module with 200 branches is ordinary,
    // a 60-line module with 40 branches is not.
    const density = file.code === 0 ? 0 : file.complexity / file.code;
    // Only report at file level when no individual function is already flagged.
    // Reporting both means one problem is counted twice, which distorts the
    // score and makes the report read as though there are two separate issues.
    const hasFunctionFinding = file.functions.some(
      (fn) => fn.complexity > DEBT_THRESHOLDS.functionComplexity
    );
    if (
      !hasFunctionFinding &&
      density > DEBT_THRESHOLDS.fileComplexityDensity &&
      file.complexity > DEBT_THRESHOLDS.fileComplexityFloor
    ) {
      findings.push({
        id: findingId('complexity', file.path, 'file'),
        category: 'complexity',
        severity: density > DEBT_THRESHOLDS.fileComplexityDensity * 1.75 ? 'critical' : 'high',
        title: 'Branch-dense module',
        detail: `Cyclomatic complexity ${file.complexity} over ${file.code} lines — ${density.toFixed(2)} decision points per line.`,
        file: file.path,
        effortHours: clamp(file.complexity / 10, 2, 16),
        recommendation:
          'Extract the branch-heavy sections into named functions with single responsibilities.',
      });
    }

    if (file.code > DEBT_THRESHOLDS.fileLines) {
      findings.push({
        id: findingId('size', file.path, 'file'),
        category: 'size',
        severity: file.code > DEBT_THRESHOLDS.fileLines * 2 ? 'high' : 'medium',
        title: 'Oversized module',
        detail: `${file.code} lines of code in a single file.`,
        file: file.path,
        effortHours: clamp(file.code / 200, 1, 12),
        recommendation: 'Split along its natural seams — each export group is a candidate module.',
      });
    }

    if (file.nesting > DEBT_THRESHOLDS.nesting) {
      findings.push({
        id: findingId('complexity', file.path, 'nesting'),
        category: 'complexity',
        severity: 'medium',
        title: 'Deeply nested control flow',
        detail: `Maximum nesting depth is ${file.nesting}.`,
        file: file.path,
        effortHours: 2,
        recommendation: 'Apply early returns and guard clauses to flatten the deepest branches.',
      });
    }

    for (const fn of file.functions) {
      if (fn.complexity > DEBT_THRESHOLDS.functionComplexity) {
        findings.push({
          id: findingId('complexity', file.path, `fn:${fn.name}:${fn.line}`),
          category: 'complexity',
          severity:
            fn.complexity > DEBT_THRESHOLDS.functionComplexity * 2
              ? 'critical'
              : fn.complexity > DEBT_THRESHOLDS.functionComplexity * 1.4
                ? 'high'
                : 'medium',
          title: `\`${fn.name}\` is hard to reason about`,
          detail: `Cyclomatic complexity ${fn.complexity} over ${fn.lines} lines — roughly ${fn.complexity} independent paths to test.`,
          file: file.path,
          line: fn.line,
          effortHours: clamp(fn.complexity / 5, 1, 8),
          recommendation: 'Decompose into smaller functions; aim for a complexity of 10 or below.',
        });
      }

      if (fn.lines > DEBT_THRESHOLDS.functionLines) {
        findings.push({
          id: findingId('size', file.path, `fn:${fn.name}:${fn.line}`),
          category: 'size',
          severity: 'medium',
          title: `\`${fn.name}\` is very long`,
          detail: `${fn.lines} lines in a single function.`,
          file: file.path,
          line: fn.line,
          effortHours: 3,
          recommendation: 'Extract cohesive steps into helpers named after what they accomplish.',
        });
      }

      if (fn.parameters > DEBT_THRESHOLDS.parameters) {
        findings.push({
          id: findingId('complexity', file.path, `params:${fn.name}:${fn.line}`),
          category: 'complexity',
          severity: 'low',
          title: `\`${fn.name}\` takes ${fn.parameters} parameters`,
          detail: 'Long parameter lists are easy to call incorrectly and hard to extend.',
          file: file.path,
          line: fn.line,
          effortHours: 1,
          recommendation: 'Group related parameters into a single options object.',
        });
      }
    }
  }

  for (const node of input.graph.nodes) {
    if (node.fanOut > DEBT_THRESHOLDS.couplingFanOut) {
      findings.push({
        id: findingId('coupling', node.path, 'fanout'),
        category: 'coupling',
        severity: node.fanOut > DEBT_THRESHOLDS.couplingFanOut * 2 ? 'high' : 'medium',
        title: 'Module depends on too much',
        detail: `Imports ${node.fanOut} other modules, which makes it fragile to unrelated change.`,
        file: node.path,
        effortHours: 4,
        recommendation: 'Introduce a facade, or move the orchestration closer to what it coordinates.',
      });
    }

    if (node.fanIn > DEBT_THRESHOLDS.couplingFanIn) {
      findings.push({
        id: findingId('coupling', node.path, 'fanin'),
        category: 'coupling',
        severity: 'medium',
        title: 'Change-risk hotspot',
        detail: `${node.fanIn} modules import this file — any change here has a wide blast radius.`,
        file: node.path,
        effortHours: 3,
        recommendation:
          'Freeze the public surface behind a narrow, well-tested interface before changing it.',
      });
    }
  }

  for (const cycle of findCircularDependencies(input.graph)) {
    const head = cycle.cycle[0] ?? 'unknown';
    findings.push({
      id: findingId('architecture', head, `cycle:${cycle.cycle.join('>')}`),
      category: 'architecture',
      severity: cycle.crossesLayers ? 'high' : 'medium',
      title: `Circular dependency across ${cycle.length} modules`,
      detail: cycle.cycle.join(' → ') + ` → ${head}`,
      file: head,
      effortHours: clamp(cycle.length, 2, 10),
      recommendation:
        'Break the cycle by extracting the shared contract into a module both sides can depend on.',
    });
  }

  for (const violation of findLayerViolations(input.graph)) {
    findings.push({
      id: findingId('architecture', violation.from, `layer:${violation.to}`),
      category: 'architecture',
      severity: 'medium',
      title: `${violation.fromLayer} depends on ${violation.toLayer}`,
      detail: `${violation.from} imports ${violation.to}, inverting the intended layer ordering.`,
      file: violation.from,
      effortHours: 3,
      recommendation: 'Invert the dependency: define the interface in the lower layer.',
    });
  }

  for (const orphan of findOrphans(input.graph)) {
    // A module with no edges may be an entry point rather than dead code.
    if (/(^|\/)(index|main|app|server|cli|setup|conftest)\.[\w]+$/.test(orphan)) continue;
    if (/(\.|\/)(test|spec)\./i.test(orphan)) continue;
    findings.push({
      id: findingId('dead-code', orphan, 'orphan'),
      category: 'dead-code',
      severity: 'low',
      title: 'Possibly unreachable module',
      detail: 'Nothing imports this module and it imports nothing.',
      file: orphan,
      effortHours: 0.5,
      recommendation: 'Confirm it is not loaded dynamically, then delete it.',
    });
  }

  for (const block of findDuplicateBlocks(input.snapshot)) {
    const first = block.occurrences[0];
    if (!first) continue;
    findings.push({
      id: findingId('duplication', first.file, block.hash),
      category: 'duplication',
      severity: block.occurrences.length > 3 ? 'medium' : 'low',
      title: `Duplicated block repeated ${block.occurrences.length} times`,
      detail: block.occurrences
        .slice(0, 5)
        .map((occurrence) => `${occurrence.file}:${occurrence.line}`)
        .join(', '),
      file: first.file,
      line: first.line,
      effortHours: 1.5,
      recommendation: 'Extract the repeated logic into a shared helper.',
    });
  }

  // Testing: modules with meaningful complexity and no sibling test file.
  const testTargets = new Set(
    input.testFiles.map((path) =>
      path
        .replace(/(\.|\/)(test|spec)\./i, '.')
        .replace(/(^|\/)(tests?|__tests__|e2e)\//i, '$1')
        .toLowerCase()
    )
  );
  const untested = input.files
    .filter((file) => isCode(file.language))
    .filter((file) => file.complexity >= 12 && file.code >= 60)
    .filter((file) => !/(\.|\/)(test|spec)\./i.test(file.path))
    .filter((file) => !testTargets.has(file.path.toLowerCase()));

  for (const file of untested.slice(0, 40)) {
    findings.push({
      id: findingId('testing', file.path, 'untested'),
      category: 'testing',
      severity: file.complexity >= 40 ? 'high' : file.complexity >= 20 ? 'medium' : 'low',
      title: 'Complex module without a matching test',
      detail: `Complexity ${file.complexity} with no discoverable test file.`,
      file: file.path,
      effortHours: clamp(file.complexity / 6, 1, 8),
      recommendation: 'Add characterisation tests covering the highest-complexity paths first.',
    });
  }

  // Documentation: public-looking modules with almost no comments.
  for (const file of input.files) {
    if (!isCode(file.language) || file.code < 120) continue;
    const ratio = file.comment / Math.max(1, file.code + file.comment);
    if (ratio >= 0.03) continue;
    findings.push({
      id: findingId('documentation', file.path, 'comments'),
      category: 'documentation',
      severity: 'low',
      title: 'Substantial module with no explanation',
      detail: `${file.code} lines of code and ${file.comment} comment lines.`,
      file: file.path,
      effortHours: 1,
      recommendation: 'Document why the module exists and any non-obvious constraints.',
    });
  }

  return summariseDebt(findings, input.files);
}

export function summariseDebt(
  findings: readonly DebtFinding[],
  files: readonly FileComplexity[]
): DebtReport {
  const bySeverity: Record<DebtSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const byCategory: Record<DebtCategory, number> = {
    complexity: 0,
    duplication: 0,
    size: 0,
    coupling: 0,
    documentation: 0,
    testing: 0,
    markers: 0,
    architecture: 0,
    'dead-code': 0,
  };

  let penalty = 0;
  let effortHours = 0;
  for (const finding of findings) {
    bySeverity[finding.severity]++;
    byCategory[finding.category]++;
    penalty += SEVERITY_WEIGHT[finding.severity];
    effortHours += finding.effortHours;
  }

  // Normalise penalty by codebase size: 200 findings in a million-line
  // monorepo is healthy, the same count in 2,000 lines is not.
  //
  // The curve is a saturating hyperbola rather than a straight line. A linear
  // penalty drives every real-world repository to zero — which makes the score
  // useless for comparison — whereas this keeps the whole 0–100 range in play:
  // ~5 weighted points per 1k LOC still scores in the 80s, and a genuinely
  // troubled codebase lands in the 20s without ever bottoming out.
  const totalCode = Math.max(500, files.reduce((sum, file) => sum + file.code, 0));
  const density = penalty / (totalCode / 1000);
  const score = round((100 * DEBT_SCORE_HALF_LIFE) / (density + DEBT_SCORE_HALF_LIFE), 1);

  return {
    findings: [...findings].sort(
      (a, b) =>
        SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
        b.effortHours - a.effortHours ||
        a.file.localeCompare(b.file)
    ),
    score,
    grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F',
    estimatedDays: round(effortHours / 6, 1),
    byCategory,
    bySeverity,
  };
}
