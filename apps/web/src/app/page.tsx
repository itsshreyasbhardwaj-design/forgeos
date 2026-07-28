import Link from 'next/link';
import { ArrowRight, Check, Zap } from 'lucide-react';
import { MODULES } from '@/lib/modules';

export const metadata = {
  title: 'ForgeOS — the developer operating system',
};

const PRINCIPLES = [
  {
    title: 'Works with an empty environment',
    body: 'No API key, no database, no account. Storage falls back to a local file, the AI provider falls back to a deterministic offline responder, and every module still functions. Configure a variable and the corresponding subsystem upgrades at boot.',
  },
  {
    title: 'Grounded, not generated',
    body: 'Every metric, diagram and document is derived from the code in front of it. Where ForgeOS cannot determine something it says so and tells you what to fill in, rather than producing a confident sentence that happens to be wrong.',
  },
  {
    title: 'One kernel, nine modules',
    body: 'The analysis engine has zero runtime dependencies and runs identically in a server component, an edge function, a CLI or a test. Modules are projections of one shared model, so numbers never disagree between panels.',
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-[var(--forge-border)] bg-[var(--forge-bg)]/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-6">
          <span className="flex h-7 w-7 items-center justify-center rounded-[var(--forge-radius-sm)] bg-[var(--forge-accent)] text-white">
            <Zap className="h-4 w-4" />
          </span>
          <span className="text-[13px] font-semibold tracking-tight">ForgeOS</span>
          <nav className="ml-auto flex items-center gap-4 text-[13px]">
            <a
              href="https://github.com/itsshreyasbhardwaj-design/forgeos"
              className="text-[var(--forge-text-muted)] transition-colors hover:text-[var(--forge-text)]"
            >
              GitHub
            </a>
            <Link
              href="/dashboard"
              className="rounded-[var(--forge-radius)] bg-[var(--forge-accent)] px-3.5 py-1.5 font-medium text-white transition-colors hover:bg-[var(--forge-accent-hover)]"
            >
              Open the app
            </Link>
          </nav>
        </div>
      </header>

      <section className="relative overflow-hidden">
        <div className="forge-grid pointer-events-none absolute inset-0 opacity-60" aria-hidden="true" />
        <div className="relative mx-auto max-w-6xl px-6 py-24 text-center sm:py-32">
          <span className="inline-flex items-center gap-2 rounded-full border border-[var(--forge-border)] bg-[var(--forge-surface)] px-3 py-1 text-[12px] text-[var(--forge-text-muted)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--forge-success)]" />
            Open source · MIT · runs with zero configuration
          </span>

          <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-semibold leading-[1.1] tracking-tight sm:text-6xl">
            Nine tools became
            <span className="text-[var(--forge-accent-text)]"> one workspace</span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-[var(--forge-text-muted)]">
            Repository intelligence, documentation, architecture, evaluation, automation, memory,
            workflows, APIs and security — sharing one identity system, one search index, one memory
            and one AI that can see all of it.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/dashboard"
              className="inline-flex h-11 items-center gap-2 rounded-[var(--forge-radius)] bg-[var(--forge-accent)] px-6 text-sm font-medium text-white shadow-[var(--forge-shadow)] transition-transform hover:scale-[1.02]"
            >
              Open the app
              <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href="https://github.com/itsshreyasbhardwaj-design/forgeos"
              className="inline-flex h-11 items-center gap-2 rounded-[var(--forge-radius)] border border-[var(--forge-border)] px-6 text-sm font-medium transition-colors hover:border-[var(--forge-border-strong)]"
            >
              Read the source
            </a>
          </div>

          <p className="mt-5 text-[12px] text-[var(--forge-text-subtle)]">
            A sample repository is bundled, so every module has real data on first run.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.filter((module) => module.group !== 'system' && module.id !== 'dashboard').map(
            (module) => {
              const Icon = module.icon;
              return (
                <Link
                  key={module.id}
                  href={module.href}
                  className="group rounded-[var(--forge-radius-lg)] border border-[var(--forge-border)] bg-[var(--forge-surface)] p-5 transition-all hover:-translate-y-0.5 hover:border-[var(--forge-accent-border)] hover:shadow-[var(--forge-shadow)]"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-[var(--forge-radius)] bg-[var(--forge-accent-subtle)] text-[var(--forge-accent-text)]">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="text-sm font-semibold">{module.name}</span>
                  </div>
                  <p className="mt-3 text-[13px] leading-relaxed text-[var(--forge-text-muted)]">
                    {module.summary}
                  </p>
                  {module.replaces ? (
                    <p className="mt-3 text-[11px] uppercase tracking-wider text-[var(--forge-text-subtle)]">
                      replaces · {module.replaces}
                    </p>
                  ) : null}
                </Link>
              );
            }
          )}
        </div>
      </section>

      <section className="border-y border-[var(--forge-border)] bg-[var(--forge-bg-subtle)]">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-center text-2xl font-semibold tracking-tight">
            Three decisions that shaped it
          </h2>
          <div className="mt-10 grid gap-8 md:grid-cols-3">
            {PRINCIPLES.map((principle) => (
              <div key={principle.title}>
                <div className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-[var(--forge-success)]" />
                  <h3 className="text-sm font-semibold">{principle.title}</h3>
                </div>
                <p className="mt-2.5 text-[13px] leading-relaxed text-[var(--forge-text-muted)]">
                  {principle.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="grid gap-10 md:grid-cols-2">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Start in one command</h2>
            <p className="mt-3 text-[13px] leading-relaxed text-[var(--forge-text-muted)]">
              Clone, install, run. No database to provision, no keys to obtain, nothing to sign up
              for. Add credentials later and each subsystem upgrades in place.
            </p>
          </div>
          <pre className="overflow-x-auto rounded-[var(--forge-radius-lg)] border border-[var(--forge-border)] bg-[var(--forge-surface)] p-5 text-[12px] leading-relaxed">
            <code>{`git clone https://github.com/itsshreyasbhardwaj-design/forgeos
cd forgeos
pnpm install
pnpm build:packages
pnpm dev

# analyse any repository from the terminal
pnpm analyze ../some-project`}</code>
          </pre>
        </div>
      </section>

      <footer className="border-t border-[var(--forge-border)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-[12px] text-[var(--forge-text-subtle)]">
          <span>MIT licensed. Built to be contributed to.</span>
          <div className="flex gap-4">
            <Link href="/dashboard" className="hover:text-[var(--forge-text)]">
              App
            </Link>
            <a
              href="https://github.com/itsshreyasbhardwaj-design/forgeos"
              className="hover:text-[var(--forge-text)]"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
