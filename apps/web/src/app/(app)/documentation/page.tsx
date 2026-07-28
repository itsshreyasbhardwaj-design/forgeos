import Link from 'next/link';
import { Badge, Card, CardContent, EmptyState, ProgressBar } from '@forgeos/ui';
import { BookText, AlertCircle } from 'lucide-react';
import { assessDocumentation } from '@forgeos/core';
import { getActiveWorkspace, getContext } from '@/lib/server/context';
import { requireAnalysis } from '@/lib/server/projects';
import { PageHeader, Section } from '@/components/primitives';
import { GenerateDocsButton } from '@/components/actions';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export const metadata = { title: 'Documentation' };

export default async function DocumentationPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; doc?: string }>;
}) {
  const { project: requested, doc } = await searchParams;
  const workspace = await getActiveWorkspace();
  const { store } = await getContext();

  const projects = await store.listProjects(workspace.id, { limit: 100 });
  const selected = projects.find((entry) => entry.id === requested) ?? projects[0];
  const documents = await store.listDocuments(workspace.id, { limit: 200 });

  const scoped = selected
    ? documents.filter((document) => document.projectId === selected.id)
    : documents;
  const open = doc ? documents.find((document) => document.id === doc) : scoped[0];

  const coverage = selected ? assessDocumentation(await requireAnalysis(workspace.id, selected.id)) : null;

  return (
    <>
      <PageHeader
        title="Documentation"
        description="Generated from real analysis. Where ForgeOS cannot determine something it says so, rather than inventing a plausible sentence."
        meta={
          projects.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {projects.map((entry) => (
                <Link key={entry.id} href={`/documentation?project=${entry.id}`}>
                  <Badge tone={entry.id === selected?.id ? 'accent' : 'neutral'}>{entry.name}</Badge>
                </Link>
              ))}
            </div>
          ) : null
        }
        actions={selected ? <GenerateDocsButton projectId={selected.id} /> : null}
      />

      {coverage ? (
        <Section title="Existing coverage" description="What the repository already documents, before generation.">
          <Card>
            <CardContent className="pt-5">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-[13px] font-medium">{coverage.score}% covered</span>
                <span className="text-[12px] text-[var(--forge-text-muted)]">
                  {coverage.present.length} of {coverage.present.length + coverage.missing.length}{' '}
                  checks
                </span>
              </div>
              <ProgressBar value={coverage.score} tone={coverage.score >= 70 ? 'success' : 'warning'} label="Documentation coverage" />
              <div className="mt-4 flex flex-wrap gap-1.5">
                {coverage.present.map((item) => (
                  <Badge key={item} tone="success">
                    {item}
                  </Badge>
                ))}
                {coverage.missing.map((item) => (
                  <Badge key={item} tone="warning">
                    missing: {item}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        </Section>
      ) : null}

      {scoped.length === 0 ? (
        <Section>
          <Card>
            <EmptyState
              icon={<BookText className="h-5 w-5" />}
              title="No documents generated yet"
              description={
                projects.length === 0
                  ? 'Add a repository first — documentation is derived from its analysis.'
                  : 'Generate a README, architecture overview, API reference, setup guide and deployment guide in one pass.'
              }
              action={
                projects.length === 0 ? (
                  <Link
                    href="/repositories"
                    className="rounded-[var(--forge-radius)] bg-[var(--forge-accent)] px-4 py-2 text-[13px] font-medium text-white"
                  >
                    Add a repository
                  </Link>
                ) : null
              }
            />
          </Card>
        </Section>
      ) : (
        <div className="grid gap-6 px-6 pb-10 lg:grid-cols-[260px_1fr]">
          <nav aria-label="Documents">
            <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--forge-text-subtle)]">
              Documents
            </h2>
            <ul className="space-y-1">
              {scoped.map((document) => (
                <li key={document.id}>
                  <Link
                    href={`/documentation?project=${document.projectId ?? ''}&doc=${document.id}`}
                    className={`block rounded-[var(--forge-radius)] border px-3 py-2 transition-colors ${
                      open?.id === document.id
                        ? 'border-[var(--forge-accent-border)] bg-[var(--forge-accent-subtle)]'
                        : 'border-transparent hover:bg-[var(--forge-bg-subtle)]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13px] font-medium capitalize">
                        {document.kind}
                      </span>
                      <span className="text-[10px] text-[var(--forge-text-subtle)]">
                        v{document.version}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--forge-text-subtle)]">
                      <span>{document.markdown.split(/\s+/).filter(Boolean).length} words</span>
                      {(document.gaps?.length ?? 0) > 0 ? (
                        <span className="flex items-center gap-1 text-[var(--forge-warning)]">
                          <AlertCircle className="h-3 w-3" />
                          {document.gaps?.length}
                        </span>
                      ) : null}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="min-w-0">
            {open ? (
              <Card>
                <CardContent className="pt-6">
                  {(open.gaps?.length ?? 0) > 0 ? (
                    <div className="mb-5 rounded-[var(--forge-radius)] border border-[var(--forge-warning)] bg-[var(--forge-warning-subtle)] p-4">
                      <h3 className="flex items-center gap-2 text-[13px] font-semibold">
                        <AlertCircle className="h-4 w-4" />
                        {open.gaps?.length} thing{open.gaps?.length === 1 ? '' : 's'} a human still
                        needs to write
                      </h3>
                      <ul className="mt-2 space-y-1">
                        {open.gaps?.map((gap) => (
                          <li key={gap} className="text-[12px] leading-relaxed">
                            • {gap}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <article className="forge-prose">
                    <MarkdownView markdown={open.markdown} />
                  </article>
                </CardContent>
              </Card>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * A deliberately small Markdown renderer.
 *
 * The generated documents use a known, restricted subset of Markdown — this
 * project generates them — so a full parser plus a sanitiser is a large
 * dependency to solve a problem that does not exist here. Text is escaped
 * before any markup is introduced, so untrusted content cannot inject HTML.
 */
function MarkdownView({ markdown }: { markdown: string }) {
  const escape = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const inline = (value: string): string =>
    escape(value)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text: string, href: string) =>
        /^(https?:|\/|#)/.test(href) ? `<a href="${href}">${text}</a>` : text
      );

  const lines = markdown.split('\n');
  const html: string[] = [];
  let inCode = false;
  let inTable = false;
  let listType: 'ul' | 'ol' | null = null;

  const closeList = (): void => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };
  const closeTable = (): void => {
    if (inTable) {
      html.push('</tbody></table>');
      inTable = false;
    }
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      closeList();
      closeTable();
      html.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html.push(`${escape(line)}\n`);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      closeTable();
      const level = heading[1]?.length ?? 1;
      html.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      continue;
    }

    if (/^\s*\|/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      if (cells.every((cell) => /^-{2,}$/.test(cell.replace(/:/g, '')))) continue;
      if (!inTable) {
        closeList();
        html.push('<table><tbody>');
        inTable = true;
      }
      html.push(`<tr>${cells.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`);
      continue;
    }
    closeTable();

    const unordered = /^\s*[-*]\s+(.*)$/.exec(line);
    if (unordered) {
      if (listType !== 'ul') {
        closeList();
        html.push('<ul>');
        listType = 'ul';
      }
      html.push(`<li>${inline(unordered[1] ?? '')}</li>`);
      continue;
    }

    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ordered) {
      if (listType !== 'ol') {
        closeList();
        html.push('<ol>');
        listType = 'ol';
      }
      html.push(`<li>${inline(ordered[1] ?? '')}</li>`);
      continue;
    }
    closeList();

    if (/^\s*>\s?/.test(line)) {
      html.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      html.push('<hr />');
      continue;
    }
    if (line.trim() === '') continue;

    html.push(`<p>${inline(line)}</p>`);
  }

  closeList();
  closeTable();
  if (inCode) html.push('</code></pre>');

  return <div dangerouslySetInnerHTML={{ __html: html.join('\n') }} />;
}
