import { describe, expect, it } from 'vitest';
import { snapshotFromEntries } from '../fs/scan.js';
import { auditEnvironmentFiles, scanSecrets } from './secrets.js';
import { scanCodePatterns } from './patterns.js';
import { BUNDLED_ADVISORIES, matchVulnerabilities, mergeAdvisorySets } from './advisories.js';
import { scanRepository } from './report.js';
import type { Dependency } from '../analysis/manifests.js';

/**
 * Fixture credentials are assembled at runtime rather than written as literals.
 *
 * A repository that contains a credential-shaped string is indistinguishable
 * from one that leaked a credential — to a scanner, to push protection, and to
 * a reader. Joining the parts here exercises exactly the same detection path
 * while leaving nothing in the source that looks like a live key.
 */
const fixtureSecret = (prefix: string, body: string): string => [prefix, body].join('_');

const npm = (name: string, range: string): Dependency => ({
  name,
  range,
  ecosystem: 'npm',
  scope: 'runtime',
  manifest: 'package.json',
});

describe('secret detection', () => {
  it('finds a provider-shaped credential and never returns it in full', () => {
    const snapshot = snapshotFromEntries({
      'src/config.ts': `const token = "${fixtureSecret('ghp', 'abcdefghijklmnopqrstuvwxyz0123456789')}";`,
    });

    const findings = scanSecrets(snapshot);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('github-token');
    expect(findings[0]?.confidence).toBe('high');
    expect(findings[0]?.preview).not.toContain('mnopqrstuvwxyz');
    expect(findings[0]?.preview).toContain('•');
  });

  it('reports the line the credential is on', () => {
    const snapshot = snapshotFromEntries({
      'src/config.ts': [
        'const a = 1;',
        'const b = 2;',
        `const k = "${['AKIA', 'IOSFODNN7EXAMPLE'].join('')}";`,
      ].join('\n'),
    });
    expect(scanSecrets(snapshot)[0]?.line).toBe(3);
  });

  it('ignores placeholders and example files', () => {
    const snapshot = snapshotFromEntries({
      'src/config.ts': [
        `const a = "your-api-key-here";`,
        `const b = "xxxxxxxxxxxxxxxxxxxxxxxx";`,
        `const c = "change_me";`,
        `const d = process.env.REAL_SECRET;`,
      ].join('\n'),
      '.env.example': `STRIPE_KEY=${fixtureSecret('sk_live', 'abcdefghijklmnopqrstuvwx')}`,
    });
    expect(scanSecrets(snapshot)).toHaveLength(0);
  });

  it('detects a database URL that embeds a password', () => {
    const snapshot = snapshotFromEntries({
      'src/db.ts': `const url = "postgres://admin:s3cretPassw0rd@db.internal:5432/app";`,
    });
    const findings = scanSecrets(snapshot);
    expect(findings.map((finding) => finding.rule)).toContain('database-url');
  });

  it('notices a committed .env that is not ignored', () => {
    const audit = auditEnvironmentFiles(
      snapshotFromEntries({ '.env': 'SECRET=1', '.gitignore': 'node_modules\n' })
    );
    expect(audit.committedEnvFiles).toEqual(['.env']);
    expect(audit.gitignoresEnv).toBe(false);
  });
});

describe('insecure code patterns', () => {
  it('flags string-interpolated SQL', () => {
    const findings = scanCodePatterns(
      snapshotFromEntries({
        'src/db.ts': 'const r = await pool.query(`SELECT * FROM users WHERE id = ${id}`);',
      })
    );
    expect(findings.map((finding) => finding.rule)).toContain('sql-string-interpolation');
    expect(findings[0]?.severity).toBe('critical');
  });

  it('flags disabled TLS verification', () => {
    const findings = scanCodePatterns(
      snapshotFromEntries({ 'src/http.ts': 'const agent = { rejectUnauthorized: false };' })
    );
    expect(findings.map((finding) => finding.rule)).toContain('tls-verification-disabled');
  });

  it('flags a model key exposed to the browser', () => {
    const findings = scanCodePatterns(
      snapshotFromEntries({
        'src/client.ts': 'const key = process.env.NEXT_PUBLIC_OPENAI_API_KEY;',
      })
    );
    const finding = findings.find((entry) => entry.rule === 'model-key-client-side');
    expect(finding?.category).toBe('ai');
    expect(finding?.severity).toBe('critical');
  });

  it('flags untrusted input interpolated into a prompt', () => {
    const findings = scanCodePatterns(
      snapshotFromEntries({
        'src/ai.ts': 'const prompt = `You are helpful. ${req.body.message}`;',
      })
    );
    expect(findings.map((finding) => finding.rule)).toContain('prompt-injection-surface');
  });

  it('does not flag sanitised HTML injection', () => {
    const findings = scanCodePatterns(
      snapshotFromEntries({
        'src/view.tsx': 'const el = <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(x) }} />;',
      })
    );
    expect(findings.map((finding) => finding.rule)).not.toContain('dangerously-set-inner-html');
  });

  it('skips test files by default', () => {
    const source = { 'src/db.test.ts': 'pool.query(`SELECT * FROM t WHERE id = ${id}`);' };
    expect(scanCodePatterns(snapshotFromEntries(source))).toHaveLength(0);
    expect(scanCodePatterns(snapshotFromEntries(source), { includeTests: true }).length).toBeGreaterThan(0);
  });
});

