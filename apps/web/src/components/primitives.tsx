import type { ReactNode } from 'react';
import { Badge, type BadgeTone } from '@forgeos/ui';

/** Page chrome shared by every module, so headings stay consistent. */
export function PageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="border-b border-[var(--forge-border)] px-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-[var(--forge-text)]">{title}</h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-[var(--forge-text-muted)]">
              {description}
            </p>
          ) : null}
          {meta ? <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`px-6 py-6 ${className ?? ''}`}>
      {title ? (
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-[13px] font-semibold uppercase tracking-wider text-[var(--forge-text-subtle)]">
              {title}
            </h2>
            {description ? (
              <p className="mt-1 text-[13px] text-[var(--forge-text-muted)]">{description}</p>
            ) : null}
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

const SEVERITY_TONES: Record<string, BadgeTone> = {
  critical: 'critical',
  high: 'high',
  moderate: 'moderate',
  medium: 'moderate',
  low: 'low',
  blocking: 'critical',
  important: 'high',
  suggestion: 'moderate',
  nitpick: 'low',
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <Badge tone={SEVERITY_TONES[severity] ?? 'neutral'} dot>
      {severity}
    </Badge>
  );
}

export function GradeBadge({ grade }: { grade: string }) {
  const tone: BadgeTone =
    grade === 'A' ? 'success' : grade === 'B' ? 'info' : grade === 'C' ? 'warning' : 'danger';
  return <Badge tone={tone}>Grade {grade}</Badge>;
}

/**
 * A horizontal composition bar — languages, severities, statuses.
 * Segments carry a title attribute so the breakdown is available without
 * relying on the legend or on colour discrimination.
 */
export function CompositionBar({
  segments,
  height = 8,
}: {
  segments: readonly { label: string; value: number; color: string }[];
  height?: number;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total === 0) return null;

  return (
    <div
      className="flex w-full overflow-hidden rounded-full bg-[var(--forge-bg-subtle)]"
      style={{ height }}
      role="img"
      aria-label={segments.map((segment) => `${segment.label}: ${segment.value}`).join(', ')}
    >
      {segments.map((segment) => (
        <div
          key={segment.label}
          title={`${segment.label} — ${((segment.value / total) * 100).toFixed(1)}%`}
          style={{ width: `${(segment.value / total) * 100}%`, background: segment.color }}
        />
      ))}
    </div>
  );
}

export function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-[13px]">
      <span className="text-[var(--forge-text-muted)]">{label}</span>
      <span className="text-right font-medium tabular-nums text-[var(--forge-text)]">{value}</span>
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return (
    <code className="rounded border border-[var(--forge-border)] bg-[var(--forge-bg-subtle)] px-1.5 py-0.5 font-[var(--forge-font-mono)] text-[11px]">
      {children}
    </code>
  );
}

/** A table that scrolls horizontally rather than forcing the page to. */
export function ScrollTable({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-[var(--forge-radius-lg)] border border-[var(--forge-border)]">
      <table className="w-full min-w-[560px] text-left text-[13px]">{children}</table>
    </div>
  );
}

export function Th({ children, align }: { children: ReactNode; align?: 'right' }) {
  return (
    <th
      className={`whitespace-nowrap border-b border-[var(--forge-border)] bg-[var(--forge-bg-subtle)] px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--forge-text-subtle)] ${
        align === 'right' ? 'text-right' : ''
      }`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align,
  className,
}: {
  children: ReactNode;
  align?: 'right';
  className?: string;
}) {
  return (
    <td
      className={`border-b border-[var(--forge-border)] px-3 py-2 align-top ${
        align === 'right' ? 'text-right tabular-nums' : ''
      } ${className ?? ''}`}
    >
      {children}
    </td>
  );
}
