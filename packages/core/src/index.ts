/**
 * `@forgeos/core` — the ForgeOS kernel.
 *
 * Every engine in the platform lives here, with **zero runtime dependencies**,
 * so the same code runs in a Next.js server component, an edge function, a CLI,
 * a test, or a plugin sandbox. Node built-ins are confined to `fs/node`, which
 * is the only module that will not load in a browser.
 */

// --- Kernel ---
export * from './kernel/result.js';
export * from './kernel/errors.js';
export * from './kernel/id.js';
export * from './kernel/hash.js';
export * from './kernel/logger.js';
export * from './kernel/schema.js';
export * from './kernel/semver.js';
export * from './kernel/text.js';
export * from './kernel/jsonc.js';

// --- Filesystem and snapshots ---
export * from './fs/types.js';
export * from './fs/ignore.js';
export * from './fs/scan.js';

// --- Repository analysis ---
export * from './analysis/languages.js';
export * from './analysis/complexity.js';
export * from './analysis/imports.js';
export * from './analysis/manifests.js';
export * from './analysis/stack.js';
export * from './analysis/environment.js';
export * from './analysis/debt.js';
export * from './analysis/repository.js';

// --- Graph and visualisation ---
export * from './graph/module-graph.js';
export * from './graph/mermaid.js';
export * from './graph/schema-extract.js';
export * from './graph/api-surface.js';

// --- Security ---
export * from './security/secrets.js';
export * from './security/patterns.js';
export * from './security/advisories.js';
export * from './security/report.js';

// --- Documentation ---
export * from './docs/generate.js';

// --- Search ---
export * from './search/index.js';

// --- Memory ---
export * from './memory/embedding.js';
export * from './memory/store.js';
export * from './memory/knowledge-graph.js';

// --- AI ---
export * from './ai/types.js';
export * from './ai/local.js';
export * from './ai/openrouter.js';
export * from './ai/registry.js';
export * from './ai/assistant.js';

// --- Evaluation ---
export * from './eval/harness.js';

// --- Workflows ---
export * from './workflow/expression.js';
export * from './workflow/engine.js';

// --- API platform ---
export * from './api/openapi.js';
export * from './api/mock.js';
export * from './api/codegen.js';

// --- Automation ---
export * from './automation/commits.js';
export * from './automation/review.js';

// --- Plugins ---
export * from './plugins/registry.js';

/** The version of the kernel, surfaced in the health endpoint and the UI. */
export const FORGEOS_CORE_VERSION = '0.1.0';
