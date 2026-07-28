import { parse, s, type Validator } from '../kernel/schema.js';
import { conflict, invalidInput, type ForgeError } from '../kernel/errors.js';
import type { Result } from '../kernel/result.js';
import type { NodeTypeDefinition } from '../workflow/engine.js';
import type { AssistantTool } from '../ai/assistant.js';
import type { SearchKind } from '../search/index.js';

/**
 * The plugin system.
 *
 * Plugins extend ForgeOS through **declared contribution points** rather than
 * by patching the host. A plugin says what it contributes — panels, commands,
 * AI tools, workflow nodes, visualisations, widgets — and the host decides
 * where each contribution appears. That inversion is what makes the plugin
 * surface reviewable: the manifest is a complete, static description of what a
 * plugin can do before any of its code runs.
 *
 * Permissions are declared up front and enforced at the host boundary. A plugin
 * that never declares `repository:read` cannot call a repository tool, no
 * matter what its code attempts.
 */
export const PLUGIN_PERMISSIONS = [
  'repository:read',
  'repository:write',
  'documents:read',
  'documents:write',
  'memory:read',
  'memory:write',
  'workflows:read',
  'workflows:execute',
  'api:read',
  'api:write',
  'security:read',
  'benchmarks:read',
  'benchmarks:execute',
  'network:fetch',
  'ai:complete',
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export interface PanelContribution {
  readonly id: string;
  readonly title: string;
  /** Where the panel is mounted in the shell. */
  readonly surface: 'sidebar' | 'main' | 'inspector' | 'repository-tab' | 'settings';
  readonly icon?: string;
  /** Module route the panel attaches to, when surface is a tab. */
  readonly module?: string;
}

export interface CommandContribution {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  /** Suggested shortcut, e.g. `mod+shift+k`. The user may rebind it. */
  readonly shortcut?: string;
  readonly icon?: string;
}

export interface VisualizationContribution {
  readonly id: string;
  readonly title: string;
  /** Data shape the visualisation consumes. */
  readonly dataKind: 'module-graph' | 'schema' | 'api-surface' | 'metrics' | 'timeline';
}

export interface WidgetContribution {
  readonly id: string;
  readonly title: string;
  readonly size: 'small' | 'medium' | 'large';
  readonly refreshSeconds?: number;
}

export interface SearchProviderContribution {
  readonly id: string;
  readonly title: string;
  readonly kind: SearchKind;
}

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author?: string;
  readonly homepage?: string;
  readonly license?: string;
  /** Minimum ForgeOS version, as a semver range. */
  readonly engine?: string;
  readonly permissions: readonly PluginPermission[];
  readonly contributes?: {
    readonly panels?: readonly PanelContribution[];
    readonly commands?: readonly CommandContribution[];
    readonly workflowNodes?: readonly { id: string; label: string; category: string }[];
    readonly aiTools?: readonly { name: string; description: string }[];
    readonly visualizations?: readonly VisualizationContribution[];
    readonly widgets?: readonly WidgetContribution[];
    readonly searchProviders?: readonly SearchProviderContribution[];
  };
}

const PERMISSION_VALIDATOR = s.enum(PLUGIN_PERMISSIONS) as Validator<PluginPermission>;

const MANIFEST_SCHEMA = s.object(
  {
    id: s.string({ min: 3, max: 64, pattern: /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/ }),
    name: s.string({ min: 1, max: 80 }),
    version: s.string({ pattern: /^\d+\.\d+\.\d+/ }),
    description: s.string({ min: 1, max: 500 }),
    author: s.optional(s.string({ max: 120 })),
    homepage: s.optional(s.string({ max: 300 })),
    license: s.optional(s.string({ max: 60 })),
    engine: s.optional(s.string({ max: 40 })),
    permissions: s.array(PERMISSION_VALIDATOR, { max: PLUGIN_PERMISSIONS.length }),
    contributes: s.optional(s.unknown()),
  },
  { optional: ['author', 'homepage', 'license', 'engine', 'contributes'] }
);

export function parsePluginManifest(value: unknown): Result<PluginManifest, ForgeError> {
  return parse(MANIFEST_SCHEMA, value) as Result<PluginManifest, ForgeError>;
}

/**
 * A loaded plugin: its manifest plus the runtime objects it registered.
 * The host constructs this; a manifest alone contributes nothing.
 */
export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly workflowNodes?: readonly NodeTypeDefinition[];
  readonly aiTools?: readonly AssistantTool[];
  /** Called once when the plugin is enabled. */
  readonly activate?: (host: PluginHost) => Promise<void> | void;
  readonly deactivate?: () => Promise<void> | void;
}

/** The capability surface a plugin receives, scoped by its permissions. */
export interface PluginHost {
  readonly pluginId: string;
  readonly permissions: ReadonlySet<PluginPermission>;
  /** Throws if the plugin lacks the permission. */
  require(permission: PluginPermission): void;
  log(message: string, fields?: Record<string, unknown>): void;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly enabled = new Set<string>();

