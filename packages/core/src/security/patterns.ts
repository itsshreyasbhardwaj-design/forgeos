import type { RepoSnapshot } from '../fs/types.js';
import { detectLanguage } from '../analysis/languages.js';
import { stripComments } from '../analysis/complexity.js';
import { fnv1a32 } from '../kernel/hash.js';

/**
 * Static analysis for insecure code patterns.
 *
 * These rules are pattern-based, which makes them fast and language-agnostic
 * but means they cannot prove a data-flow path from user input to a sink. Every
 * rule is therefore written to fire only on the *shape* that is dangerous
 * regardless of provenance — string-interpolated SQL, `eval` of a non-literal,
 * TLS verification explicitly disabled — and each finding states what to check.
 *
 * The AI-specific rules exist because LLM features introduce sinks that
 * conventional scanners do not model at all: a prompt is an injection surface,
 * and model output reaching `eval`, a shell or `innerHTML` is remote code
 * execution with extra steps.
 */
export type SecurityCategory =
  | 'injection'
  | 'crypto'
  | 'transport'
  | 'authn'
  | 'access-control'
  | 'configuration'
  | 'xss'
  | 'deserialization'
  | 'ai';

export interface CodeSecurityFinding {
  readonly id: string;
  readonly rule: string;
  readonly category: SecurityCategory;
  readonly severity: 'critical' | 'high' | 'moderate' | 'low';
  readonly title: string;
  readonly detail: string;
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
  readonly owasp?: string;
  readonly cwe?: string;
  readonly remediation: string;
}

interface PatternRule {
  readonly id: string;
  readonly category: SecurityCategory;
  readonly severity: CodeSecurityFinding['severity'];
  readonly title: string;
  readonly detail: string;
  readonly pattern: RegExp;
  readonly languages?: readonly string[];
  readonly owasp?: string;
  readonly cwe?: string;
  readonly remediation: string;
  /** Skip the finding when this pattern also matches the same line. */
  readonly unless?: RegExp;
}

const JS = ['typescript', 'tsx', 'javascript', 'jsx'] as const;
const PY = ['python'] as const;