describe('dependency advisories', () => {
  it('matches a pinned vulnerable version', () => {
    const matches = matchVulnerabilities([npm('lodash', '4.17.20')], BUNDLED_ADVISORIES);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.matchKind).toBe('exact');
    expect(matches[0]?.advisory.patchedVersion).toBe('4.17.21');
  });

  it('does not match a patched version', () => {
    expect(matchVulnerabilities([npm('lodash', '4.17.21')], BUNDLED_ADVISORIES)).toHaveLength(0);
  });

  it('treats a caret range as a weaker range match', () => {
    const matches = matchVulnerabilities([npm('minimist', '^1.2.0')], BUNDLED_ADVISORIES);
    expect(matches[0]?.matchKind).toBe('range');
  });

  it('honours disjoint ranges in an advisory', () => {
    // The Next.js advisory covers >=11.1.4 <14.2.25 || >=15.0.0 <15.2.3
    expect(matchVulnerabilities([npm('next', '14.1.0')], BUNDLED_ADVISORIES)).toHaveLength(1);
    expect(matchVulnerabilities([npm('next', '14.2.25')], BUNDLED_ADVISORIES)).toHaveLength(0);
    expect(matchVulnerabilities([npm('next', '15.0.1')], BUNDLED_ADVISORIES)).toHaveLength(1);
    expect(matchVulnerabilities([npm('next', '16.0.0')], BUNDLED_ADVISORIES)).toHaveLength(0);
  });

  it('merges advisory sets without duplicating by alias', () => {
    const extra = [{ ...(BUNDLED_ADVISORIES[0] as (typeof BUNDLED_ADVISORIES)[number]), id: 'OTHER' }];
    const merged = mergeAdvisorySets(extra, BUNDLED_ADVISORIES);
    expect(merged.length).toBe(BUNDLED_ADVISORIES.length);
  });
});

describe('the consolidated report', () => {
  it('scores a clean repository highly and names its sources', async () => {
    const report = await scanRepository(
      snapshotFromEntries({ 'src/index.ts': 'export const a = 1;' }),
      [npm('lodash', '4.17.21')]
    );
    expect(report.posture.score).toBeGreaterThan(90);
    expect(report.posture.grade).toBe('A');
    expect(report.advisorySources).toContain('forgeos-bundled');
    expect(report.remediation).toHaveLength(0);
  });

  it('scores a compromised repository poorly and orders remediation', async () => {
    const report = await scanRepository(
      snapshotFromEntries({
        'src/config.ts': `const token = "${fixtureSecret('ghp', 'abcdefghijklmnopqrstuvwxyz0123456789')}";`,
        'src/db.ts': 'pool.query(`SELECT * FROM users WHERE id = ${id}`);',
        '.env': 'SECRET=live',
      }),
      [npm('lodash', '4.17.20')]
    );

    expect(report.posture.score).toBeLessThan(40);
    expect(report.counts.critical).toBeGreaterThan(0);
    expect(report.remediation[0]?.priority).toBe(1);
    expect(report.remediation[0]?.title).toMatch(/rotate|remove/i);
  });

  it('reports unassessable controls as not-assessed rather than passing', async () => {
    const report = await scanRepository(snapshotFromEntries({ 'a.ts': 'export const a = 1;' }), []);
    const design = report.compliance.find((control) => control.id === 'A04');
    expect(design?.status).toBe('not-assessed');
  });

  it('survives an advisory source that throws', async () => {
    const report = await scanRepository(snapshotFromEntries({ 'a.ts': 'export const a = 1;' }), [], {
      sources: [
        {
          name: 'broken',
          lookup: async () => {
            throw new Error('network down');
          },
        },
      ],
    });
    expect(report.advisorySources).toEqual(['forgeos-bundled']);
  });
});
