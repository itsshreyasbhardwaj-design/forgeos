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
 * In-memory storage.
 *
 * This is the reference implementation of {@link Store}: the file adapter
 * inherits from it and adds durability, and the PostgreSQL adapter is tested
 * against the same behavioural suite. Keeping one canonical implementation is
 * what stops the three backends from quietly diverging.
 */
export interface Snapshot {
  users: User[];
  workspaces: Workspace[];
  memberships: Membership[];
  projects: Project[];
  analyses: StoredAnalysis[];
  documents: StoredDocument[];
  documentVersions: DocumentVersion[];
  memories: Memory[];
  benchmarks: StoredBenchmark[];
  workflows: StoredWorkflow[];
  workflowRuns: StoredWorkflowRun[];
  apiSpecs: StoredApiSpec[];
  securityReports: StoredSecurityReport[];
  conversations: Conversation[];
  messages: ConversationMessage[];
  activity: Activity[];
  comments: Comment[];
  notifications: Notification[];
  apiKeys: ApiKey[];
  audit: AuditEntry[];
}

export function emptySnapshot(): Snapshot {
  return {
    users: [],
    workspaces: [],
    memberships: [],
    projects: [],
    analyses: [],
    documents: [],
    documentVersions: [],
    memories: [],
    benchmarks: [],
    workflows: [],
    workflowRuns: [],
    apiSpecs: [],
    securityReports: [],
    conversations: [],
    messages: [],
    activity: [],
    comments: [],
    notifications: [],
    apiKeys: [],
    audit: [],
  };
}

function page<T>(items: readonly T[], options?: ListOptions): T[] {
  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? 100;
  return items.slice(offset, offset + limit);
}

/** Replace an existing record with the same id, or append. */
function upsert<T extends { id: string }>(collection: T[], record: T): T {
  const index = collection.findIndex((existing) => existing.id === record.id);
  if (index >= 0) collection[index] = record;
  else collection.push(record);
  return record;
}

function remove<T extends { id: string }>(collection: T[], predicate: (item: T) => boolean): boolean {
  const index = collection.findIndex(predicate);
  if (index < 0) return false;
  collection.splice(index, 1);
  return true;
}

const byNewest = <T extends { createdAt: number }>(a: T, b: T): number => b.createdAt - a.createdAt;

export class MemoryStore implements Store {
  readonly kind: Store['kind'] = 'memory';
  protected data: Snapshot;

  constructor(initial: Snapshot = emptySnapshot()) {
    this.data = initial;
  }

  /** Hook for subclasses that persist. Called after every mutation. */
  protected async persist(): Promise<void> {
    // The in-memory store is already durable for its lifetime.
  }

  async init(): Promise<void> {
    // Nothing to prepare.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  export(): Snapshot {
    return this.data;
  }

  // --- Identity ---
  async upsertUser(user: User): Promise<User> {
    upsert(this.data.users, user);
    await this.persist();
    return user;
  }

  async getUser(id: string): Promise<User | null> {
    return this.data.users.find((user) => user.id === id) ?? null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const target = email.toLowerCase();
    return this.data.users.find((user) => user.email.toLowerCase() === target) ?? null;
  }

  // --- Workspaces ---
  async createWorkspace(workspace: Workspace): Promise<Workspace> {
    upsert(this.data.workspaces, workspace);
    await this.persist();
    return workspace;
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    return this.data.workspaces.find((workspace) => workspace.id === id) ?? null;
  }

  async getWorkspaceBySlug(slug: string): Promise<Workspace | null> {
    return this.data.workspaces.find((workspace) => workspace.slug === slug) ?? null;
  }

