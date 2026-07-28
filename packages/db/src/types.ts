import type {
  BenchmarkRun,
  GeneratedDocument,
  Memory,
  RepositoryAnalysis,
  SecurityReport,
  Workflow,
  WorkflowRun,
  ApiSpec,
} from '@forgeos/core';

/**
 * The ForgeOS domain model.
 *
 * Every record is scoped to a workspace. That is not decoration — the storage
 * adapters take `workspaceId` as a mandatory argument on every read, so a
 * missing tenant filter is a compile error rather than a data leak discovered
 * in production.
 */
export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly avatarUrl?: string;
  readonly createdAt: number;
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly ownerId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly settings?: Readonly<Record<string, unknown>>;
}

export interface Membership {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: Role;
  readonly createdAt: number;
}

export interface Project {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  /** Absolute path, archive reference or remote URL. */
  readonly source: string;
  readonly sourceKind: 'local' | 'archive' | 'remote' | 'sample';
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastAnalysedAt?: number;
  readonly defaultBranch?: string;
}

export interface StoredAnalysis {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly createdAt: number;
  readonly revision?: string;
  readonly analysis: RepositoryAnalysis;
}

export interface StoredDocument {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId?: string;
  readonly kind: GeneratedDocument['kind'] | 'custom';
  readonly title: string;
  readonly markdown: string;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly authorId: string;
  readonly hash: string;
  readonly gaps?: readonly string[];
}

export interface DocumentVersion {
  readonly id: string;
  readonly documentId: string;
  readonly version: number;
  readonly markdown: string;
  readonly createdAt: number;
  readonly authorId: string;
  readonly note?: string;
}

export interface StoredBenchmark {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly createdAt: number;
  readonly run: BenchmarkRun;
}

export interface StoredWorkflow {
  readonly id: string;
  readonly workspaceId: string;
  readonly definition: Workflow;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly enabled: boolean;
  readonly lastRunAt?: number;
}

export interface StoredWorkflowRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly createdAt: number;
  readonly run: WorkflowRun;
}

export interface StoredApiSpec {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId?: string;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly spec: ApiSpec;
}

export interface StoredSecurityReport {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly createdAt: number;
  readonly report: SecurityReport;
}

export interface Conversation {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly userId: string;
  readonly projectId?: string;
}

export interface ConversationMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly createdAt: number;
  readonly model?: string;
  readonly costUsd?: number;
  readonly citations?: readonly { title: string; href: string; kind: string }[];
}

export type ActivityKind =
  | 'project.created'
  | 'project.analysed'
  | 'document.created'
  | 'document.updated'
  | 'benchmark.completed'
  | 'workflow.created'
  | 'workflow.run'
  | 'security.scanned'
  | 'api.created'
  | 'memory.created'
  | 'comment.created'
  | 'member.joined';

