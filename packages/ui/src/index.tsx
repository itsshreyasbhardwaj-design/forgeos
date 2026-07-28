import * as React from 'react';

/**
 * `@forgeos/ui` — the ForgeOS design system.
 *
 * Primitives only, with no component-library dependency. Two rules hold
 * throughout:
 *
 *  1. **Every component forwards its ref and spreads its remaining props.**
 *     A design system that swallows `aria-*`, `data-*` or event handlers forces
 *     consumers to escape it, which is how design systems die.
 *  2. **Interactive states are never conveyed by colour alone.** Severity,
 *     status and selection all carry a shape, an icon or text as well.
 */

export function cn(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

// --- Button -----------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap select-none ' +
  'transition-[background-color,border-color,color,box-shadow,transform] duration-150 ' +
  'disabled:opacity-50 disabled:pointer-events-none active:translate-y-px';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--forge-accent)] text-white hover:bg-[var(--forge-accent-hover)] shadow-[var(--forge-shadow-sm)]',
  secondary:
    'bg-[var(--forge-surface)] text-[var(--forge-text)] border border-[var(--forge-border)] hover:border-[var(--forge-border-strong)] hover:bg-[var(--forge-bg-subtle)]',
  ghost: 'text-[var(--forge-text-muted)] hover:text-[var(--forge-text)] hover:bg-[var(--forge-bg-subtle)]',
  danger: 'bg-[var(--forge-danger)] text-white hover:opacity-90',
  subtle:
    'bg-[var(--forge-accent-subtle)] text-[var(--forge-accent-text)] border border-[var(--forge-accent-border)] hover:brightness-105',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] rounded-[var(--forge-radius-sm)]',
  md: 'h-9 px-4 text-sm rounded-[var(--forge-radius)]',
  lg: 'h-11 px-6 text-[15px] rounded-[var(--forge-radius)]',
  icon: 'h-9 w-9 rounded-[var(--forge-radius)]',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', loading, children, disabled, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      className={cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
      disabled={disabled || loading}
      // Communicate the busy state to assistive technology, not just visually.
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner className="h-3.5 w-3.5" /> : null}
      {children}
    </button>
  );
});

// --- Card -------------------------------------------------------------------

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, interactive, ...props },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn(
        'rounded-[var(--forge-radius-lg)] border border-[var(--forge-border)] bg-[var(--forge-surface)]',
        interactive &&
          'transition-[border-color,box-shadow,transform] duration-200 hover:border-[var(--forge-border-strong)] hover:shadow-[var(--forge-shadow)] hover:-translate-y-0.5',
        className
      )}
      {...props}
    />
  );
});

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function CardHeader({ className, ...props }, ref) {
    return <div ref={ref} className={cn('px-5 pt-5 pb-3', className)} {...props} />;
  }
);

export const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  function CardTitle({ className, ...props }, ref) {
    return (
      <h3
        ref={ref}
        className={cn('text-sm font-semibold tracking-tight text-[var(--forge-text)]', className)}
        {...props}
      />
    );
  }
);

export const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function CardDescription({ className, ...props }, ref) {
  return (
    <p ref={ref} className={cn('text-[13px] text-[var(--forge-text-muted)]', className)} {...props} />
  );
});

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function CardContent({ className, ...props }, ref) {
    return <div ref={ref} className={cn('px-5 pb-5', className)} {...props} />;
  }
);

// --- Badge ------------------------------------------------------------------

export type BadgeTone =
  | 'neutral'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'critical'
  | 'high'
  | 'moderate'
  | 'low';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-[var(--forge-bg-subtle)] text-[var(--forge-text-muted)] border-[var(--forge-border)]',
  accent: 'bg-[var(--forge-accent-subtle)] text-[var(--forge-accent-text)] border-[var(--forge-accent-border)]',
  success: 'bg-[var(--forge-success-subtle)] text-[var(--forge-success)] border-transparent',
  warning: 'bg-[var(--forge-warning-subtle)] text-[var(--forge-warning)] border-transparent',
  danger: 'bg-[var(--forge-danger-subtle)] text-[var(--forge-danger)] border-transparent',
  info: 'bg-[var(--forge-info-subtle)] text-[var(--forge-info)] border-transparent',
  critical: 'bg-[var(--forge-danger-subtle)] text-[var(--forge-critical)] border-transparent',
  high: 'bg-[var(--forge-warning-subtle)] text-[var(--forge-high)] border-transparent',
  moderate: 'bg-[var(--forge-warning-subtle)] text-[var(--forge-moderate)] border-transparent',
  low: 'bg-[var(--forge-info-subtle)] text-[var(--forge-low)] border-transparent',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Render a leading dot. Useful when the tone alone is too subtle. */
  dot?: boolean;
}

export function Badge({ className, tone = 'neutral', dot, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5',
        BADGE_TONES[tone],
        className
      )}
      {...props}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

