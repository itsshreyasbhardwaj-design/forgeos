import type { RepoSnapshot } from '../fs/types.js';
import { shannonEntropy, fnv1a32 } from '../kernel/hash.js';
import { detectLanguage } from '../analysis/languages.js';

/**
 * Secret detection.
 *
 * Two complementary strategies, because neither alone is good enough:
 *
 *  1. **Provider patterns** — high-precision regexes for credentials with a
 *     recognisable shape (`sk-`, `ghp_`, `AKIA…`). These are near-zero false
 *     positive and are reported at high confidence.
 *  2. **Entropy analysis** — for credentials with no fixed shape, a long
 *     high-entropy string assigned to a suspiciously-named variable. This is
 *     where false positives live, so it is gated on *three* independent
 *     signals: assignment context, length, and entropy.
 *
 * Every finding carries a redacted preview. The full secret is never stored,
 * never logged and never returned by the API — a secret scanner that copies
 * secrets into its own database has made the problem worse.
 */
export type SecretConfidence = 'high' | 'medium' | 'low';

export interface SecretFinding {
  readonly id: string;
  readonly rule: string;
  readonly description: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly confidence: SecretConfidence;
  /** First and last few characters only, e.g. `ghp_ab…yz`. */
  readonly preview: string;
  readonly entropy: number;
  readonly remediation: string;
}

interface SecretRule {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
  readonly confidence: SecretConfidence;
  /** Minimum entropy for the captured value; skips obvious placeholders. */
  readonly minEntropy?: number;
  readonly remediation?: string;
}

const ROTATE = (service: string): string =>
  `Revoke this ${service} credential immediately, issue a replacement, and load it from the environment rather than source.`;

