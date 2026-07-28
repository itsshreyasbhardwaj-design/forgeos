import type { RepoSnapshot } from '../fs/types.js';
import type { Dependency } from '../analysis/manifests.js';
import { auditEnvironmentFiles, scanSecrets, type SecretFinding } from './secrets.js';
import { scanCodePatterns, type CodeSecurityFinding, type SecurityCategory } from './patterns.js';
import {
  BUNDLED_ADVISORIES,
  matchVulnerabilities,
  mergeAdvisorySets,
  type Advisory,
  type AdvisorySource,
  type Severity,
  type VulnerabilityMatch,
} from './advisories.js';
import { deterministicId } from '../kernel/id.js';
import { clamp, round } from '../kernel/text.js';

/**
 * The consolidated security report.
 *
 * Three independent scanners feed one posture score. The score is weighted by
 * *exploitability*, not by count: one committed production credential outweighs
 * fifty low-severity findings, and the report says so rather than averaging the
 * signal away.
 */
export interface SecurityPosture {
  /** 0–100, higher is safer. */
  readonly score: number;
  readonly grade: 'A' | 'B' | 'C' | 'D' | 'F';
  readonly summary: string;
}

export interface ComplianceControl {
  readonly id: string;
  readonly framework: 'OWASP Top 10' | 'OWASP LLM Top 10' | 'CIS' | 'SOC 2';
  readonly title: string;
  readonly status: 'pass' | 'fail' | 'not-assessed';
  readonly findings: number;
  readonly detail: string;
}

export interface RemediationStep {
  readonly priority: number;
  readonly title: string;
  readonly detail: string;
  readonly affected: readonly string[];
  readonly effort: 'trivial' | 'small' | 'medium' | 'large';
}

export interface SecurityReport {
  readonly id: string;
  readonly repository: string;
  readonly generatedAt: number;
  readonly posture: SecurityPosture;
  readonly secrets: readonly SecretFinding[];
  readonly code: readonly CodeSecurityFinding[];
  readonly dependencies: readonly VulnerabilityMatch[];
  readonly environment: ReturnType<typeof auditEnvironmentFiles>;
  readonly compliance: readonly ComplianceControl[];
  readonly remediation: readonly RemediationStep[];
  readonly counts: {
    readonly critical: number;
    readonly high: number;
    readonly moderate: number;
    readonly low: number;
  };
  /** Which advisory sources were consulted, so coverage is never overstated. */
  readonly advisorySources: readonly string[];
  readonly durationMs: number;
}

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 40,
  high: 15,
  moderate: 5,
  low: 1,
};

function normaliseSeverity(
  value: CodeSecurityFinding['severity'] | Severity
): Severity {
  return value;
}

export interface SecurityScanOptions {
  /** Extra advisory sources consulted in addition to the bundled set. */
  readonly sources?: readonly AdvisorySource[];
  readonly includeTests?: boolean;
  readonly categories?: readonly SecurityCategory[];
  readonly now?: () => number;
}

export async function scanRepository(
  snapshot: RepoSnapshot,
  dependencies: readonly Dependency[],
  options: SecurityScanOptions = {}
): Promise<SecurityReport> {
  const now = options.now ?? Date.now;
  const startedAt = now();

  const secrets = scanSecrets(snapshot);
  const code = scanCodePatterns(snapshot, {
    ...(options.includeTests !== undefined ? { includeTests: options.includeTests } : {}),
    ...(options.categories ? { categories: options.categories } : {}),
  });
  const environment = auditEnvironmentFiles(snapshot);

  const sourceNames = ['forgeos-bundled'];
  let advisories: Advisory[] = [...BUNDLED_ADVISORIES];

  for (const source of options.sources ?? []) {
    try {
      const extra = await source.lookup(dependencies);
      advisories = mergeAdvisorySets(extra, advisories);
      sourceNames.push(source.name);
    } catch {
      // A failing feed must degrade coverage, not fail the whole scan. The
      // source is omitted from `advisorySources` so the gap is visible.
    }
  }

  const vulnerabilities = matchVulnerabilities(dependencies, advisories);

  const counts = { critical: 0, high: 0, moderate: 0, low: 0 };
  let penalty = 0;

  for (const finding of secrets) {
    // A committed credential is treated as critical unless it is only a
    // low-confidence entropy hit.
    const severity: Severity =
      finding.confidence === 'high' ? 'critical' : finding.confidence === 'medium' ? 'high' : 'low';
    counts[severity]++;
    penalty += SEVERITY_WEIGHT[severity];
  }

  for (const finding of code) {
    const severity = normaliseSeverity(finding.severity);
    counts[severity]++;
    penalty += SEVERITY_WEIGHT[severity];
  }

  for (const match of vulnerabilities) {
    const severity = match.advisory.severity;
    counts[severity]++;
    // A range match is weaker evidence than a pinned vulnerable version.
    penalty += SEVERITY_WEIGHT[severity] * (match.matchKind === 'exact' ? 1 : 0.6);
  }

  if (environment.committedEnvFiles.length > 0) {
    counts.critical++;
    penalty += SEVERITY_WEIGHT.critical;
  }

  // Saturating curve, same rationale as the health score: a linear penalty
  // pins every non-trivial repository at zero and stops being comparable.
  const score = round((100 * 45) / (penalty + 45), 1);

  const posture: SecurityPosture = {
    score,
    grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 55 ? 'C' : score >= 35 ? 'D' : 'F',
    summary: describePosture(counts, secrets.length, vulnerabilities.length),
  };

  return {
    id: deterministicId('sec', snapshot.source, String(snapshot.collectedAt)),
    repository: snapshot.name,
    generatedAt: startedAt,
    posture,
    secrets,
    code,
    dependencies: vulnerabilities,
    environment,
    compliance: assessCompliance(code, secrets, vulnerabilities, environment),
    remediation: buildRemediationPlan(secrets, code, vulnerabilities, environment),
    counts,
    advisorySources: sourceNames,
    durationMs: Math.max(0, now() - startedAt),
  };
}

