import 'server-only';
import { createStore, describeStore, type Store, type Workspace, type User } from '@forgeos/db';
import {
  createLogger,
  createRegistry,
  createId,
  slugify,
  MemoryStore as SemanticMemory,
  type ModelRegistry,
  type Logger,
} from '@forgeos/core';

/**
 * The server context: one lazily-created singleton per process.
 *
 * Next.js may evaluate a module many times across route handlers and render
 * passes. Creating a store per evaluation would fragment state and, with the
 * file adapter, race on writes — so construction is memoised on `globalThis`,
 * which survives hot reloads in development.
 */
export interface ServerContext {
  readonly store: Store;
  readonly registry: ModelRegistry;
  readonly memory: SemanticMemory;
  readonly logger: Logger;
  readonly startedAt: number;
}

declare global {
   
  var __forgeos__: Promise<ServerContext> | undefined;
}

/** The single-user identity used when Clerk is not configured. */
export const LOCAL_USER: User = {
  id: 'usr_local',
  email: 'you@localhost',
  name: 'Local developer',
  createdAt: 0,
};

const DEFAULT_WORKSPACE_NAME = 'Personal workspace';

async function bootstrap(): Promise<ServerContext> {
  const logger = createLogger({
    level: (process.env.FORGEOS_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
    scope: 'forgeos',
  });

  const store = createStore({
    DATABASE_URL: process.env.DATABASE_URL,
    FORGEOS_DATA_DIR: process.env.FORGEOS_DATA_DIR,
    FORGEOS_EPHEMERAL: process.env.FORGEOS_EPHEMERAL,
  });

  await store.init();
  logger.info('storage ready', { backend: describeStore(store) });

  const registry = createRegistry({
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
    FORGEOS_DEFAULT_MODEL: process.env.FORGEOS_DEFAULT_MODEL,
    NEXT_PUBLIC_FORGEOS_URL: process.env.NEXT_PUBLIC_FORGEOS_URL,
  });

  // Rehydrate semantic memory so retrieval works immediately after a restart.
  const memory = new SemanticMemory();

  return { store, registry, memory, logger, startedAt: Date.now() };
}

export function getContext(): Promise<ServerContext> {
  globalThis.__forgeos__ ??= bootstrap();
  return globalThis.__forgeos__;
}

/**
 * Resolve the acting user.
 *
 * With Clerk configured, identity comes from the verified session and the local
 * fallback is refused outright — a deployment with auth enabled must never
 * silently serve an anonymous user as if they were signed in.
 */
export async function getCurrentUser(): Promise<User> {
  const clerkConfigured =
    Boolean(process.env.CLERK_SECRET_KEY) && Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  if (!clerkConfigured) return LOCAL_USER;

  // Loaded dynamically so the dependency is optional at build time.
  const clerk = (await import('@clerk/nextjs/server').catch(() => null)) as {
    currentUser?: () => Promise<{
      id: string;
      firstName?: string | null;
      lastName?: string | null;
      imageUrl?: string;
      emailAddresses?: { emailAddress: string }[];
      createdAt?: number;
    } | null>;
  } | null;

  const account = await clerk?.currentUser?.();
  if (!account) {
    throw Object.assign(new Error('Authentication required'), { status: 401 });
  }

  return {
    id: account.id,
    email: account.emailAddresses?.[0]?.emailAddress ?? 'unknown@example.com',
    name: [account.firstName, account.lastName].filter(Boolean).join(' ') || 'Member',
    ...(account.imageUrl ? { avatarUrl: account.imageUrl } : {}),
    createdAt: account.createdAt ?? Date.now(),
  };
}

/**
 * The workspace for the current request.
 *
 * Honours the `x-forgeos-workspace` header (used by the SDK and API keys), then
 * falls back to the user's first workspace, creating one on first run so the
 * product is never empty on a fresh install.
 */
export async function getActiveWorkspace(requestedId?: string | null): Promise<Workspace> {
  const { store } = await getContext();
  const user = await getCurrentUser();

  await store.upsertUser({ ...user, createdAt: user.createdAt || Date.now() });

  if (requestedId) {
    const membership = await store.getMembership(requestedId, user.id);
    const workspace = await store.getWorkspace(requestedId);
    if (workspace && membership) return workspace;
    // Falling through rather than throwing keeps a stale client-side selection
    // from locking the user out of their own account.
  }

  const existing = await store.listWorkspacesForUser(user.id);
  if (existing[0]) return existing[0];

  const now = Date.now();
  const workspace: Workspace = {
    id: createId('wsp', now),
    name: DEFAULT_WORKSPACE_NAME,
    slug: slugify(DEFAULT_WORKSPACE_NAME, 'workspace'),
    ownerId: user.id,
    createdAt: now,
    updatedAt: now,
  };

  await store.createWorkspace(workspace);
  await store.addMember({
    workspaceId: workspace.id,
    userId: user.id,
    role: 'owner',
    createdAt: now,
  });

  // Seed the bundled sample here rather than in a layout. Next renders layouts
  // and pages concurrently, so a layout-level seed races the page's own read and
  // the first paint shows an empty workspace.
  await store.createProject({
    id: createId('repo', now),
    workspaceId: workspace.id,
    name: 'Sample: orders-service',
    slug: 'sample-orders-service',
    description:
      'A small but complete service bundled with ForgeOS so every module has real data to work with on first run.',
    source: 'sample',
    sourceKind: 'sample',
    createdAt: now,
    updatedAt: now,
  });

  return workspace;
}

/** Load persisted memories into the in-process semantic index, once. */
export async function hydrateMemory(workspaceId: string): Promise<SemanticMemory> {
  const { store, memory } = await getContext();
  if (memory.size === 0) {
    memory.load(await store.listMemories(workspaceId, { limit: 2000 }));
  }
  return memory;
}

export interface RuntimeStatus {
  readonly storage: string;
  readonly ai: string[];
  readonly defaultModel: string;
  readonly auth: 'clerk' | 'local';
  readonly cache: 'redis' | 'in-process';
  readonly jobs: 'trigger.dev' | 'inline';
}

/** What is actually wired up right now — surfaced in the UI and in /api/system/health. */
export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  const { store, registry } = await getContext();
  return {
    storage: describeStore(store),
    ai: registry.providerIds,
    defaultModel: registry.defaultModel,
    auth: process.env.CLERK_SECRET_KEY ? 'clerk' : 'local',
    cache: process.env.REDIS_URL ? 'redis' : 'in-process',
    jobs: process.env.TRIGGER_SECRET_KEY ? 'trigger.dev' : 'inline',
  };
}