export interface Activity {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: ActivityKind;
  readonly actorId: string;
  readonly summary: string;
  readonly createdAt: number;
  readonly targetId?: string;
  readonly targetHref?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface Comment {
  readonly id: string;
  readonly workspaceId: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** What the comment is attached to: `document:doc_123`, `finding:fnd_9`. */
  readonly target: string;
  readonly parentId?: string;
  readonly mentions?: readonly string[];
  readonly resolved?: boolean;
}

export interface Notification {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly title: string;
  readonly body: string;
  readonly href?: string;
  readonly createdAt: number;
  readonly readAt?: number;
  readonly kind: 'mention' | 'assignment' | 'run' | 'security' | 'system';
}

export interface ApiKey {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  /** Only ever a hash. The plaintext key is shown once, at creation. */
  readonly hash: string;
  readonly prefix: string;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly lastUsedAt?: number;
  readonly expiresAt?: number;
  readonly scopes: readonly string[];
}

export interface AuditEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly action: string;
  readonly target?: string;
  readonly createdAt: number;
  readonly ip?: string;
  readonly userAgent?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface ListOptions {
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * The storage contract.
 *
 * Implemented three ways — in memory, on the filesystem, and on PostgreSQL —
 * which keeps the application layer honest: nothing above this interface may
 * assume SQL, transactions, or a particular id generator.
 */
export interface Store {
  readonly kind: 'memory' | 'file' | 'postgres';

  init(): Promise<void>;
  close(): Promise<void>;
  healthy(): Promise<boolean>;

  // Identity
  upsertUser(user: User): Promise<User>;
  getUser(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;

  // Workspaces
  createWorkspace(workspace: Workspace): Promise<Workspace>;
  getWorkspace(id: string): Promise<Workspace | null>;
  getWorkspaceBySlug(slug: string): Promise<Workspace | null>;
  listWorkspacesForUser(userId: string): Promise<Workspace[]>;
  updateWorkspace(id: string, patch: Partial<Workspace>): Promise<Workspace | null>;
  deleteWorkspace(id: string): Promise<boolean>;

  // Membership
  addMember(membership: Membership): Promise<Membership>;
  getMembership(workspaceId: string, userId: string): Promise<Membership | null>;
  listMembers(workspaceId: string): Promise<Membership[]>;
  removeMember(workspaceId: string, userId: string): Promise<boolean>;

  // Projects
  createProject(project: Project): Promise<Project>;
  getProject(workspaceId: string, id: string): Promise<Project | null>;
  listProjects(workspaceId: string, options?: ListOptions): Promise<Project[]>;
  updateProject(workspaceId: string, id: string, patch: Partial<Project>): Promise<Project | null>;
  deleteProject(workspaceId: string, id: string): Promise<boolean>;

  // Analyses
  saveAnalysis(analysis: StoredAnalysis): Promise<StoredAnalysis>;
  getAnalysis(workspaceId: string, id: string): Promise<StoredAnalysis | null>;
  getLatestAnalysis(workspaceId: string, projectId: string): Promise<StoredAnalysis | null>;
  listAnalyses(workspaceId: string, projectId: string, options?: ListOptions): Promise<StoredAnalysis[]>;

  // Documents
  saveDocument(document: StoredDocument): Promise<StoredDocument>;
  getDocument(workspaceId: string, id: string): Promise<StoredDocument | null>;
  listDocuments(workspaceId: string, options?: ListOptions & { projectId?: string }): Promise<StoredDocument[]>;
  deleteDocument(workspaceId: string, id: string): Promise<boolean>;
  saveDocumentVersion(version: DocumentVersion): Promise<DocumentVersion>;
  listDocumentVersions(documentId: string): Promise<DocumentVersion[]>;

  // Memory
  saveMemory(memory: Memory): Promise<Memory>;
  listMemories(workspaceId: string, options?: ListOptions): Promise<Memory[]>;
  deleteMemory(workspaceId: string, id: string): Promise<boolean>;

  // Benchmarks
  saveBenchmark(benchmark: StoredBenchmark): Promise<StoredBenchmark>;
  getBenchmark(workspaceId: string, id: string): Promise<StoredBenchmark | null>;
  listBenchmarks(workspaceId: string, options?: ListOptions): Promise<StoredBenchmark[]>;

  // Workflows
  saveWorkflow(workflow: StoredWorkflow): Promise<StoredWorkflow>;
  getWorkflow(workspaceId: string, id: string): Promise<StoredWorkflow | null>;
  listWorkflows(workspaceId: string, options?: ListOptions): Promise<StoredWorkflow[]>;
  deleteWorkflow(workspaceId: string, id: string): Promise<boolean>;
  saveWorkflowRun(run: StoredWorkflowRun): Promise<StoredWorkflowRun>;
  listWorkflowRuns(workspaceId: string, workflowId?: string, options?: ListOptions): Promise<StoredWorkflowRun[]>;

  // API specs
  saveApiSpec(spec: StoredApiSpec): Promise<StoredApiSpec>;
  getApiSpec(workspaceId: string, id: string): Promise<StoredApiSpec | null>;
  listApiSpecs(workspaceId: string, options?: ListOptions): Promise<StoredApiSpec[]>;
  deleteApiSpec(workspaceId: string, id: string): Promise<boolean>;

  // Security
  saveSecurityReport(report: StoredSecurityReport): Promise<StoredSecurityReport>;
  listSecurityReports(workspaceId: string, projectId?: string, options?: ListOptions): Promise<StoredSecurityReport[]>;

  // Conversations
  saveConversation(conversation: Conversation): Promise<Conversation>;
  getConversation(workspaceId: string, id: string): Promise<Conversation | null>;
  listConversations(workspaceId: string, options?: ListOptions): Promise<Conversation[]>;
  saveMessage(message: ConversationMessage): Promise<ConversationMessage>;
  listMessages(conversationId: string): Promise<ConversationMessage[]>;

  // Collaboration
  recordActivity(activity: Activity): Promise<Activity>;
  listActivity(workspaceId: string, options?: ListOptions): Promise<Activity[]>;
  saveComment(comment: Comment): Promise<Comment>;
  listComments(workspaceId: string, target: string): Promise<Comment[]>;
  deleteComment(workspaceId: string, id: string): Promise<boolean>;
  saveNotification(notification: Notification): Promise<Notification>;
  listNotifications(workspaceId: string, userId: string, options?: ListOptions): Promise<Notification[]>;
  markNotificationRead(id: string, at: number): Promise<boolean>;

  // Keys and audit
  saveApiKey(key: ApiKey): Promise<ApiKey>;
  listApiKeys(workspaceId: string): Promise<ApiKey[]>;
  findApiKeyByHash(hash: string): Promise<ApiKey | null>;
  deleteApiKey(workspaceId: string, id: string): Promise<boolean>;
  recordAudit(entry: AuditEntry): Promise<AuditEntry>;
  listAudit(workspaceId: string, options?: ListOptions): Promise<AuditEntry[]>;
}
