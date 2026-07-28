import { Badge, Card, CardContent } from '@forgeos/ui';
import {
  bumpVersion,
  generateChangelog,
  generateReleaseNotes,
  inferReleaseKind,
  lintCommits,
  parseCommit,
  parseUnifiedDiff,
  renderReviewMarkdown,
  reviewPullRequest,
  type RawCommit,
} from '@forgeos/core';
import { PageHeader, Section, Mono, SeverityBadge } from '@/components/primitives';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Automation' };

/**
 * A worked example, computed live.
 *
 * The diff and commits below are fixtures, but every number, comment and
 * document on this page is produced by running the real engines over them at
 * request time — nothing is hard-coded. That is the point: the page is a
 * demonstration you can verify, not a screenshot.
 */
/**
 * Assembled at runtime rather than written as a literal: a repository that
 * contains a credential-shaped string is indistinguishable from one that leaked
 * a credential. The detector sees the identical text either way.
 */
const FIXTURE_KEY = ['sk', 'live', 'EXAMPLEqLyjWDarjtT1zdp7dc'].join('_');

const SAMPLE_DIFF = `diff --git a/src/api/payments.ts b/src/api/payments.ts
new file mode 100644
--- /dev/null
+++ b/src/api/payments.ts
@@ -0,0 +1,26 @@
+import type { Express } from 'express';
+import { pool } from '../db/pool';
+
+const STRIPE_KEY = '${FIXTURE_KEY}';
+
+export function registerPaymentRoutes(app: Express): void {
+  app.post('/payments', async (req, res) => {
+    const customerId = req.body.customerId;
+    const result = await pool.query(
+      \`SELECT * FROM customers WHERE id = '\${customerId}'\`
+    );
+    console.log('charging', result.rows[0]);
+
+    if (!result.rows[0]) {
+      return res.status(404).json({ error: 'no_customer' });
+    }
+    if (req.body.amount > 0) {
+      if (req.body.currency === 'usd') {
+        if (req.body.method === 'card') {
+          // TODO: handle 3D Secure
+          return res.json({ ok: true });
+        }
+      }
+    }
+    res.status(400).json({ error: 'unsupported' });
+  });
+}
`;

const SAMPLE_COMMITS: RawCommit[] = [
  {
    sha: 'a1c9f2e4b7d8390af12b3c4d5e6f7a8b9c0d1e2f',
    subject: 'feat(payments): add payment capture endpoint',
    body: 'Closes #412',
    author: 'dana',
    authoredAt: Date.now() - 86_400_000,
  },
  {
    sha: 'b2d8e3f5c6a7291bf23c4d5e6f7a8b9c0d1e2f3a',
    subject: 'fix(orders): stop cancelling shipped orders',
    body: '',
    author: 'sam',
    authoredAt: Date.now() - 172_800_000,
  },
  {
    sha: 'c3e7f4a6b5c8302cf34d5e6f7a8b9c0d1e2f3a4b',
    subject: 'refactor!: move pricing into the domain layer',
    body: 'BREAKING CHANGE: calculateTotal now takes an OrderDraft rather than an item array.',
    author: 'dana',
    authoredAt: Date.now() - 259_200_000,
  },
  {
    sha: 'd4f6a5b7c6d9413df45e6f7a8b9c0d1e2f3a4b5c',
    subject: 'updated some stuff',
    body: '',
    author: 'alex',
    authoredAt: Date.now() - 345_600_000,
  },
];

