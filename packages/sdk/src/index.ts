/**
 * `@forgeos/sdk` — the official TypeScript client for the ForgeOS REST API.
 *
 * Zero dependencies, isomorphic (`fetch` only), and typed end to end. Designed
 * so that the failure path is as ergonomic as the happy path: every error is a
 * {@link ForgeApiError} carrying the machine-readable code the server sent, not
 * a stringified status.
 */
export interface ForgeOSClientOptions {
  /** Base URL of a ForgeOS instance, e.g. `https://forge.example.com`. */
  readonly baseUrl?: string;
  /** API key created under Settings → API keys. Sent as a bearer token. */
  readonly apiKey?: string;
  /** Workspace all requests are scoped to. Required for workspace resources. */
  readonly workspaceId?: string;
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  /** Request timeout in milliseconds. Default 60s. */
  readonly timeoutMs?: number;
  /** Retries for transient failures (429, 5xx). Default 2. */
  readonly retries?: number;
}

export class ForgeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = 'ForgeApiError';
  }

  /** True when retrying the same request could plausibly succeed. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly source: string;
  readonly createdAt: number;
  readonly lastAnalysedAt?: number;
}

export interface AnalysisSummaryDto {
  readonly id: string;
  readonly name: string;
  readonly primaryLanguage: string | null;
  readonly stackSummary: string;
  readonly files: number;
  readonly code: number;
  readonly healthScore: number;
  readonly grade: string;
  readonly criticalFindings: number;
  readonly cycles: number;
  readonly routes: number;
  readonly entities: number;
  readonly collectedAt: number;
}

export interface SearchResultDto {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly href: string;
  readonly excerpt: string;
  readonly score: number;
}

export interface AskResponse {
  readonly text: string;
  readonly citations: readonly { title: string; href: string; kind: string }[];
  readonly model: string;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly conversationId: string;
}

const DEFAULT_TIMEOUT = 60_000;

export class ForgeOSClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly workspaceId: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(options: ForgeOSClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.workspaceId = options.workspaceId;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.headers = { ...options.headers };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    this.retries = options.retries ?? 2;
  }

  /** A copy of this client scoped to a different workspace. */
  withWorkspace(workspaceId: string): ForgeOSClient {
    return new ForgeOSClient({
      baseUrl: this.baseUrl,
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      workspaceId,
      fetch: this.fetchImpl,
      headers: this.headers,
      timeoutMs: this.timeoutMs,
      retries: this.retries,
    });
  }

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown; signal?: AbortSignal } = {}
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/api${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    let lastError: ForgeApiError | null = null;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

      try {
        const response = await this.fetchImpl(url.toString(), {
          method,
          headers: {
            'content-type': 'application/json',
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
            ...(this.workspaceId ? { 'x-forgeos-workspace': this.workspaceId } : {}),
            ...this.headers,
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        });

        const text = await response.text();
        const payload = text ? safeJson(text) : null;

        if (response.ok) return payload as T;

        const error = payload as { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
        lastError = new ForgeApiError(
          response.status,
          error?.error?.code ?? 'unknown',
          error?.error?.message ?? `${method} ${path} failed with ${response.status}`,
          error?.error?.details ?? {}
        );

        if (!lastError.retryable || attempt === this.retries) throw lastError;
        // Exponential backoff with a ceiling; a 429 is not helped by hammering.
        await sleep(Math.min(4000, 250 * 2 ** attempt));
      } catch (error) {
        if (error instanceof ForgeApiError) {
          if (!error.retryable || attempt === this.retries) throw error;
          continue;
        }
        if (attempt === this.retries) {
          throw new ForgeApiError(0, 'network_error', (error as Error).message);
        }
        await sleep(Math.min(4000, 250 * 2 ** attempt));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new ForgeApiError(0, 'unknown', 'Request failed');
  }

  // --- System ---
  health(): Promise<{ status: string; version: string; storage: string; ai: string[] }> {
    return this.request('GET', '/system/health');
  }

  // --- Projects ---
  listProjects(options: { limit?: number; offset?: number } = {}): Promise<Page<ProjectSummary>> {
    return this.request('GET', '/projects', { query: options });
  }

  getProject(id: string): Promise<ProjectSummary> {
    return this.request('GET', `/projects/${encodeURIComponent(id)}`);
  }

  createProject(input: { name: string; source: string; description?: string }): Promise<ProjectSummary> {
    return this.request('POST', '/projects', { body: input });
  }

  deleteProject(id: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/projects/${encodeURIComponent(id)}`);
  }

  /** Run analysis. Returns the summary; fetch the full analysis separately. */
  analyseProject(id: string): Promise<AnalysisSummaryDto> {
    return this.request('POST', `/projects/${encodeURIComponent(id)}/analyze`);
  }

  getAnalysis(projectId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/projects/${encodeURIComponent(projectId)}/analysis`);
  }

  // --- Documentation ---
  generateDocs(projectId: string, kinds?: readonly string[]): Promise<{ documents: unknown[] }> {
    return this.request('POST', '/docs/generate', { body: { projectId, kinds } });
  }

  listDocuments(options: { projectId?: string; limit?: number } = {}): Promise<Page<unknown>> {
    return this.request('GET', '/docs', { query: options });
  }

  // --- Security ---
  scanProject(projectId: string): Promise<Record<string, unknown>> {
    return this.request('POST', '/security/scan', { body: { projectId } });
  }

  // --- Search ---
  search(query: string, options: { kinds?: readonly string[]; limit?: number } = {}): Promise<{ results: SearchResultDto[] }> {
    return this.request('GET', '/search', {
      query: { q: query, limit: options.limit, kinds: options.kinds?.join(',') },
    });
  }

  // --- Memory ---
  remember(input: { content: string; kind?: string; tags?: readonly string[] }): Promise<unknown> {
    return this.request('POST', '/memory', { body: input });
  }

  recall(query: string, limit = 8): Promise<{ results: unknown[] }> {
    return this.request('GET', '/memory', { query: { q: query, limit } });
  }

  // --- Assistant ---
  ask(
    message: string,
    options: { conversationId?: string; projectId?: string; model?: string } = {}
  ): Promise<AskResponse> {
    return this.request('POST', '/assistant', { body: { message, ...options } });
  }

  /**
   * Streaming assistant response.
   * Yields text deltas as they arrive; the final value is the full answer.
   */
  async *askStream(
    message: string,
    options: { conversationId?: string; projectId?: string; model?: string } = {}
  ): AsyncGenerator<string, void, undefined> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/assistant/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        ...(this.workspaceId ? { 'x-forgeos-workspace': this.workspaceId } : {}),
        ...this.headers,
      },
      body: JSON.stringify({ message, ...options }),
    });

    if (!response.ok || !response.body) {
      throw new ForgeApiError(response.status, 'stream_failed', 'Failed to open the response stream');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;
        try {
          const event = JSON.parse(payload) as { delta?: string };
          if (event.delta) yield event.delta;
        } catch {
          // Ignore malformed frames rather than aborting the stream.
        }
      }
    }
  }

  // --- Workflows ---
  listWorkflows(): Promise<Page<unknown>> {
    return this.request('GET', '/workflows');
  }

  runWorkflow(id: string, input?: unknown): Promise<Record<string, unknown>> {
    return this.request('POST', `/workflows/${encodeURIComponent(id)}/run`, { body: { input } });
  }

  // --- API specs ---
  listApiSpecs(): Promise<Page<unknown>> {
    return this.request('GET', '/specs');
  }

  generateSdk(specId: string, language: 'typescript' | 'python'): Promise<{ files: { path: string; contents: string }[] }> {
    return this.request('POST', `/specs/${encodeURIComponent(specId)}/sdk`, { body: { language } });
  }

  // --- Benchmarks ---
  listBenchmarks(): Promise<Page<unknown>> {
    return this.request('GET', '/benchmarks');
  }

  runBenchmark(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('POST', '/benchmarks', { body: input });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default ForgeOSClient;