  get all(): LoadedPlugin[] {
    return [...this.plugins.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  }

  get active(): LoadedPlugin[] {
    return this.all.filter((plugin) => this.enabled.has(plugin.manifest.id));
  }

  get(id: string): LoadedPlugin | undefined {
    return this.plugins.get(id);
  }

  isEnabled(id: string): boolean {
    return this.enabled.has(id);
  }

  /**
   * Register a plugin. Contribution ids are namespaced by the plugin id, so two
   * plugins can both contribute a command called `refresh` without colliding.
   */
  register(plugin: LoadedPlugin): void {
    const { id } = plugin.manifest;
    if (this.plugins.has(id)) {
      throw conflict(`Plugin '${id}' is already registered`, { pluginId: id });
    }

    for (const command of plugin.manifest.contributes?.commands ?? []) {
      if (!command.id.startsWith(`${id}.`)) {
        throw invalidInput(
          `Command '${command.id}' must be namespaced as '${id}.<name>'`,
          { pluginId: id, commandId: command.id }
        );
      }
    }

    for (const node of plugin.workflowNodes ?? []) {
      if (!node.type.startsWith(`${id}.`)) {
        throw invalidInput(
          `Workflow node '${node.type}' must be namespaced as '${id}.<name>'`,
          { pluginId: id, nodeType: node.type }
        );
      }
    }

    // A plugin that contributes an AI tool must hold `ai:complete`; otherwise it
    // could reach the model layer through a contribution it was never granted.
    if ((plugin.aiTools?.length ?? 0) > 0 && !plugin.manifest.permissions.includes('ai:complete')) {
      throw invalidInput(`Plugin '${id}' contributes AI tools without the 'ai:complete' permission`, {
        pluginId: id,
      });
    }

    this.plugins.set(id, plugin);
  }

  async enable(id: string, createHost: (plugin: LoadedPlugin) => PluginHost): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin) throw invalidInput(`Unknown plugin '${id}'`);
    if (this.enabled.has(id)) return;
    await plugin.activate?.(createHost(plugin));
    this.enabled.add(id);
  }

  async disable(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin || !this.enabled.has(id)) return;
    await plugin.deactivate?.();
    this.enabled.delete(id);
  }

  /** Workflow nodes contributed by enabled plugins. */
  workflowNodes(): NodeTypeDefinition[] {
    return this.active.flatMap((plugin) => [...(plugin.workflowNodes ?? [])]);
  }

  /** AI tools contributed by enabled plugins. */
  aiTools(): AssistantTool[] {
    return this.active.flatMap((plugin) => [...(plugin.aiTools ?? [])]);
  }

  /** Commands contributed by enabled plugins, for the command palette. */
  commands(): (CommandContribution & { pluginId: string })[] {
    return this.active.flatMap((plugin) =>
      (plugin.manifest.contributes?.commands ?? []).map((command) => ({
        ...command,
        pluginId: plugin.manifest.id,
      }))
    );
  }

  panels(surface?: PanelContribution['surface']): (PanelContribution & { pluginId: string })[] {
    return this.active.flatMap((plugin) =>
      (plugin.manifest.contributes?.panels ?? [])
        .filter((panel) => !surface || panel.surface === surface)
        .map((panel) => ({ ...panel, pluginId: plugin.manifest.id }))
    );
  }

  widgets(): (WidgetContribution & { pluginId: string })[] {
    return this.active.flatMap((plugin) =>
      (plugin.manifest.contributes?.widgets ?? []).map((widget) => ({
        ...widget,
        pluginId: plugin.manifest.id,
      }))
    );
  }
}

/** Build a permission-scoped host for a plugin. */
export function createPluginHost(
  plugin: LoadedPlugin,
  log: (message: string, fields?: Record<string, unknown>) => void
): PluginHost {
  const permissions = new Set(plugin.manifest.permissions);
  return {
    pluginId: plugin.manifest.id,
    permissions,
    require(permission) {
      if (!permissions.has(permission)) {
        throw invalidInput(
          `Plugin '${plugin.manifest.id}' requires the '${permission}' permission, which it did not declare`,
          { pluginId: plugin.manifest.id, permission }
        );
      }
    },
    log(message, fields) {
      log(`[${plugin.manifest.id}] ${message}`, fields);
    },
  };
}

/**
 * Human-readable explanation of what a plugin will be able to do.
 * Shown before installation, because "grants 5 permissions" tells nobody
 * anything useful.
 */
export const PERMISSION_DESCRIPTIONS: Readonly<Record<PluginPermission, string>> = {
  'repository:read': 'Read your repositories, files and analysis results',
  'repository:write': 'Add, re-analyse or remove repositories',
  'documents:read': 'Read generated and hand-written documentation',
  'documents:write': 'Create and edit documentation',
  'memory:read': 'Read your workspace memory',
  'memory:write': 'Store new memories in your workspace',
  'workflows:read': 'Read workflow definitions and run history',
  'workflows:execute': 'Run workflows on your behalf',
  'api:read': 'Read API specifications',
  'api:write': 'Create and modify API specifications',
  'security:read': 'Read security reports and findings',
  'benchmarks:read': 'Read evaluation results',
  'benchmarks:execute': 'Run evaluations, which may incur model costs',
  'network:fetch': 'Make outbound network requests',
  'ai:complete': 'Send prompts to configured AI models, which may incur costs',
};

export function describePermissions(manifest: PluginManifest): string[] {
  return manifest.permissions.map((permission) => PERMISSION_DESCRIPTIONS[permission]);
}
