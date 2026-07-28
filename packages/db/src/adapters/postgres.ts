import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  Activity,
  ApiKey,
  AuditEntry,
  Comment,
  Conversation,
  ConversationMessage,
  DocumentVersion,
  ListOptions,
  Membership,
  Notification,
  Project,
  StoredAnalysis,
  StoredApiSpec,
  StoredBenchmark,
  StoredDocument,
  StoredSecurityReport,
  StoredWorkflow,
  StoredWorkflowRun,
  Store,
  User,
  Workspace,
} from '../types.js';
import type { Memory } from '@forgeos/core';

/**
 * PostgreSQL storage.
 *
 * `pg` is imported dynamically so that the package remains usable — and
 * bundleable for the browser or edge — when no database is configured. The
 * driver is only ever loaded on the path that actually needs it.
 *
 * Most entities live in one `records` table keyed by `collection`. That is a
 * deliberate trade: the domain model is still young, and a per-entity table per
 * feature would mean a migration for every product change. The fields that are
 * actually queried — workspace, collection, parent, timestamps — are real
 * indexed columns, so this is not a key-value store pretending to be a database.
 */
type Collection =
  | 'analysis'
  | 'document'
  | 'documentVersion'
  | 'benchmark'
  | 'workflow'
  | 'workflowRun'
  | 'apiSpec'
  | 'securityReport'
  | 'conversation'
  | 'message'
  | 'activity'
  | 'comment'
  | 'notification';

interface QueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

interface PoolLike {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  end(): Promise<void>;
}

interface RecordRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  created_at: string | number;
  updated_at: string | number;
  data: unknown;
}

export interface PostgresOptions {
  readonly connectionString: string;
  /** Run `schema.sql` on init. Default true. */
  readonly migrate?: boolean;
  readonly ssl?: boolean;
  readonly maxConnections?: number;
}

export class PostgresStore implements Store {
  readonly kind: Store['kind'] = 'postgres';
  private pool: PoolLike | null = null;
  private vectorAvailable = false;

  constructor(private readonly options: PostgresOptions) {}

  private get db(): PoolLike {
    if (!this.pool) throw new Error('PostgresStore.init() must be awaited before use');
    return this.pool;
  }

