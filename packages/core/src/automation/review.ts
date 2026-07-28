import { parseCommit, type ParsedCommit, type RawCommit } from './commits.js';
import { scanCodePatterns } from '../security/patterns.js';
import { scanSecrets } from '../security/secrets.js';
import { snapshotFromEntries } from '../fs/scan.js';
import { analyseFile, type FileComplexity } from '../analysis/complexity.js';
import { detectLanguage } from '../analysis/languages.js';
import { isTestFile } from '../analysis/repository.js';
import { clamp, round } from '../kernel/text.js';
import { fnv1a32 } from '../kernel/hash.js';

/**
 * Automated pull-request review.
 *
 * Reviews the *diff*, not the repository — a review that reports pre-existing
 * problems in files the author merely touched is noise, and teams learn to
 * ignore it. Every comment is anchored to a line the pull request actually
 * changed.
 */
export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly { kind: 'add' | 'remove' | 'context'; text: string; newLine?: number }[];
}

export interface FileDiff {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly DiffHunk[];
  /** Full content after the change, when available. Enables deeper checks. */
  readonly content?: string;
}

export interface PullRequestInput {
  readonly title: string;
  readonly description?: string;
  readonly files: readonly FileDiff[];
  readonly commits?: readonly RawCommit[];
  readonly baseBranch?: string;
}

export type ReviewSeverity = 'blocking' | 'important' | 'suggestion' | 'nitpick';

export interface ReviewComment {
  readonly id: string;
  readonly severity: ReviewSeverity;
  readonly category: string;
  readonly file: string;
  readonly line?: number;
  readonly title: string;
  readonly body: string;
}

export interface PullRequestReview {
  readonly verdict: 'approve' | 'comment' | 'request-changes';
  readonly summary: string;
  readonly comments: readonly ReviewComment[];
  readonly stats: {
    readonly files: number;
    readonly additions: number;
    readonly deletions: number;
    readonly testFilesChanged: number;
    readonly riskScore: number;
  };
  readonly commitIssues: readonly string[];
  readonly checklist: readonly { label: string; passed: boolean }[];
}

/** Parse a unified diff into structured hunks. */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: {
    path: string;
    previousPath?: string;
    status: FileDiff['status'];
    additions: number;
    deletions: number;
    hunks: DiffHunk[];
  } | null = null;
  let hunk: { header: DiffHunk; lines: DiffHunk['lines'] } | null = null;
  let newLineCursor = 0;

  const flushHunk = (): void => {
    if (current && hunk) current.hunks.push({ ...hunk.header, lines: hunk.lines });
    hunk = null;
  };
  const flushFile = (): void => {
    flushHunk();
    if (current) files.push({ ...current, hunks: current.hunks });
    current = null;
  };

  for (const line of diff.split('\n')) {
    const fileHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (fileHeader) {
      flushFile();
      const previous = fileHeader[1] ?? '';
      const next = fileHeader[2] ?? '';
      current = {
        path: next,
        ...(previous !== next ? { previousPath: previous, status: 'renamed' as const } : { status: 'modified' as const }),
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current = { ...current, status: 'added' };
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current = { ...current, status: 'deleted' };
      continue;
    }

    const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkHeader) {
      flushHunk();
      newLineCursor = Number(hunkHeader[3] ?? 1);
      hunk = {
        header: {
          oldStart: Number(hunkHeader[1] ?? 1),
          oldLines: Number(hunkHeader[2] ?? 1),
          newStart: newLineCursor,
          newLines: Number(hunkHeader[4] ?? 1),
          lines: [],
        },
        lines: [],
      };
      continue;
    }

    if (!hunk) continue;
    const mutableLines = hunk.lines as { kind: 'add' | 'remove' | 'context'; text: string; newLine?: number }[];

    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.additions++;
      mutableLines.push({ kind: 'add', text: line.slice(1), newLine: newLineCursor++ });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      current.deletions++;
      mutableLines.push({ kind: 'remove', text: line.slice(1) });
    } else if (line.startsWith(' ')) {
      mutableLines.push({ kind: 'context', text: line.slice(1), newLine: newLineCursor++ });
    }
  }

  flushFile();
  return files;
}

function commentId(file: string, line: number | undefined, rule: string): string {
  return `rc_${fnv1a32(`${file}:${line ?? 0}:${rule}`).toString(36)}`;
}

/** Added lines only, with their line numbers in the new file. */
function addedLines(file: FileDiff): { text: string; line: number }[] {
  const added: { text: string; line: number }[] = [];
  for (const hunk of file.hunks) {
    for (const entry of hunk.lines) {
      if (entry.kind === 'add' && entry.newLine !== undefined) {
        added.push({ text: entry.text, line: entry.newLine });
      }
    }
  }
  return added;
}

const SEVERITY_WEIGHT: Record<ReviewSeverity, number> = {
  blocking: 25,
  important: 8,
  suggestion: 2,
  nitpick: 0.5,
};

