import { truncate } from '../kernel/text.js';

/**
 * Conventional Commits parsing, changelog and release-note generation.
 *
 * Everything here is derived from commit metadata alone, so it works against
 * any Git host, offline, with no API token. Commits that do not follow the
 * convention are not discarded — they are grouped under "Other changes", because
 * a changelog that silently omits work is worse than an untidy one.
 */
export interface RawCommit {
  readonly sha: string;
  readonly subject: string;
  readonly body?: string;
  readonly author: string;
  readonly authoredAt: number;
  readonly files?: readonly string[];
}

export type CommitType =
  | 'feat'
  | 'fix'
  | 'perf'
  | 'refactor'
  | 'docs'
  | 'test'
  | 'build'
  | 'ci'
  | 'chore'
  | 'style'
  | 'revert'
  | 'other';

export interface ParsedCommit extends RawCommit {
  readonly type: CommitType;
  readonly scope?: string;
  readonly description: string;
  readonly breaking: boolean;
  readonly breakingDescription?: string;
  readonly references: readonly string[];
  readonly conventional: boolean;
}

const CONVENTIONAL =
  /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?:\s*(?<description>.+)$/i;

const KNOWN_TYPES = new Set<CommitType>([
  'feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'style', 'revert',
]);

export function parseCommit(commit: RawCommit): ParsedCommit {
  const match = CONVENTIONAL.exec(commit.subject.trim());
  const body = commit.body ?? '';

  const references = [
    ...new Set([
      ...[...commit.subject.matchAll(/#(\d+)/g)].map((m) => m[1] ?? ''),
      ...[...body.matchAll(/(?:closes?|fixes?|resolves?)\s+#(\d+)/gi)].map((m) => m[1] ?? ''),
    ]),
  ].filter(Boolean);

  const breakingFooter = /^BREAKING[ -]CHANGE:\s*(.+)$/im.exec(body);

  if (!match?.groups) {
    return {
      ...commit,
      type: 'other',
      description: commit.subject.trim(),
      breaking: Boolean(breakingFooter),
      ...(breakingFooter?.[1] ? { breakingDescription: breakingFooter[1].trim() } : {}),
      references,
      conventional: false,
    };
  }

  const rawType = (match.groups.type ?? '').toLowerCase() as CommitType;

  return {
    ...commit,
    type: KNOWN_TYPES.has(rawType) ? rawType : 'other',
    ...(match.groups.scope ? { scope: match.groups.scope } : {}),
    description: (match.groups.description ?? '').trim(),
    breaking: Boolean(match.groups.breaking) || Boolean(breakingFooter),
    ...(breakingFooter?.[1] ? { breakingDescription: breakingFooter[1].trim() } : {}),
    references,
    conventional: KNOWN_TYPES.has(rawType),
  };
}

const SECTION_ORDER: readonly { type: CommitType; heading: string }[] = [
  { type: 'feat', heading: 'Features' },
  { type: 'fix', heading: 'Bug fixes' },
  { type: 'perf', heading: 'Performance' },
  { type: 'refactor', heading: 'Refactoring' },
  { type: 'docs', heading: 'Documentation' },
  { type: 'test', heading: 'Tests' },
  { type: 'build', heading: 'Build' },
  { type: 'ci', heading: 'Continuous integration' },
  { type: 'style', heading: 'Styling' },
  { type: 'chore', heading: 'Chores' },
  { type: 'revert', heading: 'Reverts' },
  { type: 'other', heading: 'Other changes' },
];

export type ReleaseKind = 'major' | 'minor' | 'patch';

/**
 * Determine the release type from the commits.
 * Breaking changes force a major; a feature forces a minor; anything else is a
 * patch. This is the rule the ecosystem expects, and deviating from it silently
 * breaks consumers' automated upgrades.
 */
export function inferReleaseKind(commits: readonly ParsedCommit[]): ReleaseKind {
  if (commits.some((commit) => commit.breaking)) return 'major';
  if (commits.some((commit) => commit.type === 'feat')) return 'minor';
  return 'patch';
}

export function bumpVersion(version: string, kind: ReleaseKind): string {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return '1.0.0';
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export interface ChangelogOptions {
  readonly version: string;
  readonly date?: Date;
  readonly repositoryUrl?: string;
  readonly previousVersion?: string;
  /** Omit sections readers rarely care about. Default true. */
  readonly hideNoise?: boolean;
}

const NOISE_TYPES = new Set<CommitType>(['chore', 'style', 'ci', 'build']);

export function generateChangelog(
  commits: readonly ParsedCommit[],
  options: ChangelogOptions
): string {
  const date = (options.date ?? new Date()).toISOString().slice(0, 10);
  const lines: string[] = [`## ${options.version} — ${date}`, ''];

  const breaking = commits.filter((commit) => commit.breaking);
  if (breaking.length > 0) {
    lines.push('### ⚠ Breaking changes', '');
    for (const commit of breaking) {
      lines.push(
        `- ${commit.scope ? `**${commit.scope}:** ` : ''}${commit.breakingDescription ?? commit.description}${link(commit, options)}`
      );
    }
    lines.push('');
  }

  for (const section of SECTION_ORDER) {
    if (options.hideNoise !== false && NOISE_TYPES.has(section.type)) continue;
    const entries = commits.filter((commit) => commit.type === section.type && !commit.breaking);
    if (entries.length === 0) continue;

    lines.push(`### ${section.heading}`, '');
    // Group by scope so related changes read together.
    const byScope = new Map<string, ParsedCommit[]>();
    for (const commit of entries) {
      const scope = commit.scope ?? '';
      const bucket = byScope.get(scope) ?? [];
      bucket.push(commit);
      byScope.set(scope, bucket);
    }
    for (const [scope, scoped] of [...byScope.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const commit of scoped) {
        lines.push(`- ${scope ? `**${scope}:** ` : ''}${commit.description}${link(commit, options)}`);
      }
    }
    lines.push('');
  }

  if (options.repositoryUrl && options.previousVersion) {
    lines.push(
      `**Full diff:** ${options.repositoryUrl}/compare/${options.previousVersion}...${options.version}`,
      ''
    );
  }

  return lines.join('\n');
}

function link(commit: ParsedCommit, options: ChangelogOptions): string {
  const short = commit.sha.slice(0, 7);
  const shaLink = options.repositoryUrl
    ? ` ([${short}](${options.repositoryUrl}/commit/${commit.sha}))`
    : ` (${short})`;
  const issues = commit.references
    .map((reference) =>
      options.repositoryUrl
        ? `[#${reference}](${options.repositoryUrl}/issues/${reference})`
        : `#${reference}`
    )
    .join(', ');
  return `${issues ? ` — closes ${issues}` : ''}${shaLink}`;
}

/**
 * Release notes: a narrative summary rather than a raw list.
 * Written for a reader deciding whether to upgrade.
 */
export function generateReleaseNotes(
  commits: readonly ParsedCommit[],
  options: ChangelogOptions & { projectName?: string }
): string {
  const kind = inferReleaseKind(commits);
  const features = commits.filter((commit) => commit.type === 'feat');
  const fixes = commits.filter((commit) => commit.type === 'fix');
  const breaking = commits.filter((commit) => commit.breaking);
  const contributors = [...new Set(commits.map((commit) => commit.author))].sort();

  const lines: string[] = [`# ${options.projectName ?? 'Release'} ${options.version}`, ''];

  const headline: string[] = [];
  if (features.length > 0) headline.push(`${features.length} new feature${features.length === 1 ? '' : 's'}`);
  if (fixes.length > 0) headline.push(`${fixes.length} fix${fixes.length === 1 ? '' : 'es'}`);
  if (breaking.length > 0) {
    headline.push(`${breaking.length} breaking change${breaking.length === 1 ? '' : 's'}`);
  }

  lines.push(
    `This is a **${kind}** release containing ${headline.length > 0 ? headline.join(', ') : `${commits.length} commits`}.`,
    ''
  );

  if (breaking.length > 0) {
    lines.push('## Before you upgrade', '');
    for (const commit of breaking) {
      lines.push(`- **${commit.scope ?? 'general'}** — ${commit.breakingDescription ?? commit.description}`);
    }
    lines.push('');
  }

  if (features.length > 0) {
    lines.push("## What's new", '');
    for (const commit of features.slice(0, 15)) {
      lines.push(`- ${commit.scope ? `**${commit.scope}:** ` : ''}${truncate(commit.description, 160)}`);
    }
    lines.push('');
  }

  if (fixes.length > 0) {
    lines.push('## Fixed', '');
    for (const commit of fixes.slice(0, 15)) {
      lines.push(`- ${commit.scope ? `**${commit.scope}:** ` : ''}${truncate(commit.description, 160)}`);
    }
    lines.push('');
  }

  if (contributors.length > 0) {
    lines.push('## Contributors', '');
    lines.push(contributors.map((name) => `@${name.replace(/^@/, '')}`).join(', '), '');
  }

  return lines.join('\n');
}

export interface CommitQualityIssue {
  readonly sha: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

/** Lint commit messages against the convention. */
export function lintCommits(commits: readonly ParsedCommit[]): CommitQualityIssue[] {
  const issues: CommitQualityIssue[] = [];

  for (const commit of commits) {
    if (!commit.conventional) {
      issues.push({
        sha: commit.sha,
        severity: 'warning',
        message: `"${truncate(commit.subject, 60)}" does not follow Conventional Commits.`,
      });
      continue;
    }
    if (commit.description.length > 72) {
      issues.push({
        sha: commit.sha,
        severity: 'warning',
        message: 'Subject line exceeds 72 characters.',
      });
    }
    if (/^[A-Z]/.test(commit.description) && !/^[A-Z]{2,}/.test(commit.description)) {
      issues.push({
        sha: commit.sha,
        severity: 'warning',
        message: 'Description should start lowercase.',
      });
    }
    if (/\.$/.test(commit.description)) {
      issues.push({
        sha: commit.sha,
        severity: 'warning',
        message: 'Description should not end with a period.',
      });
    }
    if (commit.breaking && !commit.breakingDescription) {
      issues.push({
        sha: commit.sha,
        severity: 'error',
        message: 'Breaking change is marked but not explained in a BREAKING CHANGE footer.',
      });
    }
  }

  return issues;
}

/**
 * Parse `git log` output produced with a known format.
 * Format: `--pretty=format:%H%x1f%an%x1f%at%x1f%s%x1f%b%x1e`
 */
export function parseGitLog(output: string): RawCommit[] {
  // Explicit escapes: literal control characters in source are invisible and
  // do not survive copy/paste or reformatting.
  const RECORD_SEPARATOR = '\u001e';
  const FIELD_SEPARATOR = '\u001f';
  return output
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = '', author = '', timestamp = '0', subject = '', body = ''] =
        record.split(FIELD_SEPARATOR);
      return {
        sha,
        author,
        authoredAt: Number(timestamp) * 1000,
        subject,
        ...(body.trim() ? { body: body.trim() } : {}),
      } satisfies RawCommit;
    })
    .filter((commit) => commit.sha !== '');
}

export const GIT_LOG_FORMAT = '--pretty=format:%H%x1f%an%x1f%at%x1f%s%x1f%b%x1e';