function describePosture(
  counts: SecurityReport['counts'],
  secrets: number,
  vulnerabilities: number
): string {
  if (counts.critical === 0 && counts.high === 0) {
    return 'No critical or high-severity issues detected in the scanned surface.';
  }
  const parts: string[] = [];
  if (secrets > 0) parts.push(`${secrets} potential credential${secrets === 1 ? '' : 's'} in source`);
  if (vulnerabilities > 0) {
    parts.push(`${vulnerabilities} vulnerable dependenc${vulnerabilities === 1 ? 'y' : 'ies'}`);
  }
  if (counts.critical > 0) parts.push(`${counts.critical} critical code finding${counts.critical === 1 ? '' : 's'}`);
  return `Immediate attention required: ${parts.join(', ')}.`;
}

/**
 * Map findings onto control frameworks.
 *
 * Controls with no corresponding scanner are reported as `not-assessed` rather
 * than `pass`. A compliance report that silently passes what it never checked
 * is worse than no report at all.
 */
export function assessCompliance(
  code: readonly CodeSecurityFinding[],
  secrets: readonly SecretFinding[],
  vulnerabilities: readonly VulnerabilityMatch[],
  environment: ReturnType<typeof auditEnvironmentFiles>
): ComplianceControl[] {
  const byCategory = (category: SecurityCategory): number =>
    code.filter((finding) => finding.category === category).length;

  const control = (
    id: string,
    framework: ComplianceControl['framework'],
    title: string,
    findings: number,
    detail: string,
    assessed = true
  ): ComplianceControl => ({
    id,
    framework,
    title,
    status: !assessed ? 'not-assessed' : findings === 0 ? 'pass' : 'fail',
    findings,
    detail,
  });

  const highConfidenceSecrets = secrets.filter((s) => s.confidence !== 'low').length;

  return [
    control('A01', 'OWASP Top 10', 'Broken Access Control', byCategory('access-control'), 'Path handling, CORS and authorisation checks.'),
    control('A02', 'OWASP Top 10', 'Cryptographic Failures', byCategory('crypto') + byCategory('transport'), 'Hashing, randomness and transport security.'),
    control('A03', 'OWASP Top 10', 'Injection', byCategory('injection') + byCategory('xss'), 'SQL, command and template injection surfaces.'),
    control('A04', 'OWASP Top 10', 'Insecure Design', 0, 'Requires threat modelling; not derivable from static analysis.', false),
    control('A05', 'OWASP Top 10', 'Security Misconfiguration', byCategory('configuration') + environment.committedEnvFiles.length, 'Debug flags and committed environment files.'),
    control('A06', 'OWASP Top 10', 'Vulnerable and Outdated Components', vulnerabilities.length, 'Declared dependencies matched against known advisories.'),
    control('A07', 'OWASP Top 10', 'Identification and Authentication Failures', byCategory('authn'), 'Session cookies and token verification.'),
    control('A08', 'OWASP Top 10', 'Software and Data Integrity Failures', byCategory('deserialization'), 'Unsafe deserialization of untrusted data.'),
    control('A09', 'OWASP Top 10', 'Security Logging and Monitoring Failures', 0, 'Requires runtime evidence; not derivable from source.', false),
    control('A10', 'OWASP Top 10', 'Server-Side Request Forgery', 0, 'Requires data-flow analysis beyond pattern matching.', false),
    control('LLM01', 'OWASP LLM Top 10', 'Prompt Injection', code.filter((f) => f.rule === 'prompt-injection-surface').length, 'Untrusted input reaching model instructions.'),
    control('LLM02', 'OWASP LLM Top 10', 'Insecure Output Handling', code.filter((f) => f.rule === 'llm-output-to-sink').length, 'Model output reaching an execution or rendering sink.'),
    control('LLM06', 'OWASP LLM Top 10', 'Sensitive Information Disclosure', code.filter((f) => f.rule === 'model-key-client-side').length, 'Model credentials exposed to clients.'),
    control('LLM08', 'OWASP LLM Top 10', 'Excessive Agency', code.filter((f) => f.rule === 'unbounded-tool-execution').length, 'Tool dispatch without an allowlist.'),
    control('CC6.1', 'SOC 2', 'Logical access — credential management', highConfidenceSecrets, 'Credentials must not be stored in source control.'),
    control('CC7.1', 'SOC 2', 'Vulnerability identification', vulnerabilities.filter((v) => v.advisory.severity === 'critical' || v.advisory.severity === 'high').length, 'Known high-severity dependency vulnerabilities.'),
  ];
}

