import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from './adapters/file.js';
import { MemoryStore, emptySnapshot } from './adapters/memory.js';
import { createStore, describeStore } from './index.js';
import type { Membership, Project, Store, User, Workspace } from './types.js';

/**
 * One behavioural suite, run against every adapter.
 *
 * This is what keeps the three backends from diverging: the in-memory store is
 * the reference implementation, and any adapter that claims to implement
 * `Store` has to satisfy the same assertions.
 */
const user: User = { id: 'usr_1', email: 'a@example.com', name: 'A', createdAt: 1 };

const workspace: Workspace = {
  id: 'wsp_1',
  name: 'Workspace',
  slug: 'workspace',
  ownerId: user.id,
  createdAt: 1,
  updatedAt: 1,
};

const membership: Membership = {
  workspaceId: workspace.id,
  userId: user.id,
  role: 'owner',
  createdAt: 1,
};

const project: Project = {
  id: 'repo_1',
  workspaceId: workspace.id,
  name: 'Demo',
  slug: 'demo',
  source: '/tmp/demo',
  sourceKind: 'local',
  createdAt: 2,
  updatedAt: 2,
};

function suite(name: string, create: () => Promise<Store>, cleanup?: () => Promise<void>) {
  describe(name, () => {
    let store: Store;

    beforeEach(async () => {
      store = await create();
      await store.init();
      await store.upsertUser(user);
      await store.createWorkspace(workspace);
      await store.addMember(membership);
    });

    afterEach(async () => {
      await store.close();
      await cleanup?.();
    });

    it('round-trips a user by id and by email', async () => {
      expect((await store.getUser(user.id))?.email).toBe(user.email);
      expect((await store.getUserByEmail('A@EXAMPLE.COM'))?.id).toBe(user.id);
      expect(await store.getUser('missing')).toBeNull();
    });

    it('lists only the workspaces a user belongs to', async () => {
      await store.createWorkspace({ ...workspace, id: 'wsp_other', slug: 'other' });
      const listed = await store.listWorkspacesForUser(user.id);
      expect(listed.map((entry) => entry.id)).toEqual(['wsp_1']);
    });

    it('scopes reads to a workspace', async () => {
      await store.createProject(project);
      expect(await store.getProject(workspace.id, project.id)).not.toBeNull();
      // The same id under a different workspace must not resolve.
      expect(await store.getProject('wsp_other', project.id)).toBeNull();
    });

    it('updates a project without losing untouched fields', async () => {
      await store.createProject(project);
      const updated = await store.updateProject(workspace.id, project.id, { lastAnalysedAt: 99 });
      expect(updated?.lastAnalysedAt).toBe(99);
      expect(updated?.name).toBe('Demo');
      expect(await store.updateProject(workspace.id, 'missing', {})).toBeNull();
    });

    it('paginates lists', async () => {
      for (let i = 0; i < 5; i++) {
        await store.createProject({ ...project, id: `repo_${i}`, createdAt: 10 + i });
      }
      expect(await store.listProjects(workspace.id, { limit: 2 })).toHaveLength(2);
      expect(await store.listProjects(workspace.id, { limit: 2, offset: 4 })).toHaveLength(1);
    });

    it('stores and retrieves documents with versions', async () => {
      await store.saveDocument({
        id: 'doc_1',
        workspaceId: workspace.id,
        kind: 'readme',
        title: 'README',
        markdown: '# v1',
        version: 1,
        createdAt: 3,
        updatedAt: 3,
        authorId: user.id,
        hash: 'h1',
      });
      await store.saveDocumentVersion({
        id: 'dvr_1',
        documentId: 'doc_1',
        version: 1,
        markdown: '# v1',
        createdAt: 3,
        authorId: user.id,
      });

      expect((await store.getDocument(workspace.id, 'doc_1'))?.markdown).toBe('# v1');
      expect(await store.listDocumentVersions('doc_1')).toHaveLength(1);
      expect(await store.deleteDocument(workspace.id, 'doc_1')).toBe(true);
      // Deleting the document must take its versions with it.
      expect(await store.listDocumentVersions('doc_1')).toHaveLength(0);
    });

    it('keeps the activity feed newest-first', async () => {
      for (const at of [10, 30, 20]) {
        await store.recordActivity({
          id: `act_${at}`,
          workspaceId: workspace.id,
          kind: 'project.created',
          actorId: user.id,
          summary: `at ${at}`,
          createdAt: at,
        });
      }
      const feed = await store.listActivity(workspace.id);
      expect(feed.map((entry) => entry.createdAt)).toEqual([30, 20, 10]);
    });

    it('finds an API key by its hash and deletes it', async () => {
      await store.saveApiKey({
        id: 'key_1',
        workspaceId: workspace.id,
        name: 'CI',
        hash: 'hashed',
        prefix: 'fk_abc',
        createdAt: 4,
        createdBy: user.id,
        scopes: ['read'],
      });
      expect((await store.findApiKeyByHash('hashed'))?.id).toBe('key_1');
      expect(await store.listApiKeys(workspace.id)).toHaveLength(1);
      expect(await store.deleteApiKey(workspace.id, 'key_1')).toBe(true);
      expect(await store.findApiKeyByHash('hashed')).toBeNull();
    });

    it('orders conversation messages oldest-first', async () => {
      await store.saveConversation({
        id: 'cnv_1',
        workspaceId: workspace.id,
        title: 'Chat',
        createdAt: 1,
        updatedAt: 1,
        userId: user.id,
      });
      await store.saveMessage({ id: 'm2', conversationId: 'cnv_1', role: 'assistant', content: 'second', createdAt: 20 });
      await store.saveMessage({ id: 'm1', conversationId: 'cnv_1', role: 'user', content: 'first', createdAt: 10 });

      expect((await store.listMessages('cnv_1')).map((m) => m.content)).toEqual(['first', 'second']);
    });

    it('cascades a workspace deletion', async () => {
      await store.createProject(project);
      expect(await store.deleteWorkspace(workspace.id)).toBe(true);
      expect(await store.getWorkspace(workspace.id)).toBeNull();
      expect(await store.listProjects(workspace.id)).toHaveLength(0);
    });

    it('reports itself healthy', async () => {
      expect(await store.healthy()).toBe(true);
    });
  });
}