  async init(): Promise<void> {
    // Dynamic import keeps `pg` out of every bundle that does not use it.
    const pg = (await import('pg')) as unknown as {
      default?: { Pool: new (config: Record<string, unknown>) => PoolLike };
      Pool?: new (config: Record<string, unknown>) => PoolLike;
    };
    const Pool = pg.Pool ?? pg.default?.Pool;
    if (!Pool) throw new Error("The 'pg' package is required for DATABASE_URL support");

    this.pool = new Pool({
      connectionString: this.options.connectionString,
      max: this.options.maxConnections ?? 10,
      ...(this.options.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    });

    if (this.options.migrate !== false) {
      const here = dirname(fileURLToPath(import.meta.url));
      // dist/adapters -> package root
      const schemaPath = join(here, '..', '..', 'schema.sql');
      const sql = await readFile(schemaPath, 'utf8').catch(() => null);
      if (sql) await this.db.query(sql);
    }

    const probe = await this.db
      .query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS exists"
      )
      .catch(() => null);
    this.vectorAvailable = probe?.rows[0]?.exists ?? false;
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  async healthy(): Promise<boolean> {
    try {
      await this.db.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /** True when pgvector is installed and semantic search is exact. */
  get supportsVectorSearch(): boolean {
    return this.vectorAvailable;
  }

  // --- Generic record helpers ---
  private async putRecord<T extends { id: string; workspaceId: string; createdAt: number }>(
    collection: Collection,
    record: T,
    parentId?: string
  ): Promise<T> {
    const updatedAt = (record as { updatedAt?: number }).updatedAt ?? record.createdAt;
    await this.db.query(
      `INSERT INTO records (id, workspace_id, collection, parent_id, created_at, updated_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE
         SET data = EXCLUDED.data,
             parent_id = EXCLUDED.parent_id,
             updated_at = EXCLUDED.updated_at`,
      [record.id, record.workspaceId, collection, parentId ?? null, record.createdAt, updatedAt, JSON.stringify(record)]
    );
    return record;
  }

  private async getRecord<T>(
    collection: Collection,
    workspaceId: string,
    id: string
  ): Promise<T | null> {
    const result = await this.db.query<RecordRow>(
      'SELECT data FROM records WHERE id = $1 AND workspace_id = $2 AND collection = $3',
      [id, workspaceId, collection]
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }

  private async listRecords<T>(
    collection: Collection,
    workspaceId: string,
    options?: ListOptions & { parentId?: string; orderBy?: 'created' | 'updated' }
  ): Promise<T[]> {
    const order = options?.orderBy === 'updated' ? 'updated_at' : 'created_at';
    const values: unknown[] = [workspaceId, collection];
    let where = 'workspace_id = $1 AND collection = $2';
    if (options?.parentId) {
      values.push(options.parentId);
      where += ` AND parent_id = $${values.length}`;
    }
    values.push(options?.limit ?? 100, options?.offset ?? 0);

    const result = await this.db.query<RecordRow>(
      `SELECT data FROM records WHERE ${where}
       ORDER BY ${order} DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return result.rows.map((row) => row.data as T);
  }

  private async deleteRecord(
    collection: Collection,
    workspaceId: string,
    id: string
  ): Promise<boolean> {
    const result = await this.db.query(
      'DELETE FROM records WHERE id = $1 AND workspace_id = $2 AND collection = $3',
      [id, workspaceId, collection]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // --- Identity ---
  async upsertUser(user: User): Promise<User> {
    await this.db.query(
      `INSERT INTO users (id, email, name, avatar_url, created_at, data)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name,
         avatar_url = EXCLUDED.avatar_url, data = EXCLUDED.data`,
      [user.id, user.email, user.name, user.avatarUrl ?? null, user.createdAt, JSON.stringify(user)]
    );
    return user;
  }

  async getUser(id: string): Promise<User | null> {
    const result = await this.db.query<{ data: User }>('SELECT data FROM users WHERE id = $1', [id]);
    return result.rows[0]?.data ?? null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const result = await this.db.query<{ data: User }>(
      'SELECT data FROM users WHERE lower(email) = lower($1)',
      [email]
    );
    return result.rows[0]?.data ?? null;
  }

  // --- Workspaces ---
  async createWorkspace(workspace: Workspace): Promise<Workspace> {
    await this.db.query(
      `INSERT INTO workspaces (id, slug, name, owner_id, created_at, updated_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug,
         updated_at = EXCLUDED.updated_at, data = EXCLUDED.data`,
      [
        workspace.id,
        workspace.slug,
        workspace.name,
        workspace.ownerId,
        workspace.createdAt,
        workspace.updatedAt,
        JSON.stringify(workspace),
      ]
    );
    return workspace;
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const result = await this.db.query<{ data: Workspace }>(
      'SELECT data FROM workspaces WHERE id = $1',
      [id]
    );
    return result.rows[0]?.data ?? null;
  }

  async getWorkspaceBySlug(slug: string): Promise<Workspace | null> {
    const result = await this.db.query<{ data: Workspace }>(
      'SELECT data FROM workspaces WHERE slug = $1',
      [slug]
    );
    return result.rows[0]?.data ?? null;
  }

  async listWorkspacesForUser(userId: string): Promise<Workspace[]> {
    const result = await this.db.query<{ data: Workspace }>(
      `SELECT w.data FROM workspaces w
       JOIN memberships m ON m.workspace_id = w.id
       WHERE m.user_id = $1
       ORDER BY w.name ASC`,
      [userId]
    );
    return result.rows.map((row) => row.data);
  }

  async updateWorkspace(id: string, patch: Partial<Workspace>): Promise<Workspace | null> {
    const existing = await this.getWorkspace(id);
    if (!existing) return null;
    return this.createWorkspace({ ...existing, ...patch, id, updatedAt: Date.now() });
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM workspaces WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  // --- Membership ---
  async addMember(membership: Membership): Promise<Membership> {
    await this.db.query(
      `INSERT INTO memberships (workspace_id, user_id, role, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [membership.workspaceId, membership.userId, membership.role, membership.createdAt]
    );
    return membership;
  }

  async getMembership(workspaceId: string, userId: string): Promise<Membership | null> {
    const result = await this.db.query<{
      workspace_id: string;
      user_id: string;
      role: Membership['role'];
      created_at: string;
    }>('SELECT * FROM memberships WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId]);
    const row = result.rows[0];
    return row
      ? {
          workspaceId: row.workspace_id,
          userId: row.user_id,
          role: row.role,
          createdAt: Number(row.created_at),
        }
      : null;
  }

  async listMembers(workspaceId: string): Promise<Membership[]> {
    const result = await this.db.query<{
      workspace_id: string;
      user_id: string;
      role: Membership['role'];
      created_at: string;
    }>('SELECT * FROM memberships WHERE workspace_id = $1', [workspaceId]);
    return result.rows.map((row) => ({
      workspaceId: row.workspace_id,
      userId: row.user_id,
      role: row.role,
      createdAt: Number(row.created_at),
    }));
  }

  async removeMember(workspaceId: string, userId: string): Promise<boolean> {
    const result = await this.db.query(
      'DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // --- Projects ---
  async createProject(project: Project): Promise<Project> {
    await this.db.query(
      `INSERT INTO projects (id, workspace_id, slug, name, created_at, updated_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug,
         updated_at = EXCLUDED.updated_at, data = EXCLUDED.data`,
      [
        project.id,
        project.workspaceId,
        project.slug,
        project.name,
        project.createdAt,
        project.updatedAt,
        JSON.stringify(project),
      ]
    );
    return project;
  }

  async getProject(workspaceId: string, id: string): Promise<Project | null> {
    const result = await this.db.query<{ data: Project }>(
      'SELECT data FROM projects WHERE id = $1 AND workspace_id = $2',
      [id, workspaceId]
    );
    return result.rows[0]?.data ?? null;
  }

  async listProjects(workspaceId: string, options?: ListOptions): Promise<Project[]> {
    const result = await this.db.query<{ data: Project }>(
      `SELECT data FROM projects WHERE workspace_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [workspaceId, options?.limit ?? 100, options?.offset ?? 0]
    );
    return result.rows.map((row) => row.data);
  }

  async updateProject(
    workspaceId: string,
    id: string,
    patch: Partial<Project>
  ): Promise<Project | null> {
    const existing = await this.getProject(workspaceId, id);
    if (!existing) return null;
    return this.createProject({ ...existing, ...patch, id, workspaceId, updatedAt: Date.now() });
  }

  async deleteProject(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.db.query(
      'DELETE FROM projects WHERE id = $1 AND workspace_id = $2',
      [id, workspaceId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // --- Analyses ---
  async saveAnalysis(analysis: StoredAnalysis): Promise<StoredAnalysis> {
    return this.putRecord('analysis', analysis, analysis.projectId);
  }

  async getAnalysis(workspaceId: string, id: string): Promise<StoredAnalysis | null> {
    return this.getRecord<StoredAnalysis>('analysis', workspaceId, id);
  }

  async getLatestAnalysis(workspaceId: string, projectId: string): Promise<StoredAnalysis | null> {
    const [latest] = await this.listRecords<StoredAnalysis>('analysis', workspaceId, {
      parentId: projectId,
      limit: 1,
    });
    return latest ?? null;
  }

  async listAnalyses(
    workspaceId: string,
    projectId: string,
    options?: ListOptions
  ): Promise<StoredAnalysis[]> {
    return this.listRecords<StoredAnalysis>('analysis', workspaceId, {
      ...options,
      parentId: projectId,
    });
  }

  // --- Documents ---
  async saveDocument(document: StoredDocument): Promise<StoredDocument> {
    return this.putRecord('document', document, document.projectId);
  }

  async getDocument(workspaceId: string, id: string): Promise<StoredDocument | null> {
    return this.getRecord<StoredDocument>('document', workspaceId, id);
  }

  async listDocuments(
    workspaceId: string,
    options?: ListOptions & { projectId?: string }
  ): Promise<StoredDocument[]> {
    return this.listRecords<StoredDocument>('document', workspaceId, {
      ...options,
      ...(options?.projectId ? { parentId: options.projectId } : {}),
      orderBy: 'updated',
    });
  }

  async deleteDocument(workspaceId: string, id: string): Promise<boolean> {
    return this.deleteRecord('document', workspaceId, id);
  }

  async saveDocumentVersion(version: DocumentVersion): Promise<DocumentVersion> {
    await this.db.query(
      `INSERT INTO records (id, workspace_id, collection, parent_id, created_at, updated_at, data)
       SELECT $1, workspace_id, 'documentVersion', $2, $3, $3, $4 FROM records WHERE id = $2
       ON CONFLICT (id) DO NOTHING`,
      [version.id, version.documentId, version.createdAt, JSON.stringify(version)]
    );
    return version;
  }

  async listDocumentVersions(documentId: string): Promise<DocumentVersion[]> {
    const result = await this.db.query<RecordRow>(
      `SELECT data FROM records WHERE collection = 'documentVersion' AND parent_id = $1
       ORDER BY created_at DESC LIMIT 200`,
      [documentId]
    );
    return result.rows.map((row) => row.data as DocumentVersion);
  }

  // --- Memory ---
  async saveMemory(memory: Memory): Promise<Memory> {
    const embedding = memory.embedding ? `[${memory.embedding.join(',')}]` : null;
    const columns = this.vectorAvailable
      ? `(id, workspace_id, project_id, kind, content, importance, access_count, created_at, updated_at, data, embedding)`
      : `(id, workspace_id, project_id, kind, content, importance, access_count, created_at, updated_at, data)`;
    const placeholders = this.vectorAvailable
      ? '$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11'
      : '$1, $2, $3, $4, $5, $6, $7, $8, $9, $10';

    const values: unknown[] = [
      memory.id,
      memory.workspaceId,
      memory.projectId ?? null,
      memory.kind,
      memory.content,
      memory.importance,
      memory.accessCount,
      memory.createdAt,
      memory.updatedAt,
      JSON.stringify(memory),
    ];
    if (this.vectorAvailable) values.push(embedding);

    await this.db.query(
      `INSERT INTO memories ${columns} VALUES (${placeholders})
       ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, data = EXCLUDED.data,
         importance = EXCLUDED.importance, access_count = EXCLUDED.access_count,
         updated_at = EXCLUDED.updated_at`,
      values
    );
    return memory;
  }

  async listMemories(workspaceId: string, options?: ListOptions): Promise<Memory[]> {
    const result = await this.db.query<{ data: Memory }>(
      `SELECT data FROM memories WHERE workspace_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [workspaceId, options?.limit ?? 200, options?.offset ?? 0]
    );
    return result.rows.map((row) => row.data);
  }

  async deleteMemory(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.db.query(
      'DELETE FROM memories WHERE id = $1 AND workspace_id = $2',
      [id, workspaceId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Vector similarity search, pushed into the database.
   *
   * Only usable when pgvector is installed; callers must check
   * {@link supportsVectorSearch} and fall back to in-process retrieval
   * otherwise. Returning wrong results silently would be far worse than
   * returning none.
   */
  async searchMemoriesByVector(
    workspaceId: string,
    embedding: readonly number[],
    limit = 10
  ): Promise<{ memory: Memory; similarity: number }[]> {
    if (!this.vectorAvailable) return [];
    const result = await this.db.query<{ data: Memory; similarity: string }>(
      `SELECT data, 1 - (embedding <=> $2::vector) AS similarity
       FROM memories
       WHERE workspace_id = $1 AND embedding IS NOT NULL
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      [workspaceId, `[${embedding.join(',')}]`, limit]
    );
    return result.rows.map((row) => ({ memory: row.data, similarity: Number(row.similarity) }));
  }

  // --- Benchmarks / workflows / specs / security ---
  async saveBenchmark(benchmark: StoredBenchmark): Promise<StoredBenchmark> {
    return this.putRecord('benchmark', benchmark);
  }
  async getBenchmark(workspaceId: string, id: string): Promise<StoredBenchmark | null> {
    return this.getRecord<StoredBenchmark>('benchmark', workspaceId, id);
  }
  async listBenchmarks(workspaceId: string, options?: ListOptions): Promise<StoredBenchmark[]> {
    return this.listRecords<StoredBenchmark>('benchmark', workspaceId, options);
  }

  async saveWorkflow(workflow: StoredWorkflow): Promise<StoredWorkflow> {
    return this.putRecord('workflow', workflow);
  }
  async getWorkflow(workspaceId: string, id: string): Promise<StoredWorkflow | null> {
    return this.getRecord<StoredWorkflow>('workflow', workspaceId, id);
  }
  async listWorkflows(workspaceId: string, options?: ListOptions): Promise<StoredWorkflow[]> {
    return this.listRecords<StoredWorkflow>('workflow', workspaceId, {
      ...options,
      orderBy: 'updated',
    });
  }
  async deleteWorkflow(workspaceId: string, id: string): Promise<boolean> {
    return this.deleteRecord('workflow', workspaceId, id);
  }
  async saveWorkflowRun(run: StoredWorkflowRun): Promise<StoredWorkflowRun> {
    return this.putRecord('workflowRun', run, run.workflowId);
  }
  async listWorkflowRuns(
    workspaceId: string,
    workflowId?: string,
    options?: ListOptions
  ): Promise<StoredWorkflowRun[]> {
    return this.listRecords<StoredWorkflowRun>('workflowRun', workspaceId, {
      ...options,
      ...(workflowId ? { parentId: workflowId } : {}),
    });
  }

  async saveApiSpec(spec: StoredApiSpec): Promise<StoredApiSpec> {
    return this.putRecord('apiSpec', spec, spec.projectId);
  }
  async getApiSpec(workspaceId: string, id: string): Promise<StoredApiSpec | null> {
    return this.getRecord<StoredApiSpec>('apiSpec', workspaceId, id);
  }
  async listApiSpecs(workspaceId: string, options?: ListOptions): Promise<StoredApiSpec[]> {
    return this.listRecords<StoredApiSpec>('apiSpec', workspaceId, {
      ...options,
      orderBy: 'updated',
    });
  }
  async deleteApiSpec(workspaceId: string, id: string): Promise<boolean> {
    return this.deleteRecord('apiSpec', workspaceId, id);
  }

  async saveSecurityReport(report: StoredSecurityReport): Promise<StoredSecurityReport> {
    return this.putRecord('securityReport', report, report.projectId);
  }
  async listSecurityReports(
    workspaceId: string,
    projectId?: string,
    options?: ListOptions
  ): Promise<StoredSecurityReport[]> {
    return this.listRecords<StoredSecurityReport>('securityReport', workspaceId, {
      ...options,
      ...(projectId ? { parentId: projectId } : {}),
    });
  }

  // --- Conversations ---
  async saveConversation(conversation: Conversation): Promise<Conversation> {
    return this.putRecord('conversation', conversation);
  }
  async getConversation(workspaceId: string, id: string): Promise<Conversation | null> {
    return this.getRecord<Conversation>('conversation', workspaceId, id);
  }
  async listConversations(workspaceId: string, options?: ListOptions): Promise<Conversation[]> {
    return this.listRecords<Conversation>('conversation', workspaceId, {
      ...options,
      orderBy: 'updated',
    });
  }
  async saveMessage(message: ConversationMessage): Promise<ConversationMessage> {
    await this.db.query(
      `INSERT INTO records (id, workspace_id, collection, parent_id, created_at, updated_at, data)
       SELECT $1, workspace_id, 'message', $2, $3, $3, $4 FROM records WHERE id = $2
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [message.id, message.conversationId, message.createdAt, JSON.stringify(message)]
    );
    return message;
  }
  async listMessages(conversationId: string): Promise<ConversationMessage[]> {
    const result = await this.db.query<RecordRow>(
      `SELECT data FROM records WHERE collection = 'message' AND parent_id = $1
       ORDER BY created_at ASC LIMIT 500`,
      [conversationId]
    );
    return result.rows.map((row) => row.data as ConversationMessage);
  }

  // --- Collaboration ---
  async recordActivity(activity: Activity): Promise<Activity> {
    return this.putRecord('activity', activity, activity.targetId);
  }
  async listActivity(workspaceId: string, options?: ListOptions): Promise<Activity[]> {
    return this.listRecords<Activity>('activity', workspaceId, options);
  }
  async saveComment(comment: Comment): Promise<Comment> {
    return this.putRecord('comment', comment, comment.target);
  }
  async listComments(workspaceId: string, target: string): Promise<Comment[]> {
    const records = await this.listRecords<Comment>('comment', workspaceId, {
      parentId: target,
      limit: 500,
    });
    return records.sort((a, b) => a.createdAt - b.createdAt);
  }
  async deleteComment(workspaceId: string, id: string): Promise<boolean> {
    return this.deleteRecord('comment', workspaceId, id);
  }
  async saveNotification(notification: Notification): Promise<Notification> {
    return this.putRecord('notification', notification, notification.userId);
  }
  async listNotifications(
    workspaceId: string,
    userId: string,
    options?: ListOptions
  ): Promise<Notification[]> {
    return this.listRecords<Notification>('notification', workspaceId, {
      ...options,
      parentId: userId,
    });
  }
  async markNotificationRead(id: string, at: number): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE records SET data = jsonb_set(data, '{readAt}', to_jsonb($2::bigint))
       WHERE id = $1 AND collection = 'notification'`,
      [id, at]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // --- Keys and audit ---
  async saveApiKey(key: ApiKey): Promise<ApiKey> {
    await this.db.query(
      `INSERT INTO api_keys (id, workspace_id, name, hash, prefix, scopes, created_at, created_by, last_used_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET last_used_at = EXCLUDED.last_used_at, name = EXCLUDED.name`,
      [
        key.id,
        key.workspaceId,
        key.name,
        key.hash,
        key.prefix,
        key.scopes,
        key.createdAt,
        key.createdBy,
        key.lastUsedAt ?? null,
        key.expiresAt ?? null,
      ]
    );
    return key;
  }

  private mapApiKey(row: Record<string, unknown>): ApiKey {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      hash: String(row.hash),
      prefix: String(row.prefix),
      scopes: (row.scopes as string[] | null) ?? [],
      createdAt: Number(row.created_at),
      createdBy: String(row.created_by),
      ...(row.last_used_at ? { lastUsedAt: Number(row.last_used_at) } : {}),
      ...(row.expires_at ? { expiresAt: Number(row.expires_at) } : {}),
    };
  }

  async listApiKeys(workspaceId: string): Promise<ApiKey[]> {
    const result = await this.db.query<Record<string, unknown>>(
      'SELECT * FROM api_keys WHERE workspace_id = $1 ORDER BY created_at DESC',
      [workspaceId]
    );
    return result.rows.map((row) => this.mapApiKey(row));
  }

  async findApiKeyByHash(hash: string): Promise<ApiKey | null> {
    const result = await this.db.query<Record<string, unknown>>(
      'SELECT * FROM api_keys WHERE hash = $1',
      [hash]
    );
    const row = result.rows[0];
    return row ? this.mapApiKey(row) : null;
  }

  async deleteApiKey(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.db.query(
      'DELETE FROM api_keys WHERE id = $1 AND workspace_id = $2',
      [id, workspaceId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recordAudit(entry: AuditEntry): Promise<AuditEntry> {
    await this.db.query(
      `INSERT INTO audit_log (id, workspace_id, actor_id, action, target, created_at, ip, user_agent, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.id,
        entry.workspaceId,
        entry.actorId,
        entry.action,
        entry.target ?? null,
        entry.createdAt,
        entry.ip ?? null,
        entry.userAgent ?? null,
        JSON.stringify(entry.meta ?? {}),
      ]
    );
    return entry;
  }

  async listAudit(workspaceId: string, options?: ListOptions): Promise<AuditEntry[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM audit_log WHERE workspace_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [workspaceId, options?.limit ?? 100, options?.offset ?? 0]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      actorId: String(row.actor_id),
      action: String(row.action),
      ...(row.target ? { target: String(row.target) } : {}),
      createdAt: Number(row.created_at),
      ...(row.ip ? { ip: String(row.ip) } : {}),
      ...(row.user_agent ? { userAgent: String(row.user_agent) } : {}),
      meta: (row.meta as Record<string, unknown>) ?? {},
    }));
  }
}
