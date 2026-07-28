'use client';

import { useEffect, useId, useRef, useState } from 'react';

/**
 * Client-side Mermaid rendering.
 *
 * Mermaid is imported dynamically and only when a diagram is actually on
 * screen: it is a large dependency, and most pages never render one. The
 * fallback shows the diagram source, which is genuinely useful — Mermaid source
 * is readable, and a failed render should not lose the information.
 */
export function MermaidDiagram({ chart, className }: { chart: string; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');

  useEffect(() => {
    let cancelled = false;

    const render = async (): Promise<void> => {
      try {
        const mermaid = (await import('mermaid')).default;
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';

        mermaid.initialize({
          startOnLoad: false,
          theme: dark ? 'dark' : 'neutral',
          securityLevel: 'strict',
          fontFamily: 'var(--forge-font-sans)',
          themeVariables: {
            fontSize: '13px',
            primaryColor: dark ? '#2a2b31' : '#f4f4f6',
            lineColor: dark ? '#4a4b52' : '#c9c9cf',
          },
        });

        const { svg } = await mermaid.render(`forge-${id}`, chart);
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = svg;
        setRendered(true);
      } catch (caught) {
        if (!cancelled) setError((caught as Error).message);
      }
    };

    void render();
    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  if (error) {
    return (
      <div className={className}>
        <p className="mb-2 text-[12px] text-[var(--forge-text-muted)]">
          The diagram could not be rendered; its source is shown instead.
        </p>
        <pre className="overflow-x-auto rounded-[var(--forge-radius)] border border-[var(--forge-border)] bg-[var(--forge-bg-subtle)] p-3 text-[11px]">
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  return (
    <div
      className={`overflow-x-auto rounded-[var(--forge-radius-lg)] border border-[var(--forge-border)] bg-[var(--forge-bg-subtle)] p-4 ${className ?? ''}`}
    >
      <div ref={containerRef} className={rendered ? 'forge-fade' : 'opacity-0'} />
      {!rendered ? (
        <div className="h-40 animate-pulse rounded-[var(--forge-radius)] bg-[var(--forge-border)]/40" />
      ) : null}
    </div>
  );
}