export const SECURITY_PATTERNS: readonly PatternRule[] = [
  // --- Injection ---
  {
    id: 'sql-string-interpolation',
    category: 'injection',
    severity: 'critical',
    title: 'SQL built by string interpolation',
    detail: 'A query is assembled from a template literal or concatenation rather than parameters.',
    pattern: /\b(?:query|execute|exec|raw|prepare)\s*\(\s*[`'"][^`'"]*\b(?:SELECT|INSERT|UPDATE|DELETE|DROP)\b[^`'"]*(?:\$\{|"\s*\+|'\s*\+|%s|\+\s*\w)/i,
    owasp: 'A03:2021 Injection',
    cwe: 'CWE-89',
    remediation: 'Use parameterised queries or a query builder that binds values separately.',
  },
  {
    id: 'command-injection',
    category: 'injection',
    severity: 'critical',
    title: 'Shell command built from a variable',
    detail: 'Interpolating into a shell command allows arbitrary command execution.',
    pattern: /\b(?:exec|execSync|spawnSync|system|popen|os\.system|subprocess\.(?:call|run|Popen))\s*\(\s*[`'"][^`'"]*(?:\$\{|"\s*\+|'\s*\+|%s|\+\s*\w)/,
    owasp: 'A03:2021 Injection',
    cwe: 'CWE-78',
    remediation: 'Pass arguments as an array to execFile/spawn and never invoke a shell.',
  },
  {
    id: 'eval-dynamic',
    category: 'injection',
    severity: 'high',
    title: 'Dynamic code evaluation',
    detail: '`eval` (or an equivalent) is called with a value that is not a literal.',
    pattern: /\b(?:eval|Function)\s*\(\s*(?!['"`]\s*['"`])[^)'"`]*(?:\$\{|\+|\w+\s*\))/,
    languages: [...JS, ...PY],
    owasp: 'A03:2021 Injection',
    cwe: 'CWE-95',
    unless: /\/\/\s*forgeos-ignore/,
    remediation: 'Replace with an explicit parser or a lookup table of permitted operations.',
  },
  {
    id: 'python-exec',
    category: 'injection',
    severity: 'high',
    title: 'Python exec/eval on a non-literal',
    detail: 'Executing constructed source allows arbitrary code execution.',
    pattern: /\b(?:exec|eval)\s*\(\s*(?:f['"]|[a-z_]\w*\s*[+%])/,
    languages: PY,
    cwe: 'CWE-95',
    remediation: 'Use ast.literal_eval for data, or dispatch through an explicit mapping.',
  },

  // --- Deserialization ---
  {
    id: 'pickle-loads',
    category: 'deserialization',
    severity: 'critical',
    title: 'Unsafe deserialization with pickle',
    detail: 'pickle executes arbitrary code contained in the serialised payload.',
    pattern: /\bpickle\.loads?\s*\(/,
    languages: PY,
    owasp: 'A08:2021 Software and Data Integrity Failures',
    cwe: 'CWE-502',
    remediation: 'Use JSON, or a schema-validated format, for untrusted data.',
  },
  {
    id: 'yaml-unsafe-load',
    category: 'deserialization',
    severity: 'high',
    title: 'Unsafe YAML load',
    detail: 'yaml.load without a safe loader can instantiate arbitrary Python objects.',
    pattern: /\byaml\.load\s*\((?![^)]*Safe)/,
    languages: PY,
    cwe: 'CWE-502',
    remediation: 'Use yaml.safe_load.',
  },

  // --- Crypto ---
  {
    id: 'weak-hash-for-secrets',
    category: 'crypto',
    severity: 'high',
    title: 'Weak hash used for a credential',
    detail: 'MD5 and SHA-1 are unsuitable for passwords and for integrity guarantees.',
    pattern: /(?:createHash\s*\(\s*['"](?:md5|sha1)['"]|hashlib\.(?:md5|sha1)\s*\()[\s\S]{0,80}(?:password|passwd|secret|token)/i,
    owasp: 'A02:2021 Cryptographic Failures',
    cwe: 'CWE-327',
    remediation: 'Use a memory-hard password hash such as argon2id, scrypt or bcrypt.',
  },
  {
    id: 'insecure-random-token',
    category: 'crypto',
    severity: 'high',
    title: 'Predictable randomness used for a secret',
    detail: 'Math.random and random.random are not cryptographically secure.',
    pattern: /(?:Math\.random\s*\(\)|random\.random\s*\(\))[\s\S]{0,60}(?:token|secret|password|nonce|salt|session|otp)/i,
    owasp: 'A02:2021 Cryptographic Failures',
    cwe: 'CWE-338',
    remediation: 'Use crypto.randomUUID, crypto.getRandomValues or secrets.token_urlsafe.',
  },

  // --- Transport ---
  {
    id: 'tls-verification-disabled',
    category: 'transport',
    severity: 'critical',
    title: 'TLS certificate verification disabled',
    detail: 'Disabling verification removes all protection against interception.',
    pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true/,
    owasp: 'A02:2021 Cryptographic Failures',
    cwe: 'CWE-295',
    remediation: 'Trust the correct CA instead of disabling verification.',
  },
  {
    id: 'http-url',
    category: 'transport',
    severity: 'low',
    title: 'Plaintext HTTP endpoint',
    detail: 'Traffic to this endpoint is unencrypted.',
    pattern: /['"]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|example\.|schemas?\.|www\.w3\.org|xmlns)/,
    cwe: 'CWE-319',
    remediation: 'Use HTTPS.',
  },

  // --- Access control / configuration ---
  {
    id: 'cors-wildcard-credentials',
    category: 'access-control',
    severity: 'high',
    title: 'Wildcard CORS origin with credentials',
    detail: 'Allowing any origin together with credentials exposes authenticated endpoints.',
    pattern: /origin\s*:\s*['"]\*['"][\s\S]{0,120}credentials\s*:\s*true|credentials\s*:\s*true[\s\S]{0,120}origin\s*:\s*['"]\*['"]/,
    owasp: 'A01:2021 Broken Access Control',
    cwe: 'CWE-942',
    remediation: 'Enumerate permitted origins explicitly.',
  },
  {
    id: 'debug-enabled',
    category: 'configuration',
    severity: 'moderate',
    title: 'Debug mode enabled',
    detail: 'Debug mode leaks stack traces and configuration to clients.',
    pattern: /\bDEBUG\s*=\s*True\b|app\.run\([^)]*debug\s*=\s*True/,
    languages: PY,
    owasp: 'A05:2021 Security Misconfiguration',
    cwe: 'CWE-489',
    remediation: 'Drive debug from an environment variable that defaults to off.',
  },
  {
    id: 'insecure-cookie',
    category: 'authn',
    severity: 'moderate',
    title: 'Cookie without security attributes',
    detail: 'A session cookie set without httpOnly and secure is exposed to scripts and to interception.',
    pattern: /(?:cookies?\.set|setCookie|set_cookie)\s*\([^)]*(?:session|token|auth)[^)]*\)/i,
    unless: /httpOnly|http_only|secure\s*[:=]\s*(?:true|True)/,
    owasp: 'A07:2021 Identification and Authentication Failures',
    cwe: 'CWE-1004',
    remediation: 'Set httpOnly, secure and an explicit sameSite policy.',
  },
  {
    id: 'jwt-none-algorithm',
    category: 'authn',
    severity: 'critical',
    title: 'JWT verification permits the `none` algorithm',
    detail: 'Accepting `none` lets an attacker forge tokens with no signature.',
    pattern: /algorithms?\s*:\s*\[[^\]]*['"]none['"]|verify\([^)]*algorithms\s*=\s*\[[^\]]*['"]none['"]/i,
    cwe: 'CWE-347',
    remediation: 'Pin the expected algorithm explicitly.',
  },

  // --- XSS ---
  {
    id: 'dangerously-set-inner-html',
    category: 'xss',
    severity: 'moderate',
    title: 'Raw HTML injected into the DOM',
    detail: 'dangerouslySetInnerHTML bypasses React escaping.',
    pattern: /dangerouslySetInnerHTML\s*=\s*\{\{/,
    languages: JS,
    unless: /sanitize|purify|DOMPurify/i,
    owasp: 'A03:2021 Injection',
    cwe: 'CWE-79',
    remediation: 'Sanitise with DOMPurify, or render the content as text.',
  },
  {
    id: 'inner-html-assignment',
    category: 'xss',
    severity: 'moderate',
    title: 'innerHTML assigned a dynamic value',
    detail: 'Assigning untrusted content to innerHTML executes embedded scripts.',
    pattern: /\.innerHTML\s*=\s*(?!['"`]\s*['"`])[^;]*(?:\$\{|\+|\w\))/,
    languages: JS,
    unless: /sanitize|purify|DOMPurify/i,
    cwe: 'CWE-79',
    remediation: 'Use textContent, or sanitise before assignment.',
  },

  // --- Path traversal ---
  {
    id: 'path-traversal',
    category: 'access-control',
    severity: 'high',
    title: 'Filesystem path built from a request value',
    detail: 'A path assembled from request data can escape the intended directory.',
    pattern: /(?:readFile|readFileSync|createReadStream|sendFile|open)\s*\([^)]*(?:req\.(?:query|params|body)|request\.(?:args|form|json))/,
    owasp: 'A01:2021 Broken Access Control',
    cwe: 'CWE-22',
    remediation: 'Resolve the path and assert it still lives under the intended root.',
  },

  // --- AI-specific ---
  {
    id: 'prompt-injection-surface',
    category: 'ai',
    severity: 'high',
    title: 'Untrusted input interpolated directly into a prompt',
    detail:
      'Request data is concatenated into a model prompt with no delimiter or instruction hierarchy, so a user can override the system instruction.',
    pattern: /(?:prompt|messages|system|instruction)\s*[:=][\s\S]{0,200}(?:\$\{\s*(?:req|request|input|userInput|body|query|params|message)\b|\+\s*(?:req|request|userInput|body)\b|f['"][^'"]*\{(?:user_input|request|prompt_input)\})/i,
    owasp: 'LLM01 Prompt Injection',
    cwe: 'CWE-77',
    remediation:
      'Keep untrusted text in a clearly delimited user turn, never in the system prompt, and restate the constraints the model must not violate.',
  },
  {
    id: 'llm-output-to-sink',
    category: 'ai',
    severity: 'critical',
    title: 'Model output reaches a dangerous sink',
    detail:
      'The value returned by a model is passed to code execution, a shell or raw HTML — turning prompt injection into remote code execution.',
    pattern: /(?:completion|response|message|choices\[0\]|result)[\w.[\]]*\s*(?:\)|,)?\s*(?:=>)?\s*(?:eval|exec|execSync|spawn|innerHTML|dangerouslySetInnerHTML)/,
    owasp: 'LLM02 Insecure Output Handling',
    cwe: 'CWE-94',
    remediation:
      'Treat model output as untrusted input: validate it against a schema and never execute or render it raw.',
  },
  {
    id: 'unbounded-tool-execution',
    category: 'ai',
    severity: 'high',
    title: 'Agent tool dispatch without an allowlist',
    detail: 'A tool name chosen by the model is used to index a handler map with no validation.',
    pattern: /tools?\s*\[\s*(?:toolCall|tool_call|call)\.?(?:name|function\.name)\s*\]\s*\(/,
    owasp: 'LLM08 Excessive Agency',
    cwe: 'CWE-285',
    remediation: 'Validate the tool name against an explicit allowlist before dispatching.',
  },
  {
    id: 'model-key-client-side',
    category: 'ai',
    severity: 'critical',
    title: 'Model API key exposed to the browser',
    detail: 'A public environment variable holding a model key ships to every visitor.',
    pattern: /(?:NEXT_PUBLIC|VITE|REACT_APP|PUBLIC)_[A-Z_]*(?:OPENAI|ANTHROPIC|OPENROUTER|GEMINI|API_KEY|SECRET)/,
    cwe: 'CWE-200',
    remediation: 'Proxy model calls through a server route and keep the key server-side.',
  },
];

const SKIP_PATH =
  /(\.|\/)(test|spec)\.[\w]+$|(^|\/)(tests?|__tests__|__mocks__|e2e|cypress)(\/|$)|\.min\.(js|css)$|\.map$/i;

export interface PatternScanOptions {
  readonly includeTests?: boolean;
  /** Restrict to these categories. */
  readonly categories?: readonly SecurityCategory[];
}

export function scanCodePatterns(
  snapshot: RepoSnapshot,
  options: PatternScanOptions = {}
): CodeSecurityFinding[] {
  const categories = options.categories ? new Set(options.categories) : null;
  const findings: CodeSecurityFinding[] = [];
  const seen = new Set<string>();

  for (const file of snapshot.files) {
    if (file.text === null) continue;
    if (!options.includeTests && SKIP_PATH.test(file.path)) continue;

    const language = detectLanguage(file.path);
    if (!language) continue;

    // Comments are stripped so a documented example does not become a finding.
    const source = stripComments(file.text, language);
    const lines = source.split('\n');

    for (const rule of SECURITY_PATTERNS) {
      if (categories && !categories.has(rule.category)) continue;
      if (rule.languages && !rule.languages.includes(language.id)) continue;

      // Rules match within a small window so multi-line constructs are caught
      // without letting a match span an entire file.
      for (let index = 0; index < lines.length; index++) {
        const window = lines.slice(index, index + 4).join('\n');
        if (!rule.pattern.test(window)) continue;
        if (rule.unless?.test(window)) continue;

        const line = index + 1;
        const id = `cs_${fnv1a32(`${file.path}:${line}:${rule.id}`).toString(36)}`;
        if (seen.has(id)) continue;
        seen.add(id);

        findings.push({
          id,
          rule: rule.id,
          category: rule.category,
          severity: rule.severity,
          title: rule.title,
          detail: rule.detail,
          file: file.path,
          line,
          snippet: (lines[index] ?? '').trim().slice(0, 200),
          ...(rule.owasp ? { owasp: rule.owasp } : {}),
          ...(rule.cwe ? { cwe: rule.cwe } : {}),
          remediation: rule.remediation,
        });
        // One finding per rule per file keeps reports actionable.
        break;
      }
    }
  }

  const order = { critical: 0, high: 1, moderate: 2, low: 3 } as const;
  return findings.sort(
    (a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line
  );
}
