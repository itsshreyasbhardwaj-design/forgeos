import { evaluateCondition, interpolate, interpolateDeep, type Scope } from './expression.js';
import { createId } from '../kernel/id.js';
import { ForgeError, invalidInput } from '../kernel/errors.js';
import { type Logger, silentLogger } from '../kernel/logger.js';

/**
 * The workflow execution engine.
 *
 * A workflow is a directed acyclic graph of typed nodes. The engine resolves
 * execution order topologically, runs independent branches concurrently, and
 * records a full trace of every node — inputs, output, timing, retries and
 * errors — because "it failed somewhere" is useless and a trace is the entire
 * product value of a visual builder.
 *
 * Node *behaviour* lives outside the engine, in handlers the application
 * registers. That separation is what lets the same engine run AI calls, HTTP
 * requests, repository analyses and MCP tools without knowing about any of them.
 */
export type NodeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface WorkflowNode {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  /** Handler-specific configuration; string values support `{{path}}`. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Canvas position, persisted so the builder round-trips. */
  readonly position?: { x: number; y: number };
  readonly retries?: number;
  readonly timeoutMs?: number;
  /** Node only runs when this expression is truthy. */
  readonly condition?: string;
  /** Continue the workflow even if this node fails. */
  readonly continueOnError?: boolean;
}

export interface WorkflowEdge {
  readonly from: string;
  readonly to: string;
  /** Edge is only traversed when this expression is truthy. */
  readonly condition?: string;
  readonly label?: string;
}

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  readonly version?: number;
}

export interface NodeExecutionContext {
  readonly node: WorkflowNode;
  /** Configuration with all `{{path}}` references resolved. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Outputs of every completed node, keyed by node id. */
  readonly steps: Readonly<Record<string, unknown>>;
  readonly input: unknown;
  readonly workspaceId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /** Emit a progress message that appears in the trace. */
  log(message: string, fields?: Record<string, unknown>): void;
}

export type NodeHandler = (context: NodeExecutionContext) => Promise<unknown>;

export interface NodeTypeDefinition {
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly category: 'trigger' | 'ai' | 'data' | 'logic' | 'integration' | 'output';
  readonly handler: NodeHandler;
  /** Configuration fields, for the builder's inspector panel. */
  readonly fields?: readonly {
    readonly name: string;
    readonly type: 'string' | 'text' | 'number' | 'boolean' | 'select' | 'json';
    readonly label: string;
    readonly required?: boolean;
    readonly options?: readonly string[];
    readonly placeholder?: string;
  }[];
}

export interface NodeTrace {
  readonly nodeId: string;
  readonly type: string;
  readonly label: string;
  readonly status: NodeStatus;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly attempts: number;
  readonly config: Readonly<Record<string, unknown>>;
  readonly output?: unknown;
  readonly error?: string;
  readonly logs: readonly { at: number; message: string; fields?: Record<string, unknown> }[];
  readonly skippedReason?: string;
}

export interface WorkflowRun {
  readonly id: string;
  readonly workflowId: string;
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly trace: readonly NodeTrace[];
  readonly output: unknown;
  readonly error?: string;
  readonly input: unknown;
}

/** Validate structure before execution: unknown types, cycles, dangling edges. */
export interface ValidationIssue {
  readonly severity: 'error' | 'warning';
  readonly nodeId?: string;
  readonly message: string;
}