// --- Input ------------------------------------------------------------------

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-9 w-full rounded-[var(--forge-radius)] border border-[var(--forge-border)] bg-[var(--forge-surface)]',
          'px-3 text-sm text-[var(--forge-text)] placeholder:text-[var(--forge-text-subtle)]',
          'transition-colors focus:border-[var(--forge-accent)] focus:outline-none',
          className
        )}
        {...props}
      />
    );
  }
);

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'w-full rounded-[var(--forge-radius)] border border-[var(--forge-border)] bg-[var(--forge-surface)]',
        'px-3 py-2 text-sm text-[var(--forge-text)] placeholder:text-[var(--forge-text-subtle)]',
        'transition-colors focus:border-[var(--forge-accent)] focus:outline-none resize-y',
        className
      )}
      {...props}
    />
  );
});

// --- Feedback ---------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label="Loading"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-[var(--forge-radius-sm)] bg-[var(--forge-bg-subtle)]', className)}
      aria-hidden="true"
      {...props}
    />
  );
}

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {icon ? (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-[var(--forge-radius-lg)] border border-[var(--forge-border)] bg-[var(--forge-bg-subtle)] text-[var(--forge-text-subtle)]">
          {icon}
        </div>
      ) : null}
      <h3 className="text-sm font-semibold text-[var(--forge-text)]">{title}</h3>
      {description ? (
        <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-[var(--forge-text-muted)]">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

// --- Data display -----------------------------------------------------------

export interface ScoreRingProps {
  /** 0–100. */
  value: number;
  size?: number;
  label?: string;
  className?: string;
}

/**
 * A circular score indicator.
 * The colour follows the value, but the number is always shown — colour alone
 * would fail anyone with a colour-vision deficiency.
 */
export function ScoreRing({ value, size = 64, label, className }: ScoreRingProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  const colour =
    clamped >= 75
      ? 'var(--forge-success)'
      : clamped >= 50
        ? 'var(--forge-warning)'
        : 'var(--forge-danger)';

  return (
    <div
      className={cn('relative inline-flex items-center justify-center', className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${label ?? 'Score'}: ${Math.round(clamped)} out of 100`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--forge-border)"
          strokeWidth="4"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={colour}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 600ms var(--forge-ease)' }}
        />
      </svg>
      <span
        className="absolute font-semibold tabular-nums text-[var(--forge-text)]"
        style={{ fontSize: size * 0.28 }}
      >
        {Math.round(clamped)}
      </span>
    </div>
  );
}

export interface SparklineProps {
  values: readonly number[];
  width?: number;
  height?: number;
  className?: string;
  label?: string;
}

/** A minimal trend line. Renders nothing rather than a misleading flat line. */
export function Sparkline({ values, width = 96, height = 28, className, label }: SparklineProps) {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = width / (values.length - 1);

  const points = values
    .map((value, index) => `${index * step},${height - ((value - min) / range) * height}`)
    .join(' ');

  const rising = (values[values.length - 1] ?? 0) >= (values[0] ?? 0);

  return (
    <svg
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label={label ?? `Trend, ${rising ? 'rising' : 'falling'}`}
    >
      <polyline
        points={points}
        fill="none"
        stroke={rising ? 'var(--forge-success)' : 'var(--forge-danger)'}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface StatProps {
  label: string;
  value: React.ReactNode;
  hint?: string;
  trend?: readonly number[];
  className?: string;
}

export function Stat({ label, value, hint, trend, className }: StatProps) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--forge-text-subtle)]">
        {label}
      </span>
      <div className="flex items-end justify-between gap-3">
        <span className="text-2xl font-semibold tabular-nums tracking-tight text-[var(--forge-text)]">
          {value}
        </span>
        {trend ? <Sparkline values={trend} label={`${label} trend`} /> : null}
      </div>
      {hint ? <span className="text-[12px] text-[var(--forge-text-muted)]">{hint}</span> : null}
    </div>
  );
}

export interface ProgressBarProps {
  value: number;
  max?: number;
  tone?: BadgeTone;
  className?: string;
  label?: string;
}

export function ProgressBar({ value, max = 100, tone = 'accent', className, label }: ProgressBarProps) {
  const percentage = Math.max(0, Math.min(100, (value / max) * 100));
  const colour =
    tone === 'success'
      ? 'var(--forge-success)'
      : tone === 'danger' || tone === 'critical'
        ? 'var(--forge-danger)'
        : tone === 'warning' || tone === 'high' || tone === 'moderate'
          ? 'var(--forge-warning)'
          : 'var(--forge-accent)';

  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-[var(--forge-bg-subtle)]', className)}
      role="progressbar"
      aria-valuenow={Math.round(percentage)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className="h-full rounded-full"
        style={{
          width: `${percentage}%`,
          background: colour,
          transition: 'width 500ms var(--forge-ease)',
        }}
      />
    </div>
  );
}

/** Keyboard shortcut hint. */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-[var(--forge-border)]',
        'bg-[var(--forge-bg-subtle)] px-1.5 font-[var(--forge-font-mono)] text-[10px] font-medium text-[var(--forge-text-muted)]',
        className
      )}
    >
      {children}
    </kbd>
  );
}

/** Screen-reader-only text, for labels that must exist but not be seen. */
export function VisuallyHidden({ children }: { children: React.ReactNode }) {
  return (
    <span className="absolute h-px w-px overflow-hidden whitespace-nowrap [clip:rect(0,0,0,0)]">
      {children}
    </span>
  );
}