suite('MemoryStore', async () => new MemoryStore(emptySnapshot()));

describe('FileStore', () => {
  let directory: string;

  it('persists across instances and survives a corrupt file', async () => {
    directory = await mkdtemp(join(tmpdir(), 'forgeos-test-'));

    const first = new FileStore(directory);
    await first.init();
    await first.upsertUser(user);
    await first.createWorkspace(workspace);
    await first.addMember(membership);
    await first.createProject(project);
    await first.close();

    // A second instance must see everything the first wrote.
    const second = new FileStore(directory);
    await second.init();
    expect((await second.getProject(workspace.id, project.id))?.name).toBe('Demo');
    await second.close();

    // A corrupt file must not take the application down.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(directory, 'forgeos.json'), '{ not json', 'utf8');

    const third = new FileStore(directory);
    await third.init();
    expect(await third.listProjects(workspace.id)).toHaveLength(0);
    expect(await third.healthy()).toBe(true);
    await third.close();

    await rm(directory, { recursive: true, force: true });
  });
});

// Run the shared suite against the file adapter too.
suite(
  'FileStore (shared behaviour)',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'forgeos-suite-'));
    const store = new FileStore(directory);
    (store as unknown as { __directory: string }).__directory = directory;
    return store;
  },
  async () => undefined
);

describe('adapter selection', () => {
  it('defaults to file storage with no configuration', () => {
    const store = createStore({});
    expect(store.kind).toBe('file');
    expect(describeStore(store)).toContain('file');
  });

  it('uses PostgreSQL when a connection string is present', () => {
    const store = createStore({ DATABASE_URL: 'postgres://localhost/forgeos' });
    expect(store.kind).toBe('postgres');
  });

  it('honours an explicit request for ephemeral storage', () => {
    expect(createStore({ FORGEOS_EPHEMERAL: '1' }).kind).toBe('memory');
  });
});
