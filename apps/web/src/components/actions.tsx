'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@forgeos/ui';
import { Plus, RefreshCw, ShieldCheck, Sparkles, Play } from 'lucide-react';

/**
 * Client actions.
 *
 * Each one posts to the API and then calls `router.refresh()`, which re-runs the
 * server components for the current route. That keeps a single source of truth —
 * the server — instead of duplicating the rendering logic client-side to patch
 * local state after a mutation.
 */
function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (
    input: RequestInfo,
    init?: RequestInit,
    onDone?: (payload: unknown) => void
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(input, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? `Request failed (${response.status})`);
      }
      onDone?.(payload);
      startTransition(() => router.refresh());
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return { run, busy: busy || pending, error };
}

function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-2 text-[12px] text-[var(--forge-danger)]">
      {error}
    </p>
  );
}

export function AnalyzeButton({ projectId, label = 'Re-analyse' }: { projectId: string; label?: string }) {
  const { run, busy, error } = useAction();
  return (
    <div>
      <Button
        variant="primary"
        size="sm"
        loading={busy}
        onClick={() => void run(`/api/projects/${projectId}/analyze`)}
      >
        {!busy ? <RefreshCw className="h-3.5 w-3.5" /> : null}
        {label}
      </Button>
      <ErrorText error={error} />
    </div>
  );
}

export function GenerateDocsButton({ projectId }: { projectId: string }) {
  const { run, busy, error } = useAction();
  return (
    <div>
      <Button
        variant="primary"
        size="sm"
        loading={busy}
        onClick={() =>
          void run('/api/docs/generate', { body: JSON.stringify({ projectId }) })
        }
      >
        {!busy ? <Sparkles className="h-3.5 w-3.5" /> : null}
        Generate documentation
      </Button>
      <ErrorText error={error} />
    </div>
  );
}

export function ScanButton({ projectId }: { projectId: string }) {
  const { run, busy, error } = useAction();
  return (
    <div>
      <Button
        variant="primary"
        size="sm"
        loading={busy}
        onClick={() => void run('/api/security/scan', { body: JSON.stringify({ projectId }) })}
      >
        {!busy ? <ShieldCheck className="h-3.5 w-3.5" /> : null}
        Run security scan
      </Button>
      <ErrorText error={error} />
    </div>
  );
}

export function RunWorkflowButton({ workflowId }: { workflowId: string }) {
  const { run, busy, error } = useAction();
  return (
    <div>
      <Button
        variant="secondary"
        size="sm"
        loading={busy}
        onClick={() => void run(`/api/workflows/${workflowId}/run`, { body: JSON.stringify({}) })}
      >
        {!busy ? <Play className="h-3.5 w-3.5" /> : null}
        Run
      </Button>
      <ErrorText error={error} />
    </div>
  );
}

export function CreateSpecButton({ projectId, name }: { projectId?: string; name: string }) {
  const { run, busy, error } = useAction();
  return (
    <div>
      <Button
        variant="primary"
        size="sm"
        loading={busy}
        onClick={() =>
          void run('/api/specs', {
            body: JSON.stringify({ name, ...(projectId ? { projectId } : {}) }),
          })
        }
      >
        {!busy ? <Plus className="h-3.5 w-3.5" /> : null}
        {projectId ? 'Derive spec from routes' : 'New specification'}
      </Button>
      <ErrorText error={error} />
    </div>
  );
}

export function AddRepositoryForm() {
  const { run, busy, error } = useAction();
  const [name, setName] = useState('');
  const [source, setSource] = useState('');

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() === '' || source.trim() === '') return;
        void run('/api/projects', { body: JSON.stringify({ name, source }) }, () => {
          setName('');
          setSource('');
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-[var(--forge-text-muted)]">
            Name
          </span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="orders-service"
            required
            maxLength={120}
            className="h-9 w-full rounded-[var(--forge-radius)] border border-[var(--forge-border)] bg-[var(--forge-surface)] px-3 text-sm outline-none focus:border-[var(--forge-accent)]"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-[var(--forge-text-muted)]">
            Local path
          </span>
          <input
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="/Users/you/code/orders-service"
            required
            className="h-9 w-full rounded-[var(--forge-radius)] border border-[var(--forge-border)] bg-[var(--forge-surface)] px-3 font-[var(--forge-font-mono)] text-[12px] outline-none focus:border-[var(--forge-accent)]"
          />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" size="sm" loading={busy}>
          {!busy ? <Plus className="h-3.5 w-3.5" /> : null}
          Add repository
        </Button>
        <p className="text-[12px] text-[var(--forge-text-subtle)]">
          Paths are restricted to <code>FORGEOS_SCAN_ROOT</code> (defaults to the server&apos;s
          working directory).
        </p>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

export function AddMemoryForm() {
  const { run, busy, error } = useAction();
  const [content, setContent] = useState('');

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (content.trim() === '') return;
        void run('/api/memory', { body: JSON.stringify({ content, kind: 'decision' }) }, () =>
          setContent('')
        );
      }}
    >
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        rows={3}
        placeholder="We chose Postgres over DynamoDB because our access patterns are relational and the team already operates Postgres."
        className="w-full resize-y rounded-[var(--forge-radius)] border border-[var(--forge-border)] bg-[var(--forge-surface)] px-3 py-2 text-[13px] outline-none focus:border-[var(--forge-accent)]"
      />
      <Button type="submit" variant="primary" size="sm" loading={busy}>
        {!busy ? <Plus className="h-3.5 w-3.5" /> : null}
        Remember this
      </Button>
      <ErrorText error={error} />
    </form>
  );
}