  async listWorkspacesForUser(userId: string): Promise<Workspace[]> {
    const ids = new Set(
      this.data.memberships.filter((m) => m.userId === userId).map((m) => m.workspaceId)
    );
    return this.data.workspaces
      .filter((workspace) => ids.has(workspace.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async updateWorkspace(id: string, patch: Partial<Workspace>): Promise<Workspace | null> {
    const existing = await this.getWorkspace(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id, updatedAt: Date.now() };
    upsert(this.data.workspaces, updated);
    await this.persist();
    return updated;
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    const deleted = remove(this.data.workspaces, (workspace) => workspace.id === id);
    if (deleted) {
      // Cascade: orphaned tenant data is a privacy problem, not just clutter.
      this.data.memberships = this.data.memberships.filter((m) => m.workspaceId !== id);
      this.data.projects = this.data.projects.filter((p) => p.workspaceId !== id);
      this.data.analyses = this.data.analyses.filter((a) => a.workspaceId !== id);
      this.data.documents = this.data.documents.filter((d) => d.workspaceId !== id);
      this.data.memories = this.data.memories.filter((m) => m.workspaceId !== id);
      this.data.benchmarks = this.data.benchmarks.filter((b) => b.workspaceId !== id);
      this.data.workflows = this.data.workflows.filter((w) => w.workspaceId !== id);
      this.data.workflowRuns = this.data.workflowRuns.filter((r) => r.workspaceId !== id);
      this.data.apiSpecs = this.data.apiSpecs.filter((s) => s.workspaceId !== id);
      this.data.securityReports = this.data.securityReports.filter((r) => r.workspaceId !== id);
      this.data.conversations = this.data.conversations.filter((c) => c.workspaceId !== id);
      this.data.activity = this.data.activity.filter((a) => a.workspaceId !== id);
      this.data.comments = this.data.comments.filter((c) => c.workspaceId !== id);
      this.data.notifications = this.data.notifications.filter((n) => n.workspaceId !== id);
      this.data.apiKeys = this.data.apiKeys.filter((k) => k.workspaceId !== id);
      await this.persist();
    }
    return deleted;
  }

  // --- Membership ---
  async addMember(membership: Membership): Promise<Membership> {
    const index = this.data.memberships.findIndex(
      (m) => m.workspaceId === membership.workspaceId && m.userId === membership.userId
    );
    if (index >= 0) this.data.memberships[index] = membership;
    else this.data.memberships.push(membership);
    await this.persist();
    return membership;
  }

  async getMembership(workspaceId: string, userId: string): Promise<Membership | null> {
    return (
      this.data.memberships.find((m) => m.workspaceId === workspaceId && m.userId === userId) ?? null
    );
  }

  async listMembers(workspaceId: string): Promise<Membership[]> {
    return this.data.memberships.filter((m) => m.workspaceId === workspaceId);
  }

  async removeMember(workspaceId: string, userId: string): Promise<boolean> {
    const before = this.data.memberships.length;
    this.data.memberships = this.data.memberships.filter(
      (m) => !(m.workspaceId === workspaceId && m.userId === userId)
    );
    const changed = this.data.memberships.length !== before;
    if (changed) await this.persist();
    return changed;
  }

  // --- Projects ---
  async createProject(project: Project): Promise<Project> {
    upsert(this.data.projects, project);
    await this.persist();
    return project;
  }

  async getProject(workspaceId: string, id: string): Promise<Project | null> {
    return (
      this.data.projects.find((p) => p.id === id && p.workspaceId === workspaceId) ?? null
    );
  }

  async listProjects(workspaceId: string, options?: ListOptions): Promise<Project[]> {
    return page(
      this.data.projects.filter((p) => p.workspaceId === workspaceId).sort(byNewest),
      options
    );
  }

  async updateProject(
    workspaceId: string,
    id: string,
    patch: Partial<Project>
  ): Promise<Project | null> {
    const existing = await this.getProject(workspaceId, id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id, workspaceId, updatedAt: Date.now() };
    upsert(this.data.projects, updated);
    await this.persist();
    return updated;
  }

  async deleteProject(workspaceId: string, id: string): Promise<boolean> {
    const deleted = remove(this.data.projects, (p) => p.id === id && p.workspaceId === workspaceId);
    if (deleted) {
      this.data.analyses = this.data.analyses.filter((a) => a.projectId !== id);
      this.data.securityReports = this.data.securityReports.filter((r) => r.projectId !== id);
      await this.persist();
    }
    return deleted;
  }

  // --- Analyses ---
  async saveAnalysis(analysis: StoredAnalysis): Promise<StoredAnalysis> {
    upsert(this.data.analyses, analysis);
    await this.persist();
    return analysis;
  }

  async getAnalysis(workspaceId: string, id: string): Promise<StoredAnalysis | null> {
    return this.data.analyses.find((a) => a.id === id && a.workspaceId === workspaceId) ?? null;
  }

  async getLatestAnalysis(workspaceId: string, projectId: string): Promise<StoredAnalysis | null> {
    return (
      this.data.analyses
        .filter((a) => a.workspaceId === workspaceId && a.projectId === projectId)
        .sort(byNewest)[0] ?? null
    );
  }

  async listAnalyses(
    workspaceId: string,
    projectId: string,
    options?: ListOptions
  ): Promise<StoredAnalysis[]> {
    return page(
      this.data.analyses
        .filter((a) => a.workspaceId === workspaceId && a.projectId === projectId)
        .sort(byNewest),
      options
    );
  }

  // --- Documents ---
  async saveDocument(document: StoredDocument): Promise<StoredDocument> {
    upsert(this.data.documents, document);
    await this.persist();
    return document;
  }

  async getDocument(workspaceId: string, id: string): Promise<StoredDocument | null> {
    return this.data.documents.find((d) => d.id === id && d.workspaceId === workspaceId) ?? null;
  }

  async listDocuments(
    workspaceId: string,
    options?: ListOptions & { projectId?: string }
  ): Promise<StoredDocument[]> {
    return page(
      this.data.documents
        .filter(
          (d) =>
            d.workspaceId === workspaceId &&
            (!options?.projectId || d.projectId === options.projectId)
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
      options
    );
  }

  async deleteDocument(workspaceId: string, id: string): Promise<boolean> {
    const deleted = remove(this.data.documents, (d) => d.id === id && d.workspaceId === workspaceId);
    if (deleted) {
      this.data.documentVersions = this.data.documentVersions.filter((v) => v.documentId !== id);
      await this.persist();
    }
    return deleted;
  }

  async saveDocumentVersion(version: DocumentVersion): Promise<DocumentVersion> {
    upsert(this.data.documentVersions, version);
    await this.persist();
    return version;
  }

  async listDocumentVersions(documentId: string): Promise<DocumentVersion[]> {
    return this.data.documentVersions
      .filter((v) => v.documentId === documentId)
      .sort((a, b) => b.version - a.version);
  }

  // --- Memory ---
  async saveMemory(memory: Memory): Promise<Memory> {
    upsert(this.data.memories as { id: string }[] as Memory[], memory);
    await this.persist();
    return memory;
  }

  async listMemories(workspaceId: string, options?: ListOptions): Promise<Memory[]> {
    return page(
      this.data.memories
        .filter((m) => m.workspaceId === workspaceId)
        .sort((a, b) => b.createdAt - a.createdAt),
      options
    );
  }

  async deleteMemory(workspaceId: string, id: string): Promise<boolean> {
    const deleted = remove(
      this.data.memories as { id: string }[] as Memory[],
      (m) => m.id === id && m.workspaceId === workspaceId
    );
    if (deleted) await this.persist();
    return deleted;
  }

  // --- Benchmarks ---
  async saveBenchmark(benchmark: StoredBenchmark): Promise<StoredBenchmark> {
    upsert(this.data.benchmarks, benchmark);
    await this.persist();
    return benchmark;
  }

  async getBenchmark(workspaceId: string, id: string): Promise<StoredBenchmark | null> {
    return this.data.benchmarks.find((b) => b.id === id && b.workspaceId === workspaceId) ?? null;
  }

  async listBenchmarks(workspaceId: string, options?: ListOptions): Promise<StoredBenchmark[]> {
    return page(
      this.data.benchmarks.filter((b) => b.workspaceId === workspaceId).sort(byNewest),
      options
    );
  }

  // --- Workflows ---
  async saveWorkflow(workflow: StoredWorkflow): Promise<StoredWorkflow> {
    upsert(this.data.workflows, workflow);
    await this.persist();
    return workflow;
  }

  async getWorkflow(workspaceId: string, id: string): Promise<StoredWorkflow | null> {
    return this.data.workflows.find((w) => w.id === id && w.workspaceId === workspaceId) ?? null;
  }

  async listWorkflows(workspaceId: string, options?: ListOptions): Promise<StoredWorkflow[]> {
    return page(
      this.data.workflows
        .filter((w) => w.workspaceId === workspaceId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
      options
    );
  }

  async deleteWorkflow(workspaceId: string, id: string): Promise<boolean> {
    const deleted = remove(this.data.workflows, (w) => w.id === id && w.workspaceId === workspaceId);
    if (deleted) {
      this.data.workflowRuns = this.data.workflowRuns.filter((r) => r.workflowId !== id);
      await this.persist();
    }
    return deleted;
  }

  async saveWorkflowRun(run: StoredWorkflowRun): Promise<StoredWorkflowRun> {
    upsert(this.data.workflowRuns, run);
    await this.persist();
    return run;
  }

  async listWorkflowRuns(
    workspaceId: string,
    workflowId?: string,
    options?: ListOptions
  ): Promise<StoredWorkflowRun[]> {
    return page(
      this.data.workflowRuns
        .filter((r) => r.workspaceId === workspaceId && (!workflowId || r.workflowId === workflowId))
        .sort(byNewest),
      options
    );
  }

  // --- API specs ---
  async saveApiSpec(spec: StoredApiSpec): Promise<StoredApiSpec> {
    upsert(this.data.apiSpecs, spec);
    await this.persist();
    return spec;
  }

  async getApiSpec(workspaceId: string, id: string): Promise<StoredApiSpec | null> {
    return this.data.apiSpecs.find((s) => s.id === id && s.workspaceId === workspaceId) ?? null;
  }

  async listApiSpecs(workspaceId: string, options?: ListOptions): Promise<StoredApiSpec[]> {
    return page(
      this.data.apiSpecs
        .filter((s) => s.workspaceId === workspaceId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
      options
    );
  }

  async deleteApiSpec(workspaceId: string, id: string): Promise<boolean> {
    const deleted = remove(this.data.apiSpecs, (s) => s.id === id && s.workspaceId === workspaceId);
    if (deleted) await this.persist();
    return deleted;
  }

  // --- Security ---
  async saveSecurityReport(report: StoredSecurityReport): Promise<StoredSecurityReport> {
    upsert(this.data.securityReports, report);
    await this.persist();
    return report;
  }

  async listSecurityReports(
    workspaceId: string,
    projectId?: string,
    options?: ListOptions
  ): Promise<StoredSecurityReport[]> {
    return page(
      this.data.securityReports
        .filter((r) => r.workspaceId === workspaceId && (!projectId || r.projectId === projectId))
        .sort(byNewest),
      options
    );
  }

  // --- Conversations ---
  async saveConversation(conversation: Conversation): Promise<Conversation> {
    upsert(this.data.conversations, conversation);
    await this.persist();
    return conversation;
  }

  async getConversation(workspaceId: string, id: string): Promise<Conversation | null> {
    return (
      this.data.conversations.find((c) => c.id === id && c.workspaceId === workspaceId) ?? null
    );
  }

  async listConversations(workspaceId: string, options?: ListOptions): Promise<Conversation[]> {
    return page(
      this.data.conversations
        .filter((c) => c.workspaceId === workspaceId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
      options
    );
  }

  async saveMessage(message: ConversationMessage): Promise<ConversationMessage> {
    upsert(this.data.messages, message);
    await this.persist();
    return message;
  }

  async listMessages(conversationId: string): Promise<ConversationMessage[]> {
    return this.data.messages
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  // --- Collaboration ---
  async recordActivity(activity: Activity): Promise<Activity> {
    this.data.activity.unshift(activity);
    // The feed is a rolling window; unbounded growth serves nobody.
    if (this.data.activity.length > 5000) this.data.activity.length = 5000;
    await this.persist();
    return activity;
  }

  async listActivity(workspaceId: string, options?: ListOptions): Promise<Activity[]> {
    return page(
      this.data.activity.filter((a) => a.workspaceId === workspaceId).sort(byNewest),
      options
    );
  }

  async saveComment(comment: Comment): Promise<Comment> {
    upsert(this.data.comments, comment);
    await this.persist();
    return comment;
  }

  async listComments(workspaceId: string, target: string): Promise<Comment[]> {
    return this.data.comments
      .filter((c) => c.workspaceId === workspaceId && c.target === target)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async deleteComment(workspaceId: string, id: string): Promise<boolean> {
    const deleted = remove(this.data.comments, (c) => c.id === id && c.workspaceId === workspaceId);
    if (deleted) await this.persist();
    return deleted;
  }

  async saveNotification(notification: Notification): Promise<Notification> {
    upsert(this.data.notifications, notification);
    await this.persist();
    return notification;
  }

  async listNotifications(
    workspaceId: string,
    userId: string,
    options?: ListOptions
  ): Promise<Notification[]> {
    return page(
      this.data.notifications
        .filter((n) => n.workspaceId === workspaceId && n.userId === userId)
        .sort(byNewest),
      options
    );
  }

  async markNotificationRead(id: string, at: number): Promise<boolean> {
    const index = this.data.notifications.findIndex((n) => n.id === id);
    if (index < 0) return false;
    this.data.notifications[index] = {
      ...(this.data.notifications[index] as Notification),
      readAt: at,
    };
    await this.persist();
    return true;
  }

  // --- Keys and audit ---
  async saveApiKey(key: ApiKey): Promise<ApiKey> {
    upsert(this.data.apiKeys, key);
    await this.persist();
    return key;
  }

  async listApiKeys(workspaceId: string): Promise<ApiKey[]> {
    return this.data.apiKeys.filter((k) => k.workspaceId === workspaceId).sort(byNewest);
  }

  async findApiKeyByHash(hash: string): Promise<ApiKey | null> {
    return this.data.apiKeys.find((k) => k.hash === hash) ?? null;
  }

  async deleteApiKey(workspaceId: string, id: string): Promise<boolean> {
    const deleted = remove(this.data.apiKeys, (k) => k.id === id && k.workspaceId === workspaceId);
    if (deleted) await this.persist();
    return deleted;
  }

  async recordAudit(entry: AuditEntry): Promise<AuditEntry> {
    this.data.audit.unshift(entry);
    if (this.data.audit.length > 20_000) this.data.audit.length = 20_000;
    await this.persist();
    return entry;
  }

  async listAudit(workspaceId: string, options?: ListOptions): Promise<AuditEntry[]> {
    return page(
      this.data.audit.filter((a) => a.workspaceId === workspaceId).sort(byNewest),
      options
    );
  }
}
