'use client';

import { useCallback, useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'forgeos-theme';

function apply(theme: Theme): void {
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    setTheme(stored ?? 'system');
  }, []);

  // Track the OS preference so 'system' stays correct while the tab is open.
  useEffect(() => {
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (): void => apply('system');
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [theme]);

  const cycle = useCallback(() => {
    const next: Theme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
    setTheme(next);
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
    apply(next);
  }, [theme]);

  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return (
    <button
      type="button"
      onClick={cycle}
      className="flex h-8 w-8 items-center justify-center rounded-[var(--forge-radius)] text-[var(--forge-text-muted)] transition-colors hover:bg-[var(--forge-bg-subtle)] hover:text-[var(--forge-text)]"
      title={`Theme: ${theme}. Click to change.`}
      aria-label={`Switch theme. Currently ${theme}.`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