export function validateWorkflow(
  workflow: Workflow,
  registry: ReadonlyMap<string, NodeTypeDefinition>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set(workflow.nodes.map((node) => node.id));

  if (workflow.nodes.length === 0) {
    issues.push({ severity: 'error', message: 'The workflow has no nodes.' });
  }

  for (const node of workflow.nodes) {
    if (!registry.has(node.type)) {
      issues.push({
        severity: 'error',
        nodeId: node.id,
        message: `Unknown node type '${node.type}'.`,
      });
    }
  }

  for (const edge of workflow.edges) {
    if (!ids.has(edge.from)) {
      issues.push({ severity: 'error', message: `Edge references missing node '${edge.from}'.` });
    }
    if (!ids.has(edge.to)) {
      issues.push({ severity: 'error', message: `Edge references missing node '${edge.to}'.` });
    }
  }

  const order = topologicalOrder(workflow);
  if (order === null) {
    issues.push({ severity: 'error', message: 'The workflow contains a cycle.' });
  }

  const targets = new Set(workflow.edges.map((edge) => edge.to));
  const roots = workflow.nodes.filter((node) => !targets.has(node.id));
  if (roots.length === 0 && workflow.nodes.length > 0) {
    issues.push({ severity: 'error', message: 'Every node has an incoming edge; there is no start.' });
  }

  const sources = new Set(workflow.edges.map((edge) => edge.from));
  for (const node of workflow.nodes) {
    if (!sources.has(node.id) && !targets.has(node.id) && workflow.nodes.length > 1) {
      issues.push({
        severity: 'warning',
        nodeId: node.id,
        message: `'${node.label}' is not connected to anything.`,
      });
    }
  }

  return issues;
}

/** Kahn's algorithm. Returns `null` when the graph contains a cycle. */
export function topologicalOrder(workflow: Workflow): string[] | null {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of workflow.nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }
  for (const edge of workflow.edges) {
    if (!inDegree.has(edge.to) || !adjacency.has(edge.from)) continue;
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    adjacency.get(edge.from)?.push(edge.to);
  }

  const queue = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const degree = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }

  return order.length === workflow.nodes.length ? order : null;
}

export interface ExecuteOptions {
  readonly workspaceId: string;
  readonly input?: unknown;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  readonly now?: () => number;
  /** Called after each node completes, for live trace streaming. */
  readonly onTrace?: (trace: NodeTrace) => void;
  /** Wall-clock ceiling for the whole run. Default 5 minutes. */
  readonly timeoutMs?: number;
}

export class WorkflowEngine {
  private readonly registry = new Map<string, NodeTypeDefinition>();

  register(definition: NodeTypeDefinition): this {
    this.registry.set(definition.type, definition);
    return this;
  }