export default async function AutomationPage() {
  const files = parseUnifiedDiff(SAMPLE_DIFF);
  const review = reviewPullRequest({
    title: 'Add payment capture endpoint',
    description: 'Adds POST /payments.',
    files: files.map((file) => ({
      ...file,
      content: SAMPLE_DIFF.split('\n')
        .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
        .map((line) => line.slice(1))
        .join('\n'),
    })),
    commits: SAMPLE_COMMITS.slice(0, 1),
  });

  const parsed = SAMPLE_COMMITS.map(parseCommit);
  const kind = inferReleaseKind(parsed);
  const nextVersion = bumpVersion('2.4.1', kind);
  const changelog = generateChangelog(parsed, {
    version: nextVersion,
    previousVersion: 'v2.4.1',
    repositoryUrl: 'https://github.com/example/orders-service',
  });
  const notes = generateReleaseNotes(parsed, {
    version: nextVersion,
    projectName: 'orders-service',
  });
  const commitIssues = lintCommits(parsed);

  return (
    <>
      <PageHeader
        title="Automation"
        description="Pull-request review, changelogs and release notes — computed from diffs and commit metadata, so they work against any Git host, offline, with no token."
      />

      <Section
        title="Pull-request review"
        description="Findings are limited to the lines a change actually touched. Reporting pre-existing problems in files the author merely opened is noise, and teams learn to ignore it."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardContent className="pt-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={
                    review.verdict === 'request-changes'
                      ? 'danger'
                      : review.verdict === 'comment'
                        ? 'warning'
                        : 'success'
                  }
                >
                  {review.verdict.replace('-', ' ')}
                </Badge>
                <span className="text-[13px]">{review.summary}</span>
              </div>

              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--forge-text-muted)]">
                <span>{review.stats.files} files</span>
                <span className="text-[var(--forge-success)]">+{review.stats.additions}</span>
                <span className="text-[var(--forge-danger)]">−{review.stats.deletions}</span>
                <span>risk {review.stats.riskScore}</span>
              </div>

              <ul className="mt-4 space-y-1.5">
                {review.checklist.map((item) => (
                  <li key={item.label} className="flex items-center gap-2 text-[13px]">
                    <span
                      className={
                        item.passed ? 'text-[var(--forge-success)]' : 'text-[var(--forge-danger)]'
                      }
                    >
                      {item.passed ? '✓' : '✕'}
                    </span>
                    <span className={item.passed ? '' : 'text-[var(--forge-text)]'}>
                      {item.label}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5">
              <h3 className="mb-3 text-[13px] font-semibold">
                {review.comments.length} findings
              </h3>
              <div className="space-y-3">
                {review.comments.map((comment) => (
                  <div
                    key={comment.id}
                    className="rounded-[var(--forge-radius)] border border-[var(--forge-border)] p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={comment.severity} />
                      <span className="text-[13px] font-medium">{comment.title}</span>
                    </div>
                    {comment.file ? (
                      <div className="mt-1">
                        <Mono>
                          {comment.file}
                          {comment.line ? `:${comment.line}` : ''}
                        </Mono>
                      </div>
                    ) : null}
                    <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--forge-text-muted)]">
                      {comment.body}
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <details className="mt-4">
          <summary className="cursor-pointer text-[12px] text-[var(--forge-accent-text)]">
            Show the review as it would be posted to the pull request
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-[var(--forge-radius)] border border-[var(--forge-border)] bg-[var(--forge-bg-subtle)] p-4 text-[11px]">
            <code>{renderReviewMarkdown(review)}</code>
          </pre>
        </details>
      </Section>

      <Section
        title="Release engineering"
        description={`${parsed.length} commits imply a ${kind} release: 2.4.1 → ${nextVersion}.`}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardContent className="pt-5">
              <h3 className="mb-3 text-[13px] font-semibold">Changelog</h3>
              <pre className="overflow-x-auto rounded-[var(--forge-radius)] border border-[var(--forge-border)] bg-[var(--forge-bg-subtle)] p-3 text-[11px]">
                <code>{changelog}</code>
              </pre>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <h3 className="mb-3 text-[13px] font-semibold">Release notes</h3>
              <pre className="overflow-x-auto rounded-[var(--forge-radius)] border border-[var(--forge-border)] bg-[var(--forge-bg-subtle)] p-3 text-[11px]">
                <code>{notes}</code>
              </pre>
            </CardContent>
          </Card>
        </div>

        {commitIssues.length > 0 ? (
          <Card className="mt-4">
            <CardContent className="pt-5">
              <h3 className="mb-3 text-[13px] font-semibold">Commit message review</h3>
              <ul className="space-y-1.5">
                {commitIssues.map((issue, index) => (
                  <li key={index} className="flex items-start gap-2 text-[12px]">
                    <Badge tone={issue.severity === 'error' ? 'danger' : 'warning'}>
                      {issue.severity}
                    </Badge>
                    <span className="text-[var(--forge-text-muted)]">
                      <Mono>{issue.sha.slice(0, 7)}</Mono> {issue.message}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </Section>
    </>
  );
}
