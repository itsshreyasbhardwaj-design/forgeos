'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@forgeos/ui';
import { Play } from 'lucide-react';

/**
 * Runs a ready-made benchmark comparing two prompt styles.
 *
 * The default configuration uses whatever models are registered — with no API
 * key that is the local provider only, and the run costs nothing. The cases are
 * about summarising repository facts, which is what the assistant actually does,
 * so the comparison measures something the product cares about.
 */
export function RunBenchmarkButton({ models }: { models: readonly string[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);

    const primary = models[0] ?? 'forge-local';
    const secondary = models[1] ?? primary;

    try {
      const response = await fetch('/api/benchmarks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Summarisation: terse vs. structured',
          seed: 7,
          variants: [
            {
              label: 'Terse instruction',
              model: primary,
              temperature: 0,
              template: {
                id: 'terse',
                name: 'Terse',
                system: 'Answer using only the supplied context. Be brief.',
                user: 'Context:\n{{context}}\n\nQuestion: {{question}}',
              },
            },
            {
              label: 'Structured instruction',
              model: secondary,
              temperature: 0,
              template: {
                id: 'structured',
                name: 'Structured',
                system:
                  'You answer strictly from the supplied context. State the direct answer first, then the evidence. If the context does not contain the answer, say so explicitly.',
                user: 'Context:\n{{context}}\n\nQuestion: {{question}}\n\nAnswer:',
              },
            },
          ],
          cases: [
            {
              id: 'health',
              variables: {
                context:
                  'Repository orders-service has 1,240 lines of code across 18 files. Its health score is 62 out of 100, grade C. There is one circular dependency between order-service.ts and fulfilment.ts.',
                question: 'What is the health score and what causes the main structural problem?',
              },
              expected: 'The health score is 62 (grade C); a circular dependency between order-service and fulfilment.',
              mustContain: ['62', 'circular'],
              mustNotContain: ['I think', 'probably'],
            },
            {
              id: 'routes',
              variables: {
                context:
                  'The service exposes five HTTP routes: GET /orders, GET /orders/:id, POST /orders, POST /orders/:id/cancel and DELETE /orders/:id.',
                question: 'How many routes are there and which one cancels an order?',
              },
              expected: 'Five routes; POST /orders/:id/cancel cancels an order.',
              mustContain: ['cancel'],
            },
            {
              id: 'unknown',
              variables: {
                context: 'Repository orders-service has 1,240 lines of code and a health score of 62.',
                question: 'Which cloud provider is this deployed to?',
              },
              expected: 'The context does not say which cloud provider is used.',
              mustNotContain: ['AWS', 'Azure', 'Google Cloud'],
            },
          ],
          scorers: [
            { id: 'contains', weight: 2 },
            { id: 'not-contains', weight: 2 },
            { id: 'similarity', weight: 1.5 },
            { id: 'length', weight: 0.5, minLength: 20, maxLength: 2000 },
          ],
        }),
      });

      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok) throw new Error(payload?.error?.message ?? 'The benchmark failed');
      startTransition(() => router.refresh());
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Button variant="primary" size="sm" loading={busy || pending} onClick={() => void run()}>
        {!busy ? <Play className="h-3.5 w-3.5" /> : null}
        Run benchmark
      </Button>
      {error ? (
        <p role="alert" className="mt-2 text-[12px] text-[var(--forge-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