/** Order remediation by exploitability, then by how cheap the fix is. */
export function buildRemediationPlan(
  secrets: readonly SecretFinding[],
  code: readonly CodeSecurityFinding[],
  vulnerabilities: readonly VulnerabilityMatch[],
  environment: ReturnType<typeof auditEnvironmentFiles>
): RemediationStep[] {
  const steps: RemediationStep[] = [];

  const confirmedSecrets = secrets.filter((secret) => secret.confidence === 'high');
  if (confirmedSecrets.length > 0) {
    steps.push({
      priority: 1,
      title: `Rotate ${confirmedSecrets.length} exposed credential${confirmedSecrets.length === 1 ? '' : 's'}`,
      detail:
        'Revoke each credential at its provider before anything else — a credential in git history is compromised even after the file is deleted.',
      affected: confirmedSecrets.map((secret) => `${secret.file}:${secret.line}`),
      effort: 'small',
    });
  }

  if (environment.committedEnvFiles.length > 0) {
    steps.push({
      priority: 1,
      title: 'Remove committed environment files',
      detail: environment.gitignoresEnv
        ? 'These files are ignored going forward but are already tracked; remove them with `git rm --cached` and purge them from history.'
        : 'Add `.env*` to .gitignore, untrack the files, and purge them from history.',
      affected: environment.committedEnvFiles,
      effort: 'small',
    });
  }

  const criticalCode = code.filter((finding) => finding.severity === 'critical');
  if (criticalCode.length > 0) {
    steps.push({
      priority: 2,
      title: `Fix ${criticalCode.length} critical code finding${criticalCode.length === 1 ? '' : 's'}`,
      detail: [...new Set(criticalCode.map((finding) => finding.remediation))].join(' '),
      affected: criticalCode.map((finding) => `${finding.file}:${finding.line}`),
      effort: 'medium',
    });
  }

  const upgradable = vulnerabilities.filter((match) => match.fixAvailable);
  if (upgradable.length > 0) {
    const byPackage = new Map<string, string>();
    for (const match of upgradable) {
      byPackage.set(match.dependency.name, match.advisory.patchedVersion ?? 'latest');
    }
    steps.push({
      priority: 3,
      title: `Upgrade ${byPackage.size} vulnerable dependenc${byPackage.size === 1 ? 'y' : 'ies'}`,
      detail: [...byPackage.entries()].map(([name, version]) => `${name} → ${version}`).join(', '),
      affected: [...byPackage.keys()],
      effort: byPackage.size > 5 ? 'medium' : 'small',
    });
  }

  const highCode = code.filter((finding) => finding.severity === 'high');
  if (highCode.length > 0) {
    steps.push({
      priority: 4,
      title: `Review ${highCode.length} high-severity pattern${highCode.length === 1 ? '' : 's'}`,
      detail: 'Each of these is dangerous by shape; confirm whether untrusted input can reach it.',
      affected: highCode.map((finding) => `${finding.file}:${finding.line}`),
      effort: 'medium',
    });
  }

  const unfixable = vulnerabilities.filter((match) => !match.fixAvailable);
  if (unfixable.length > 0) {
    steps.push({
      priority: 5,
      title: 'Mitigate dependencies with no published fix',
      detail:
        'No patched version exists. Assess exploitability in context, and consider vendoring, replacing, or compensating controls.',
      affected: unfixable.map((match) => match.dependency.name),
      effort: 'large',
    });
  }

  return steps.sort((a, b) => a.priority - b.priority);
}

/** Trend point for the security dashboard. */
export interface PostureTrendPoint {
  readonly at: number;
  readonly score: number;
  readonly critical: number;
  readonly high: number;
}

export function trendFromReports(reports: readonly SecurityReport[]): PostureTrendPoint[] {
  return [...reports]
    .sort((a, b) => a.generatedAt - b.generatedAt)
    .map((report) => ({
      at: report.generatedAt,
      score: report.posture.score,
      critical: report.counts.critical,
      high: report.counts.high,
    }));
}

/** Percentage change between the two most recent reports, for the UI delta. */
export function postureDelta(reports: readonly SecurityReport[]): number {
  const trend = trendFromReports(reports);
  const previous = trend[trend.length - 2];
  const latest = trend[trend.length - 1];
  if (!previous || !latest || previous.score === 0) return 0;
  return round(clamp(((latest.score - previous.score) / previous.score) * 100, -100, 100), 1);
}