export interface ReviewOptions {
  /** Additions above which a pull request is called out as too large. */
  readonly largeChangeThreshold?: number;
  /** Require a test change when non-trivial source changes. Default true. */
  readonly requireTests?: boolean;
}

export function reviewPullRequest(
  pr: PullRequestInput,
  options: ReviewOptions = {}
): PullRequestReview {
  const comments: ReviewComment[] = [];
  const largeThreshold = options.largeChangeThreshold ?? 400;

  const additions = pr.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = pr.files.reduce((sum, file) => sum + file.deletions, 0);
  const changedTests = pr.files.filter((file) => isTestFile(file.path)).length;
  const sourceFiles = pr.files.filter(
    (file) => file.status !== 'deleted' && detectLanguage(file.path) && !isTestFile(file.path)
  );

  // --- Security: scan only the added lines, assembled into a synthetic file. ---
  const addedByFile = new Map<string, string>();
  for (const file of pr.files) {
    if (file.status === 'deleted') continue;
    const added = addedLines(file);
    if (added.length === 0) continue;
    addedByFile.set(file.path, added.map((entry) => entry.text).join('\n'));
  }

  if (addedByFile.size > 0) {
    const snapshot = snapshotFromEntries(Object.fromEntries(addedByFile), { name: 'pull-request' });

    const mapLine = (path: string, syntheticLine: number): number | undefined =>
      addedLines(pr.files.find((file) => file.path === path) ?? ({ hunks: [] } as unknown as FileDiff))[
        syntheticLine - 1
      ]?.line;

    for (const finding of scanSecrets(snapshot, { includeAllowlistedPaths: true })) {
      comments.push({
        id: commentId(finding.file, finding.line, finding.rule),
        severity: finding.confidence === 'high' ? 'blocking' : 'important',
        category: 'security',
        file: finding.file,
        ...(mapLine(finding.file, finding.line) !== undefined
          ? { line: mapLine(finding.file, finding.line) as number }
          : {}),
        title: `Possible credential: ${finding.description}`,
        body: `${finding.preview} — ${finding.remediation}`,
      });
    }

    for (const finding of scanCodePatterns(snapshot, { includeTests: true })) {
      comments.push({
        id: commentId(finding.file, finding.line, finding.rule),
        severity: finding.severity === 'critical' ? 'blocking' : finding.severity === 'high' ? 'important' : 'suggestion',
        category: finding.category,
        file: finding.file,
        ...(mapLine(finding.file, finding.line) !== undefined
          ? { line: mapLine(finding.file, finding.line) as number }
          : {}),
        title: finding.title,
        body: `${finding.detail}\n\n**Suggested fix:** ${finding.remediation}${finding.owasp ? `\n\n_${finding.owasp}_` : ''}`,
      });
    }
  }

  // --- Complexity of newly written functions, when full content is available. ---
  for (const file of pr.files) {
    if (!file.content || file.status === 'deleted' || isTestFile(file.path)) continue;
    const metrics: FileComplexity = analyseFile(file.path, file.content);
    const touched = new Set(addedLines(file).map((entry) => entry.line));

    for (const fn of metrics.functions) {
      // Only comment on functions this pull request actually wrote into.
      const overlaps = [...touched].some((line) => line >= fn.line && line <= fn.endLine);
      if (!overlaps) continue;

      if (fn.complexity > 15) {
        comments.push({
          id: commentId(file.path, fn.line, 'complexity'),
          severity: fn.complexity > 25 ? 'important' : 'suggestion',
          category: 'complexity',
          file: file.path,
          line: fn.line,
          title: `\`${fn.name}\` has cyclomatic complexity ${fn.complexity}`,
          body: `That is roughly ${fn.complexity} independent paths to test. Consider extracting the branch-heavy sections into named helpers.`,
        });
      }
      if (fn.parameters > 6) {
        comments.push({
          id: commentId(file.path, fn.line, 'parameters'),
          severity: 'nitpick',
          category: 'readability',
          file: file.path,
          line: fn.line,
          title: `\`${fn.name}\` takes ${fn.parameters} parameters`,
          body: 'Long parameter lists are easy to call incorrectly. Consider grouping related parameters into an options object.',
        });
      }
    }
  }

  // --- Debug leftovers in added lines. ---
  for (const file of pr.files) {
    if (file.status === 'deleted') continue;
    for (const { text, line } of addedLines(file)) {
      if (/\b(console\.log|debugger|print\()\s*/.test(text) && !isTestFile(file.path)) {
        comments.push({
          id: commentId(file.path, line, 'debug'),
          severity: 'suggestion',
          category: 'cleanliness',
          file: file.path,
          line,
          title: 'Debug statement left in',
          body: 'Remove it, or replace it with a structured log call at an appropriate level.',
        });
      }
      if (/\b(TODO|FIXME)\b/.test(text) && /^\s*(\/\/|#|\*)/.test(text)) {
        comments.push({
          id: commentId(file.path, line, 'marker'),
          severity: 'nitpick',
          category: 'process',
          file: file.path,
          line,
          title: 'New TODO introduced',
          body: 'Link this to a tracked issue, or resolve it before merging — an untracked TODO is invisible work.',
        });
      }
    }
  }

  // --- Pull-request hygiene. ---
  if (additions > largeThreshold) {
    comments.push({
      id: commentId('', undefined, 'size'),
      severity: 'suggestion',
      category: 'process',
      file: '',
      title: `Large change: ${additions} lines added across ${pr.files.length} files`,
      body: 'Review quality drops sharply past a few hundred lines. Consider splitting this into reviewable pieces.',
    });
  }

  if ((options.requireTests ?? true) && sourceFiles.length > 0 && changedTests === 0 && additions > 30) {
    comments.push({
      id: commentId('', undefined, 'tests'),
      severity: 'important',
      category: 'testing',
      file: '',
      title: 'No test changes accompany this change',
      body: `${sourceFiles.length} source file(s) changed with no corresponding test updates. Add coverage for the new behaviour, or explain why it is not needed.`,
    });
  }

  if (!pr.description || pr.description.trim().length < 30) {
    comments.push({
      id: commentId('', undefined, 'description'),
      severity: 'suggestion',
      category: 'process',
      file: '',
      title: 'Sparse description',
      body: 'Explain what changed and why. The reviewer should not have to reconstruct intent from the diff.',
    });
  }

  const parsedCommits: ParsedCommit[] = (pr.commits ?? []).map(parseCommit);
  const commitIssues = parsedCommits
    .filter((commit) => !commit.conventional)
    .map((commit) => `\`${commit.sha.slice(0, 7)}\` does not follow Conventional Commits: "${commit.subject}"`);

  const riskScore = round(
    clamp(comments.reduce((sum, comment) => sum + SEVERITY_WEIGHT[comment.severity], 0), 0, 100),
    1
  );

  const blocking = comments.filter((comment) => comment.severity === 'blocking').length;
  const important = comments.filter((comment) => comment.severity === 'important').length;

  const verdict: PullRequestReview['verdict'] =
    blocking > 0 ? 'request-changes' : important > 0 ? 'comment' : comments.length > 0 ? 'comment' : 'approve';

  const summary =
    blocking > 0
      ? `${blocking} blocking issue${blocking === 1 ? '' : 's'} must be resolved before merge.`
      : important > 0
        ? `No blockers, but ${important} issue${important === 1 ? '' : 's'} deserve attention.`
        : comments.length > 0
          ? `Looks reasonable. ${comments.length} minor suggestion${comments.length === 1 ? '' : 's'}.`
          : 'Looks good — nothing flagged in the changed lines.';

  const order: Record<ReviewSeverity, number> = { blocking: 0, important: 1, suggestion: 2, nitpick: 3 };

  return {
    verdict,
    summary,
    comments: comments.sort(
      (a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0)
    ),
    stats: {
      files: pr.files.length,
      additions,
      deletions,
      testFilesChanged: changedTests,
      riskScore,
    },
    commitIssues,
    checklist: [
      { label: 'No credentials in the diff', passed: !comments.some((c) => c.category === 'security' && c.title.startsWith('Possible credential')) },
      { label: 'No critical security patterns introduced', passed: blocking === 0 },
      { label: 'Tests accompany source changes', passed: changedTests > 0 || sourceFiles.length === 0 || additions <= 30 },
      { label: 'Change is a reviewable size', passed: additions <= largeThreshold },
      { label: 'Description explains the change', passed: (pr.description ?? '').trim().length >= 30 },
      { label: 'Commits follow the convention', passed: commitIssues.length === 0 },
    ],
  };
}

/** Render a review as a Markdown comment suitable for posting to a PR. */
export function renderReviewMarkdown(review: PullRequestReview): string {
  const icon = { approve: '✅', comment: '💬', 'request-changes': '⚠️' }[review.verdict];
  const lines: string[] = [`## ${icon} ForgeOS review`, '', review.summary, ''];

  lines.push(
    `\`${review.stats.files}\` files · \`+${review.stats.additions}\` / \`-${review.stats.deletions}\` · risk score \`${review.stats.riskScore}\``,
    ''
  );

  lines.push('### Checklist', '');
  for (const item of review.checklist) {
    lines.push(`- [${item.passed ? 'x' : ' '}] ${item.label}`);
  }
  lines.push('');

  if (review.comments.length > 0) {
    lines.push('### Findings', '');
    for (const comment of review.comments) {
      const where = comment.file ? `\`${comment.file}${comment.line ? `:${comment.line}` : ''}\`` : '_general_';
      lines.push(`**${comment.severity}** — ${comment.title} (${where})`, '', comment.body, '');
    }
  }

  if (review.commitIssues.length > 0) {
    lines.push('### Commit messages', '');
    for (const issue of review.commitIssues) lines.push(`- ${issue}`);
    lines.push('');
  }

  lines.push('---', '', '_Generated by ForgeOS. Findings are limited to the lines this change touched._');
  return lines.join('\n');
}
