'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@forgeos/ui';
import { Plus } from 'lucide-react';

/**
 * Creates a starter workflow.
 *
 * Rather than an empty canvas, a new user gets a workflow that already does
 * something worth doing — analyse, scan, then summarise — including a
 * conditional edge, so the branching model is visible from the first run.
 */
export function SeedWorkflowButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Repository health check',
          description:
            'Analyses a repository, scans it for security problems, and writes a summary — escalating only when something critical is found.',
          nodes: [
            {
              id: 'start',
              type: 'trigger.manual',
              label: 'Start',
              config: {},
              position: { x: 0, y: 0 },
            },
            {
              id: 'analyse',
              type: 'repo.analyse',
              label: 'Analyse repository',
              config: { projectId },
              position: { x: 240, y: 0 },
              retries: 1,
            },
            {
              id: 'scan',
              type: 'security.scan',
              label: 'Security scan',
              config: { projectId },
              position: { x: 480, y: 0 },
            },
            {
              id: 'summary',
              type: 'ai.complete',
              label: 'Write the summary',
              config: {
                system:
                  'You summarise repository health for an engineering team. Be specific and brief.',
                prompt:
                  'Repository {{steps.analyse.output.name}} has {{steps.analyse.output.code}} lines of code and a health score of {{steps.analyse.output.health}} ({{steps.analyse.output.grade}}). The security scan scored {{steps.scan.output.score}} with {{steps.scan.output.critical}} critical and {{steps.scan.output.high}} high findings. The riskiest modules are {{steps.analyse.output.hotspots}}. Summarise the state of this repository and name the single most valuable next action.',
              },
              position: { x: 720, y: 0 },
            },
            {
              id: 'escalate',
              type: 'transform.template',
              label: 'Escalate',
              config: {
                template:
                  'ESCALATION: {{steps.scan.output.critical}} critical security findings in {{steps.analyse.output.name}}.',
              },
              position: { x: 720, y: 140 },
            },
          ],
          edges: [
            { from: 'start', to: 'analyse' },
            { from: 'analyse', to: 'scan' },
            { from: 'scan', to: 'summary' },
            {
              from: 'scan',
              to: 'escalate',
              condition: 'steps.scan.output.critical > 0',
              label: 'critical findings',
            },
          ],
        }),
      });

      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok) throw new Error(payload?.error?.message ?? 'Could not create the workflow');
      startTransition(() => router.refresh());
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Button variant="primary" size="sm" loading={busy || pending} onClick={() => void create()}>
        {!busy ? <Plus className="h-3.5 w-3.5" /> : null}
        Create starter workflow
      </Button>
      {error ? (
        <p role="alert" className="mt-2 text-[12px] text-[var(--forge-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
