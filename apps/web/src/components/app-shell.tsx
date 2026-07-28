'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PanelLeftClose, PanelLeft, Zap } from 'lucide-react';
import { MODULES, MODULE_GROUPS, moduleByHref } from '@/lib/modules';
import { CommandPalette } from './command-palette';
import { AssistantPanel } from './assistant-panel';
import { ThemeToggle } from './theme-toggle';

/**
 * The application shell: sidebar, top bar, palette and assistant.
 *
 * Navigation is keyboard-first. `g` followed by a module key jumps directly —
 * the same two-key idiom Gmail, GitHub and Linear all use — and the sidebar's
 * collapsed state persists so the layout does not reset on every navigation.
 */
export function AppShell({
  children,
  workspaceName,
  runtime,
}: {
  children: React.ReactNode;
  workspaceName: string;
  runtime: { storage: string; defaultModel: string; auth: string };
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const active = moduleByHref(pathname);

  useEffect(() => {
    setCollapsed(localStorage.getItem('forgeos-sidebar') === 'collapsed');
  }, []);

  // `g` then a key: the two-stroke navigation idiom.
  useEffect(() => {
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;

    const handler = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (!pending && event.key.toLowerCase() === 'g') {
        pending = true;
        timer = setTimeout(() => {
          pending = false;
        }, 1200);
        return;
      }

      if (pending) {
        pending = false;
        clearTimeout(timer);
        const module = MODULES.find(
          (candidate) => candidate.shortcut === `g ${event.key.toLowerCase()}`
        );
        if (module) {
          event.preventDefault();
          window.location.assign(module.href);
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      clearTimeout(timer);
    };
  }, []);

  const toggle = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('forgeos-sidebar', next ? 'collapsed' : 'expanded');
  };

  return (
    <div className="flex min-h-screen">
      <nav
        className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-[var(--forge-border)] bg-[var(--forge-bg-subtle)] transition-[width] duration-200 md:flex ${
          collapsed ? 'w-[60px]' : 'w-[228px]'
        }`}
        aria-label="Modules"
      >
        <div className="flex h-14 items-center gap-2 px-3">
          <Link href="/dashboard" className="flex items-center gap-2 overflow-hidden">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--forge-radius-sm)] bg-[var(--forge-accent)] text-white">
              <Zap className="h-4 w-4" />
            </span>
            {!collapsed ? (
              <span className="truncate text-[13px] font-semibold tracking-tight">ForgeOS</span>
            ) : null}
          </Link>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {MODULE_GROUPS.map((group) => {
            const modules = MODULES.filter((module) => module.group === group.id);
            if (modules.length === 0) return null;
            return (
              <div key={group.id} className="mb-3">
                {!collapsed ? (
                  <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--forge-text-subtle)]">
                    {group.label}
                  </div>
                ) : null}
                <ul className="space-y-0.5">
                  {modules.map((module) => {
                    const Icon = module.icon;
                    const isActive = active?.id === module.id;
                    return (
                      <li key={module.id}>
                        <Link
                          href={module.href}
                          title={collapsed ? module.name : undefined}
                          aria-current={isActive ? 'page' : undefined}
                          className={`flex h-8 items-center gap-2.5 rounded-[var(--forge-radius)] px-2 text-[13px] transition-colors ${
                            isActive
                              ? 'bg-[var(--forge-accent-subtle)] font-medium text-[var(--forge-accent-text)]'
                              : 'text-[var(--forge-text-muted)] hover:bg-[var(--forge-surface)] hover:text-[var(--forge-text)]'
                          }`}
                        >
                          <Icon className="h-4 w-4 shrink-0" />
                          {!collapsed ? <span className="truncate">{module.name}</span> : null}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="border-t border-[var(--forge-border)] p-2">
          <button
            type="button"
            onClick={toggle}
            className="flex h-8 w-full items-center gap-2.5 rounded-[var(--forge-radius)] px-2 text-[13px] text-[var(--forge-text-muted)] transition-colors hover:bg-[var(--forge-surface)] hover:text-[var(--forge-text)]"
            aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          >
            {collapsed ? (
              <PanelLeft className="h-4 w-4" />
            ) : (
              <>
                <PanelLeftClose className="h-4 w-4" />
                <span>Collapse</span>
              </>
            )}
          </button>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-[var(--forge-border)] bg-[var(--forge-bg)]/85 px-4 backdrop-blur-md">
          <div className="flex min-w-0 items-center gap-2 text-[13px]">
            <span className="truncate font-medium text-[var(--forge-text)]">{workspaceName}</span>
            {active ? (
              <>
                <span className="text-[var(--forge-text-subtle)]">/</span>
                <span className="truncate text-[var(--forge-text-muted)]">{active.name}</span>
              </>
            ) : null}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <CommandPalette />
            <span
              className="hidden items-center gap-1.5 rounded-full border border-[var(--forge-border)] px-2.5 py-1 text-[11px] text-[var(--forge-text-muted)] lg:flex"
              title={`Storage: ${runtime.storage} · Auth: ${runtime.auth}`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--forge-success)]" />
              {runtime.defaultModel}
            </span>
            <ThemeToggle />
          </div>
        </header>

        <main id="main" className="min-w-0 flex-1">
          {children}
        </main>
      </div>

      <AssistantPanel />
    </div>
  );
}
