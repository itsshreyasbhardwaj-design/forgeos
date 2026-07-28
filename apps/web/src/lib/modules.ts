import {
  Boxes,
  BookText,
  FlaskConical,
  Network,
  Bot,
  Brain,
  Workflow,
  Braces,
  ShieldCheck,
  LayoutDashboard,
  Settings,
  type LucideIcon,
} from 'lucide-react';

/**
 * The module registry.
 *
 * A single source of truth for navigation, the command palette, the landing
 * page and search filters — so a new module appears everywhere at once instead
 * of being wired into five places and forgotten in a sixth.
 */
export interface ModuleDefinition {
  readonly id: string;
  readonly name: string;
  readonly href: string;
  readonly icon: LucideIcon;
  readonly summary: string;
  /** What this module replaces in a typical toolchain. */
  readonly replaces: string;
  readonly group: 'understand' | 'build' | 'operate' | 'system';
  readonly shortcut?: string;
}

export const MODULES: readonly ModuleDefinition[] = [
  {
    id: 'dashboard',
    name: 'Dashboard',
    href: '/dashboard',
    icon: LayoutDashboard,
    summary: 'Workspace health, recent activity and everything that needs attention.',
    replaces: 'Status meetings',
    group: 'understand',
    shortcut: 'g d',
  },
  {
    id: 'repositories',
    name: 'Repositories',
    href: '/repositories',
    icon: Boxes,
    summary:
      'Analyse any codebase: languages, complexity, dependency graph, hotspots and technical debt.',
    replaces: 'Reading the code for three days',
    group: 'understand',
    shortcut: 'g r',
  },
  {
    id: 'architecture',
    name: 'Architecture',
    href: '/architecture',
    icon: Network,
    summary: 'Interactive module graphs, layer diagrams, database ERDs and API maps.',
    replaces: 'A whiteboard photo in Slack',
    group: 'understand',
    shortcut: 'g a',
  },
  {
    id: 'documentation',
    name: 'Documentation',
    href: '/documentation',
    icon: BookText,
    summary: 'Generate README, architecture, API, setup and deployment docs from real analysis.',
    replaces: 'Docs that went stale in 2023',
    group: 'build',
    shortcut: 'g o',
  },
  {
    id: 'apis',
    name: 'API platform',
    href: '/apis',
    icon: Braces,
    summary: 'Design specifications, mock them, test them, and generate typed SDKs.',
    replaces: 'Postman plus a wiki page',
    group: 'build',
    shortcut: 'g p',
  },
  {
    id: 'workflows',
    name: 'Workflows',
    href: '/workflows',
    icon: Workflow,
    summary: 'Compose multi-step automations across every module, with full execution traces.',
    replaces: 'A folder of shell scripts',
    group: 'build',
    shortcut: 'g w',
  },
  {
    id: 'evaluation',
    name: 'Evaluation',
    href: '/evaluation',
    icon: FlaskConical,
    summary: 'Compare prompts and models on quality, latency, tokens and real cost.',
    replaces: 'Vibes',
    group: 'build',
    shortcut: 'g e',
  },
  {
    id: 'security',
    name: 'Security',
    href: '/security',
    icon: ShieldCheck,
    summary:
      'Secret detection, insecure-pattern analysis, dependency advisories and compliance mapping.',
    replaces: 'An annual pen test',
    group: 'operate',
    shortcut: 'g s',
  },
  {
    id: 'automation',
    name: 'Automation',
    href: '/automation',
    icon: Bot,
    summary: 'Pull-request review, changelogs, release notes and repository health checks.',
    replaces: 'Nagging in code review',
    group: 'operate',
    shortcut: 'g u',
  },
  {
    id: 'memory',
    name: 'Memory',
    href: '/memory',
    icon: Brain,
    summary: 'Long-term semantic memory and a knowledge graph of everything the team decided.',
    replaces: 'Asking the person who left',
    group: 'operate',
    shortcut: 'g m',
  },
  {
    id: 'settings',
    name: 'Settings',
    href: '/settings',
    icon: Settings,
    summary: 'Workspace configuration, runtime status, API keys and plugins.',
    replaces: '',
    group: 'system',
  },
];

export const MODULE_GROUPS: readonly { id: ModuleDefinition['group']; label: string }[] = [
  { id: 'understand', label: 'Understand' },
  { id: 'build', label: 'Build' },
  { id: 'operate', label: 'Operate' },
  { id: 'system', label: 'System' },
];

export function moduleByHref(pathname: string): ModuleDefinition | undefined {
  return (
    MODULES.find((module) => module.href === pathname) ??
    MODULES.find((module) => module.href !== '/' && pathname.startsWith(`${module.href}/`))
  );
}
