'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fuzzyScore } from '@forgeos/core';
import { Kbd } from '@forgeos/ui';
import { ArrowRight, CornerDownLeft, Loader2, Search } from 'lucide-react';
import { MODULES } from '@/lib/modules';

/**
 * The command palette.
 *
 * Two sources merged into one ranked list: static commands (navigation and
 * actions, matched with a fuzzy scorer client-side so they respond instantly)
 * and workspace search results (debounced, fetched from the server). Local
 * commands never wait on the network, which is what makes the palette feel
 * instant even on a slow connection.
 */
interface PaletteItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly group: string;
  readonly href: string;
  readonly score: number;
}

interface SearchResponse {
  results: { id: string; kind: string; title: string; href: string; excerpt: string; score: number }[];
}

const STATIC_COMMANDS: readonly { id: string; title: string; subtitle: string; href: string; group: string }[] = [
  ...MODULES.map((module) => ({
    id: `nav:${module.id}`,
    title: module.name,
    subtitle: module.summary,
    href: module.href,
    group: 'Navigate',
  })),
  { id: 'act:add-repo', title: 'Add a repository', subtitle: 'Analyse a codebase', href: '/repositories?new=1', group: 'Actions' },
  { id: 'act:generate-docs', title: 'Generate documentation', subtitle: 'README, architecture, API, setup', href: '/documentation', group: 'Actions' },
  { id: 'act:scan', title: 'Run a security scan', subtitle: 'Secrets, patterns, dependencies', href: '/security', group: 'Actions' },
  { id: 'act:benchmark', title: 'Run a benchmark', subtitle: 'Compare prompts and models', href: '/evaluation', group: 'Actions' },
  { id: 'act:workflow', title: 'Build a workflow', subtitle: 'Automate across modules', href: '/workflows', group: 'Actions' },
  { id: 'act:memory', title: 'Search memory', subtitle: 'Recall past decisions', href: '/memory', group: 'Actions' },
];

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<SearchResponse['results']>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
        return;
      }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (open) {
      setActive(0);
      // Focus after the dialog paints, or the caret lands nowhere.
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery('');
      setRemote([]);
    }
  }, [open]);

  // Debounced workspace search. Aborted on every keystroke so a slow response
  // cannot overwrite results for a newer query.
  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setRemote([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=8`, {
          signal: controller.signal,
        });
        if (response.ok) {
          const payload = (await response.json()) as SearchResponse;
          setRemote(payload.results ?? []);
        }
      } catch {
        // Aborted or offline: local commands still work.
      } finally {
        setLoading(false);
      }
    }, 160);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  const items = useMemo<PaletteItem[]>(() => {
    const trimmed = query.trim();

    const local: PaletteItem[] = STATIC_COMMANDS.map((command) => {
      const score = trimmed === '' ? 1 : (fuzzyScore(trimmed, `${command.title} ${command.subtitle}`) ?? -1);
      return { ...command, score };
    }).filter((item) => item.score >= 0);

    const remoteItems: PaletteItem[] = remote.map((result) => ({
      id: result.id,
      title: result.title,
      subtitle: result.excerpt,
      group: result.kind,
      href: result.href,
      // Normalise BM25 scores into the same band as the fuzzy scores so one
      // list can be ranked coherently.
      score: Math.min(20, result.score),
    }));

    return [...local, ...remoteItems].sort((a, b) => b.score - a.score).slice(0, 24);
  }, [query, remote]);

  const grouped = useMemo(() => {
    const groups = new Map<string, PaletteItem[]>();
    for (const item of items) {
      const bucket = groups.get(item.group) ?? [];
      bucket.push(item);
      groups.set(item.group, bucket);
    }
    return [...groups.entries()];
  }, [items]);

  const go = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item) return;
      setOpen(false);
      router.push(item.href);
    },
    [router]
  );

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((value) => Math.min(items.length - 1, value + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((value) => Math.max(0, value - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(items[active]);
    }
  };

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group flex h-8 w-full max-w-xs items-center gap-2 rounded-[var(--forge-radius)] border border-[var(--forge-border)] bg-[var(--forge-bg-subtle)] px-2.5 text-left text-[13px] text-[var(--forge-text-subtle)] transition-colors hover:border-[var(--forge-border-strong)]"
        aria-label="Open the command palette"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="flex-1 truncate">Search or jump to…</span>
        <Kbd>⌘K</Kbd>
      </button>
    );
  }

  let flatIndex = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh] backdrop-blur-sm forge-fade"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-[var(--forge-radius-lg)] border border-[var(--forge-border)] bg-[var(--forge-surface)] shadow-[var(--forge-shadow-lg)] forge-rise">
        <div className="flex items-center gap-3 border-b border-[var(--forge-border)] px-4">
          <Search className="h-4 w-4 shrink-0 text-[var(--forge-text-subtle)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search repositories, docs, APIs, memories, findings…"
            className="h-12 flex-1 bg-transparent text-sm text-[var(--forge-text)] outline-none placeholder:text-[var(--forge-text-subtle)]"
            aria-label="Search"
            autoComplete="off"
            spellCheck={false}
          />
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--forge-text-subtle)]" /> : null}
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-2">
          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-[var(--forge-text-muted)]">
              Nothing matched “{query}”.
            </p>
          ) : (
            grouped.map(([group, groupItems]) => (
              <div key={group} className="mb-1">
                <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--forge-text-subtle)]">
                  {group}
                </div>
                {groupItems.map((item) => {
                  flatIndex++;
                  const index = flatIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-index={index}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => go(item)}
                      className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${
                        index === active ? 'bg-[var(--forge-accent-subtle)]' : ''
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-[var(--forge-text)]">
                          {item.title}
                        </div>
                        {item.subtitle ? (
                          <div className="truncate text-[12px] text-[var(--forge-text-muted)]">
                            {item.subtitle}
                          </div>
                        ) : null}
                      </div>
                      {index === active ? (
                        <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-[var(--forge-text-subtle)]" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 opacity-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-[var(--forge-border)] px-4 py-2 text-[11px] text-[var(--forge-text-subtle)]">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> open
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