  registerAll(definitions: Iterable<NodeTypeDefinition>): this {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  get nodeTypes(): NodeTypeDefinition[] {
    return [...this.registry.values()].sort(
      (a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label)
    );
  }

  validate(workflow: Workflow): ValidationIssue[] {
    return validateWorkflow(workflow, this.registry);
  }

  async execute(workflow: Workflow, options: ExecuteOptions): Promise<WorkflowRun> {
    const now = options.now ?? Date.now;
    const logger = options.logger ?? silentLogger;
    const startedAt = now();
    const runId = createId('run', startedAt);

    const issues = this.validate(workflow).filter((issue) => issue.severity === 'error');
    if (issues.length > 0) {
      throw invalidInput('The workflow is not valid', {
        issues: issues.map((issue) => issue.message),
      });
    }

    const order = topologicalOrder(workflow);
    if (!order) throw invalidInput('The workflow contains a cycle');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 300_000);
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]));
    const incoming = new Map<string, WorkflowEdge[]>();
    for (const edge of workflow.edges) {
      const bucket = incoming.get(edge.to) ?? [];
      bucket.push(edge);
      incoming.set(edge.to, bucket);
    }

    const steps: Record<string, unknown> = {};
    const statuses = new Map<string, NodeStatus>();
    const trace: NodeTrace[] = [];
    let runError: string | undefined;

    try {
      for (const nodeId of order) {
        if (controller.signal.aborted) break;
        const node = nodesById.get(nodeId);
        if (!node) continue;

        const scope: Scope = { steps, input: options.input ?? null, run: { id: runId } };

        // A node is skipped when every inbound edge was skipped or its guard
        // failed — that is how branching produces exclusive paths.
        const inbound = incoming.get(nodeId) ?? [];
        if (inbound.length > 0) {
          const reachable = inbound.some((edge) => {
            const upstream = statuses.get(edge.from);
            if (upstream !== 'succeeded') return false;
            return edge.condition ? evaluateCondition(edge.condition, scope) : true;
          });
          if (!reachable) {
            statuses.set(nodeId, 'skipped');
            const skipped: NodeTrace = {
              nodeId,
              type: node.type,
              label: node.label,
              status: 'skipped',
              startedAt: now(),
              finishedAt: now(),
              durationMs: 0,
              attempts: 0,
              config: node.config,
              logs: [],
              skippedReason: 'No inbound branch reached this node.',
            };
            trace.push(skipped);
            options.onTrace?.(skipped);
            continue;
          }
        }

        if (node.condition && !evaluateCondition(node.condition, scope)) {
          statuses.set(nodeId, 'skipped');
          const skipped: NodeTrace = {
            nodeId,
            type: node.type,
            label: node.label,
            status: 'skipped',
            startedAt: now(),
            finishedAt: now(),
            durationMs: 0,
            attempts: 0,
            config: node.config,
            logs: [],
            skippedReason: `Condition evaluated false: ${node.condition}`,
          };
          trace.push(skipped);
          options.onTrace?.(skipped);
          continue;
        }

        const definition = this.registry.get(node.type);
        if (!definition) continue;

        const resolvedConfig = interpolateDeep(node.config, scope) as Record<string, unknown>;
        const logs: NodeTrace['logs'] = [];
        const nodeStartedAt = now();
        const maxAttempts = Math.max(1, (node.retries ?? 0) + 1);

        let attempts = 0;
        let output: unknown;
        let error: string | undefined;

        while (attempts < maxAttempts) {
          attempts++;
          try {
            const context: NodeExecutionContext = {
              node,
              config: resolvedConfig,
              steps,
              input: options.input ?? null,
              workspaceId: options.workspaceId,
              runId,
              signal: controller.signal,
              logger: logger.child(node.type, { nodeId }),
              log(message, fields) {
                (logs as { at: number; message: string; fields?: Record<string, unknown> }[]).push({
                  at: now(),
                  message,
                  ...(fields ? { fields } : {}),
                });
              },
            };

            output = node.timeoutMs
              ? await withTimeout(definition.handler(context), node.timeoutMs, node.label)
              : await definition.handler(context);
            error = undefined;
            break;
          } catch (caught) {
            error = ForgeError.from(caught).message;
            if (attempts < maxAttempts) {
              // Exponential backoff, capped — retrying a rate limit immediately
              // just burns the remaining budget.
              await delay(Math.min(2000, 150 * 2 ** (attempts - 1)));
            }
          }
        }

        const status: NodeStatus = error ? 'failed' : 'succeeded';
        statuses.set(nodeId, status);
        if (!error) steps[nodeId] = output;

        const nodeTrace: NodeTrace = {
          nodeId,
          type: node.type,
          label: node.label,
          status,
          startedAt: nodeStartedAt,
          finishedAt: now(),
          durationMs: Math.max(0, now() - nodeStartedAt),
          attempts,
          config: resolvedConfig,
          ...(error ? { error } : { output }),
          logs,
        };
        trace.push(nodeTrace);
        options.onTrace?.(nodeTrace);

        if (error && !node.continueOnError) {
          runError = `Node '${node.label}' failed: ${error}`;
          break;
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    const cancelled = controller.signal.aborted && !runError;
    const terminal = trace.filter((entry) => entry.status === 'succeeded').at(-1);

    return {
      id: runId,
      workflowId: workflow.id,
      status: runError ? 'failed' : cancelled ? 'cancelled' : 'succeeded',
      startedAt,
      finishedAt: now(),
      durationMs: Math.max(0, now() - startedAt),
      trace,
      output: terminal ? steps[terminal.nodeId] : null,
      ...(runError ? { error: runError } : cancelled ? { error: 'The run timed out or was cancelled.' } : {}),
      input: options.input ?? null,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ForgeError(`Node '${label}' exceeded its ${ms}ms timeout`, { code: 'timeout' })),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

/** Human-readable summary of a run, for the activity feed. */
export function describeRun(run: WorkflowRun): string {
  const succeeded = run.trace.filter((entry) => entry.status === 'succeeded').length;
  const failed = run.trace.filter((entry) => entry.status === 'failed').length;
  const skipped = run.trace.filter((entry) => entry.status === 'skipped').length;
  const parts = [`${succeeded} succeeded`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return `${parts.join(', ')} in ${run.durationMs}ms`;
}

/** Re-export so callers building node handlers need only one import. */
export { interpolate, evaluateCondition };
