import 'server-only';
import {
  WorkflowEngine,
  generateAll,
  invalidInput,
  packMemories,
  type NodeTypeDefinition,
} from '@forgeos/core';
import { getContext, hydrateMemory } from './context';
import { requireAnalysis, scanProjectSecurity } from './projects';
import { getSearchIndex } from './search';

/**
 * Built-in workflow node types.
 *
 * These are the nodes that make the visual builder useful on day one: they wrap
 * the same engines the rest of the product uses, so a workflow produces exactly
 * the results the corresponding module would.
 *
 * Two nodes deserve note:
 *
 *  - `http.request` refuses private network destinations. A workflow is
 *    user-authored content running on the server, so without that check it is a
 *    server-side request forgery primitive pointed at cloud metadata endpoints.
 *  - `mcp.call` speaks the Model Context Protocol over HTTP, which is how
 *    ForgeOS workflows reach third-party tool servers.
 */
const PRIVATE_HOST =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|.*\.internal|.*\.local)$/i;

function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidInput(`'${raw}' is not a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalidInput('Only http and https URLs are permitted');
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    throw invalidInput(
      'Requests to private or loopback addresses are blocked to prevent server-side request forgery',
      { hostname: url.hostname }
    );
  }
  return url;
}

export function createNodeTypes(workspaceId: string): NodeTypeDefinition[] {
  return [
    {
      type: 'trigger.manual',
      label: 'Manual trigger',
      description: 'Starts the workflow with whatever input was supplied to the run.',
      category: 'trigger',
      handler: async (context) => context.input ?? {},
    },

    {
      type: 'repo.analyse',
      label: 'Analyse repository',
      description: 'Runs a full static analysis and returns the summary metrics.',
      category: 'data',
      fields: [{ name: 'projectId', type: 'string', label: 'Repository id', required: true }],
      handler: async (context) => {
        const projectId = String(context.config.projectId ?? '');
        if (!projectId) throw invalidInput('projectId is required');
        const analysis = await requireAnalysis(workspaceId, projectId);
        context.log(`Analysed ${analysis.overview.name}`, { files: analysis.overview.files });
        return {
          name: analysis.overview.name,
          files: analysis.overview.files,
          code: analysis.overview.code,
          health: analysis.debt.score,
          grade: analysis.debt.grade,
          cycles: analysis.cycles.length,
          routes: analysis.api.routes.length,
          critical: analysis.debt.bySeverity.critical,
          hotspots: analysis.hotspots.slice(0, 5).map((hotspot) => hotspot.path),
        };
      },
    },

    {
      type: 'security.scan',
      label: 'Security scan',
      description: 'Scans for exposed credentials, insecure patterns and vulnerable dependencies.',
      category: 'data',
      fields: [{ name: 'projectId', type: 'string', label: 'Repository id', required: true }],
      handler: async (context) => {
        const projectId = String(context.config.projectId ?? '');
        if (!projectId) throw invalidInput('projectId is required');
        const stored = await scanProjectSecurity(workspaceId, projectId);
        context.log(`Posture ${stored.report.posture.score}`, stored.report.counts);
        return {
          score: stored.report.posture.score,
          grade: stored.report.posture.grade,
          ...stored.report.counts,
          secrets: stored.report.secrets.length,
          vulnerabilities: stored.report.dependencies.length,
        };
      },
    },

    {
      type: 'docs.generate',
      label: 'Generate documentation',
      description: 'Produces README, architecture, API, setup and deployment documents.',
      category: 'data',
      fields: [
        { name: 'projectId', type: 'string', label: 'Repository id', required: true },
        {
          name: 'kind',
          type: 'select',
          label: 'Document',
          options: ['readme', 'architecture', 'api', 'setup', 'deployment'],
        },
      ],
      handler: async (context) => {
        const projectId = String(context.config.projectId ?? '');
        const analysis = await requireAnalysis(workspaceId, projectId);
        const documents = generateAll(analysis);
        const kind = String(context.config.kind ?? 'readme');
        const document = documents.find((candidate) => candidate.kind === kind) ?? documents[0];
        return {
          kind: document?.kind,
          title: document?.title,
          words: document?.wordCount,
          gaps: document?.gaps ?? [],
          markdown: document?.markdown ?? '',
        };
      },
    },

    {
      type: 'ai.complete',
      label: 'AI completion',
      description: 'Sends a prompt to a configured model and returns its response.',
      category: 'ai',
      fields: [
        { name: 'prompt', type: 'text', label: 'Prompt', required: true, placeholder: 'Supports {{steps.node.output}} references' },
        { name: 'system', type: 'text', label: 'System instruction' },
        { name: 'model', type: 'string', label: 'Model id', placeholder: 'forge-local' },
      ],
      handler: async (context) => {
        const { registry } = await getContext();
        const model = String(context.config.model || registry.defaultModel);
        const { provider } = await registry.resolve(model);

        const response = await provider.complete({
          model,
          messages: [
            ...(context.config.system
              ? [{ role: 'system' as const, content: String(context.config.system) }]
              : []),
            { role: 'user' as const, content: String(context.config.prompt ?? '') },
          ],
          signal: context.signal,
        });

        context.log(`Model responded`, { model, tokens: response.usage.totalTokens });
        return {
          text: response.text,
          model: response.model,
          tokens: response.usage.totalTokens,
          costUsd: response.costUsd,
          latencyMs: response.latencyMs,
        };
      },
    },

    {
      type: 'memory.recall',
      label: 'Recall memory',
      description: 'Retrieves relevant long-term memories for a query.',
      category: 'ai',
      fields: [{ name: 'query', type: 'string', label: 'Query', required: true }],
      handler: async (context) => {
        const memory = await hydrateMemory(workspaceId);
        const results = await memory.retrieve(workspaceId, String(context.config.query ?? ''), {
          limit: 6,
        });
        return { count: results.length, text: packMemories(results, 500) };
      },
    },

    {
      type: 'search.query',
      label: 'Search workspace',
      description: 'Searches repositories, documents, APIs, memories and findings.',
      category: 'data',
      fields: [{ name: 'query', type: 'string', label: 'Query', required: true }],
      handler: async (context) => {
        const index = await getSearchIndex(workspaceId);
        const hits = index.search(String(context.config.query ?? ''), { limit: 10, workspaceId });
        return {
          count: hits.length,
          results: hits.map((hit) => ({
            kind: hit.document.kind,
            title: hit.document.title,
            href: hit.document.href,
            excerpt: hit.excerpt,
          })),
        };
      },
    },

    {
      type: 'logic.condition',
      label: 'Condition',
      description: 'Evaluates an expression and passes it downstream as a boolean.',
      category: 'logic',
      fields: [
        {
          name: 'expression',
          type: 'string',
          label: 'Expression',
          required: true,
          placeholder: 'steps.scan.output.critical > 0',
        },
      ],
      handler: async (context) => {
        const { evaluateCondition } = await import('@forgeos/core');
        const value = evaluateCondition(String(context.config.expression ?? ''), {
          steps: context.steps,
          input: context.input,
        });
        context.log(`Condition evaluated to ${value}`);
        return { value };
      },
    },

    {
      type: 'transform.template',
      label: 'Template',
      description: 'Builds a string from earlier step outputs using {{path}} references.',
      category: 'logic',
      fields: [{ name: 'template', type: 'text', label: 'Template', required: true }],
      handler: async (context) => ({ text: String(context.config.template ?? '') }),
    },

    {
      type: 'http.request',
      label: 'HTTP request',
      description: 'Calls an external HTTP endpoint. Private and loopback addresses are blocked.',
      category: 'integration',
      fields: [
        { name: 'url', type: 'string', label: 'URL', required: true },
        { name: 'method', type: 'select', label: 'Method', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        { name: 'body', type: 'json', label: 'Body' },
        { name: 'headers', type: 'json', label: 'Headers' },
      ],
      handler: async (context) => {
        const url = assertPublicUrl(String(context.config.url ?? ''));
        const method = String(context.config.method ?? 'GET').toUpperCase();

        const response = await fetch(url, {
          method,
          headers: {
            'content-type': 'application/json',
            ...((context.config.headers as Record<string, string> | undefined) ?? {}),
          },
          ...(method !== 'GET' && context.config.body !== undefined
            ? { body: JSON.stringify(context.config.body) }
            : {}),
          signal: context.signal,
        });

        const text = await response.text();
        context.log(`${method} ${url.host} responded ${response.status}`);
        return {
          status: response.status,
          ok: response.ok,
          body: safeJson(text),
        };
      },
    },

    {
      type: 'mcp.call',
      label: 'MCP tool call',
      description:
        'Invokes a tool on a Model Context Protocol server over HTTP, using the standard tools/call method.',
      category: 'integration',
      fields: [
        { name: 'endpoint', type: 'string', label: 'MCP server URL', required: true },
        { name: 'tool', type: 'string', label: 'Tool name', required: true },
        { name: 'arguments', type: 'json', label: 'Arguments' },
      ],
      handler: async (context) => {
        const endpoint = assertPublicUrl(String(context.config.endpoint ?? ''));
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: context.runId,
            method: 'tools/call',
            params: {
              name: String(context.config.tool ?? ''),
              arguments: (context.config.arguments as Record<string, unknown>) ?? {},
            },
          }),
          signal: context.signal,
        });

        const payload = safeJson(await response.text()) as {
          result?: { content?: { type: string; text?: string }[]; isError?: boolean };
          error?: { message?: string };
        };

        if (payload?.error) {
          throw invalidInput(`MCP server returned an error: ${payload.error.message ?? 'unknown'}`);
        }

        const text = (payload?.result?.content ?? [])
          .map((part) => part.text ?? '')
          .filter(Boolean)
          .join('\n');

        context.log(`Called MCP tool ${String(context.config.tool)}`);
        return { text, isError: payload?.result?.isError ?? false, raw: payload?.result };
      },
    },

    {
      type: 'output.result',
      label: 'Output',
      description: 'Marks the value that the run returns.',
      category: 'output',
      fields: [{ name: 'value', type: 'text', label: 'Value' }],
      handler: async (context) => ({ value: context.config.value ?? context.steps }),
    },
  ];
}

export function createWorkflowEngine(workspaceId: string): WorkflowEngine {
  return new WorkflowEngine().registerAll(createNodeTypes(workspaceId));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