export const SECRET_RULES: readonly SecretRule[] = [
  { id: 'aws-access-key', description: 'AWS access key id', pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g, confidence: 'high', remediation: ROTATE('AWS') },
  { id: 'aws-secret-key', description: 'AWS secret access key', pattern: /aws(.{0,20})?secret(.{0,20})?['"\s:=]+([A-Za-z0-9/+=]{40})/gi, confidence: 'high', minEntropy: 4, remediation: ROTATE('AWS') },
  { id: 'github-token', description: 'GitHub personal access token', pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,255})\b/g, confidence: 'high', remediation: ROTATE('GitHub') },
  { id: 'github-fine-grained', description: 'GitHub fine-grained token', pattern: /\b(github_pat_[A-Za-z0-9_]{22,255})\b/g, confidence: 'high', remediation: ROTATE('GitHub') },
  { id: 'slack-token', description: 'Slack token', pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, confidence: 'high', remediation: ROTATE('Slack') },
  { id: 'stripe-key', description: 'Stripe secret key', pattern: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})\b/g, confidence: 'high', remediation: ROTATE('Stripe') },
  { id: 'openai-key', description: 'OpenAI API key', pattern: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g, confidence: 'high', remediation: ROTATE('OpenAI') },
  { id: 'anthropic-key', description: 'Anthropic API key', pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g, confidence: 'high', remediation: ROTATE('Anthropic') },
  { id: 'google-api-key', description: 'Google API key', pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/g, confidence: 'high', remediation: ROTATE('Google') },
  { id: 'sendgrid-key', description: 'SendGrid API key', pattern: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g, confidence: 'high', remediation: ROTATE('SendGrid') },
  { id: 'twilio-key', description: 'Twilio account SID', pattern: /\b(AC[a-f0-9]{32})\b/g, confidence: 'medium', remediation: ROTATE('Twilio') },
  { id: 'npm-token', description: 'npm access token', pattern: /\b(npm_[A-Za-z0-9]{36})\b/g, confidence: 'high', remediation: ROTATE('npm') },
  { id: 'private-key', description: 'Private key block', pattern: /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PGP)?\s*PRIVATE KEY-----/g, confidence: 'high', remediation: 'Remove the key from version control, rotate the key pair, and purge it from history.' },
  { id: 'jwt', description: 'JSON Web Token', pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, confidence: 'medium', remediation: 'Treat the token as compromised and invalidate the session or signing key.' },
  { id: 'database-url', description: 'Database connection string with credentials', pattern: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s'"]+:[^@\s'"]+@[^\s'"]+)/g, confidence: 'high', remediation: 'Move the connection string to an environment variable and rotate the database password.' },
  { id: 'slack-webhook', description: 'Slack incoming webhook', pattern: /(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+]{40,})/g, confidence: 'high', remediation: ROTATE('Slack webhook') },
  { id: 'basic-auth-header', description: 'Hard-coded basic auth header', pattern: /Authorization['"\s:=]+Basic\s+([A-Za-z0-9+/=]{16,})/gi, confidence: 'medium', remediation: 'Replace with a credential loaded at runtime.' },
];

/**
 * Variable names that, combined with a high-entropy literal, indicate a secret.
 * Requiring an assignment context is what keeps entropy scanning usable —
 * without it, every hash, UUID and minified bundle becomes a finding.
 */
const ASSIGNMENT_PATTERN =
  /\b([A-Za-z_][\w.-]{0,40}(?:secret|token|password|passwd|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth)[\w.-]{0,20})\s*[:=]\s*['"`]([^'"`\s]{16,120})['"`]/gi;

/** Values that look like secrets but are obviously not. */
const PLACEHOLDER_PATTERN =
  /^(?:x{3,}|\*{3,}|\.{3,}|<[^>]+>|\$\{[^}]*\}|%[a-z_]+%|\{\{.*\}\}|(?:your|my|the)[_-]?|change[_-]?me|example|sample|dummy|placeholder|redacted|insert|todo|test|fake|null|none|undefined|password|secret|token|abc123|foobar)/i;

const PLACEHOLDER_SUFFIX = /(?:here|_here|-here|\.\.\.|xxx|example\.com)$/i;

/** Paths where a credential-shaped string is expected and harmless. */
const ALLOWED_PATH =
  /(\.|\/)(test|spec)\.[\w]+$|(^|\/)(tests?|__tests__|__fixtures__|__mocks__|e2e|fixtures|examples?|docs?)(\/|$)|\.env\.example$|\.env\.sample$|\.md$|\.lock$|\.snap$/i;

function isPlaceholder(value: string): boolean {
  if (PLACEHOLDER_PATTERN.test(value)) return true;
  if (PLACEHOLDER_SUFFIX.test(value)) return true;
  // A single repeated character, or an obvious sequence.
  if (/^(.)\1+$/.test(value)) return true;
  return false;
}

function preview(value: string): string {
  if (value.length <= 12) return `${value.slice(0, 2)}${'•'.repeat(6)}`;
  return `${value.slice(0, 4)}${'•'.repeat(6)}${value.slice(-2)}`;
}

function positionOf(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: index - lastNewline };
}

export interface SecretScanOptions {
  /** Also scan documentation, tests and example files. Default false. */
  readonly includeAllowlistedPaths?: boolean;
  /** Minimum entropy for the heuristic assignment rule. Default 3.5 bits/char. */
  readonly minEntropy?: number;
}

export function scanSecrets(
  snapshot: RepoSnapshot,
  options: SecretScanOptions = {}
): SecretFinding[] {
  const minEntropy = options.minEntropy ?? 3.5;
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  for (const file of snapshot.files) {
    if (file.text === null) continue;
    // Minified bundles are pure entropy and produce nothing but noise.
    if (/\.min\.(js|css)$/.test(file.path)) continue;
    const allowlisted = ALLOWED_PATH.test(file.path);
    if (allowlisted && !options.includeAllowlistedPaths) continue;

    const text = file.text;

    for (const rule of SECRET_RULES) {
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(text)) !== null) {
        // Prefer the last capture group; several rules capture context first.
        const captured = match.slice(1).filter(Boolean).pop() ?? match[0];
        if (isPlaceholder(captured)) continue;

        const entropy = shannonEntropy(captured);
        if (rule.minEntropy !== undefined && entropy < rule.minEntropy) continue;

        const { line, column } = positionOf(text, match.index);
        const id = `sec_${fnv1a32(`${file.path}:${line}:${rule.id}`).toString(36)}`;
        if (seen.has(id)) continue;
        seen.add(id);

        findings.push({
          id,
          rule: rule.id,
          description: rule.description,
          file: file.path,
          line,
          column,
          // A hit inside an allowlisted path is reported at reduced confidence.
          confidence: allowlisted ? 'low' : rule.confidence,
          preview: preview(captured),
          entropy: Math.round(entropy * 100) / 100,
          remediation: rule.remediation ?? 'Rotate the credential and load it from the environment.',
        });

        if (pattern.lastIndex <= match.index) pattern.lastIndex = match.index + 1;
      }
    }

    // Entropy heuristic — only in source files, where a literal assignment to a
    // credential-shaped name is genuinely suspicious.
    if (detectLanguage(file.path)?.category !== 'programming' && !/\.env/.test(file.path)) continue;

    const assignments = new RegExp(ASSIGNMENT_PATTERN.source, ASSIGNMENT_PATTERN.flags);
    let assignment: RegExpExecArray | null;
    while ((assignment = assignments.exec(text)) !== null) {
      const name = assignment[1] ?? '';
      const value = assignment[2] ?? '';
      if (isPlaceholder(value)) continue;
      // Environment lookups and interpolation are the *correct* pattern.
      if (/process\.env|os\.environ|getenv|System\.getenv/.test(value)) continue;

      const entropy = shannonEntropy(value);
      if (entropy < minEntropy) continue;

      const { line, column } = positionOf(text, assignment.index);
      const id = `sec_${fnv1a32(`${file.path}:${line}:entropy`).toString(36)}`;
      if (seen.has(id)) continue;
      seen.add(id);

      findings.push({
        id,
        rule: 'high-entropy-assignment',
        description: `High-entropy value assigned to \`${name}\``,
        file: file.path,
        line,
        column,
        confidence: entropy > 4.2 && value.length >= 32 ? 'medium' : 'low',
        preview: preview(value),
        entropy: Math.round(entropy * 100) / 100,
        remediation: 'If this is a credential, rotate it and read it from the environment instead.',
      });
    }
  }

  const order: Record<SecretConfidence, number> = { high: 0, medium: 1, low: 2 };
  return findings.sort(
    (a, b) => order[a.confidence] - order[b.confidence] || a.file.localeCompare(b.file) || a.line - b.line
  );
}

/**
 * Check that a repository's ignore rules actually cover its secret files.
 * A `.env` that is present *and* ignored is fine; one that is committed is not.
 */
export function auditEnvironmentFiles(snapshot: RepoSnapshot): {
  readonly committedEnvFiles: readonly string[];
  readonly hasGitignore: boolean;
  readonly gitignoresEnv: boolean;
} {
  const committed = snapshot.files
    .filter(
      (file) => /(^|\/)\.env(\.[\w-]+)?$/.test(file.path) && !/\.(example|sample|template)$/.test(file.path)
    )
    .map((file) => file.path);

  const gitignore = snapshot.files.find((file) => file.path === '.gitignore');
  const contents = gitignore?.text ?? '';

  return {
    committedEnvFiles: committed,
    hasGitignore: gitignore !== undefined,
    gitignoresEnv: /^\s*\*?\.env/m.test(contents),
  };
}
