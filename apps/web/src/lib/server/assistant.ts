import 'server-only';
import {
  Assistant,
  detectInjectionAttempt,
  generateAll,
  packMemories,
  toMermaidFlowchart,
  type AssistantTool,
  type ToolResult,
} from '@forgeos/core';
import { getContext, hydrateMemory } from './context';
import { getSearchIndex } from './search';
import { requireAnalysis, scanProjectSecurity } from './projects';

/**
 * The tools the global assistant can call.
 *
 * Each tool answers one question well and returns *dense* text: tool output is
 * charged as prompt tokens on every subsequent turn, so a tool that dumps a
 * whole file is expensive and, worse, buries the answer. Each also returns
 * citations, so the UI can show where a claim came from.
 */
async function resolveProject(workspaceId: string, hint?: unknown): Promise<{ id: string; name: string } | null> {
  const { store } = await getContext();
  const projects = await store.listProjects(workspaceId, { limit: 100 });
  if (projects.length === 0) return null;

  if (typeof hint === 'string' && hint.trim() !== '') {
    const needle = hint.trim().toLowerCase();
    const match =
      projects.find((project) => project.id === hint) ??
      projects.find((project) => project.name.toLowerCase().includes(needle)) ??
      projects.find((project) => needle.includes(project.name.toLowerCase()));
    if (match) return { id: match.id, name: match.name };
  }

  // Default to the most recently analysed project — almost always what the
  // user means when they say "this repository".
  const sorted = [...projects].sort((a, b) => (b.lastAnalysedAt ?? 0) - (a.lastAnalysedAt ?? 0));
  const first = sorted[0];
  return first ? { id: first.id, name: first.name } : null;
}

export async function buildAssistantTools(workspaceId: string): Promise<AssistantTool[]> {
  const { store } = await getContext();

  const searchTool: AssistantTool = {
    definition: {
      name: 'search_workspace',
      description:
        'Search everything in the workspace: repositories, files, documentation, API specs, memories, findings and conversations. Use this first when the user refers to something by name.',
      parameters: {
        query: { type: 'string', description: 'What to search for.', required: true },
        kind: {
          type: 'string',
          description: 'Restrict to one kind of result.',
          enum: ['repository', 'file', 'document', 'api', 'memory', 'workflow', 'benchmark', 'finding'],
        },
      },
    },
    async execute(args) {
      const index = await getSearchIndex(workspaceId);
      const hits = index.search(String(args.query ?? ''), {
        limit: 10,
        ...(typeof args.kind === 'string' ? { kinds: [args.kind as 'file'] } : {}),
        workspaceId,
      });

      if (hits.length === 0) {
        return { content: 'No matching results in this workspace.' } satisfies ToolResult;
      }

      return {
        content: hits
          .map((hit) => `[${hit.document.kind}] ${hit.document.title}\n${hit.excerpt}`)
          .join('\n\n'),
        citations: hits.map((hit) => ({
          title: hit.document.title,
          href: hit.document.href,
          kind: hit.document.kind,
        })),
      } satisfies ToolResult;
    },
  };

  const analysisTool: AssistantTool = {
    definition: {
      name: 'get_repository_analysis',
      description:
        'Structural facts about a repository: languages, stack, size, health score, hotspots, circular dependencies, layers, HTTP routes and database entities.',
      parameters: {
        project: { type: 'string', description: 'Repository name or id. Omit for the most recent.' },
      },
    },
    async execute(args) {
      const project = await resolveProject(workspaceId, args.project);
      if (!project) {
        return { content: 'No repositories have been added to this workspace yet.' };
      }

      const analysis = await requireAnalysis(workspaceId, project.id);
      const lines = [
        `Repository: ${analysis.overview.name}`,
        `Description: ${analysis.overview.description || '(none)'}`,
        `Stack: ${analysis.overview.stackSummary}`,
        `Size: ${analysis.overview.files} files, ${analysis.overview.code} lines of code, ${(analysis.overview.commentRatio * 100).toFixed(1)}% comments`,
        `Health: ${analysis.debt.score}/100 (grade ${analysis.debt.grade}), estimated ${analysis.debt.estimatedDays} days of debt`,
        `Module graph: ${analysis.graph.nodes.length} modules, ${analysis.graph.edges.length} imports, ${analysis.cycles.length} circular dependencies`,
        `Layers: ${analysis.layers.map((layer) => `${layer.layer} (${layer.modules})`).join(', ') || 'none detected'}`,
        `HTTP routes: ${analysis.api.routes.length}${analysis.api.routes.length > 0 ? ` — ${analysis.api.routes.slice(0, 8).map((route) => `${route.method} ${route.path}`).join(', ')}` : ''}`,
        `Database entities: ${analysis.schema.entities.map((entity) => entity.name).join(', ') || 'none detected'}`,
        '',
        'Highest-risk modules:',
        ...analysis.hotspots
          .slice(0, 8)
          .map((hotspot) => `  ${hotspot.path} — risk ${hotspot.risk} (${hotspot.reason})`),
        '',
        'Top findings:',
        ...analysis.debt.findings
          .slice(0, 8)
          .map((finding) => `  [${finding.severity}] ${finding.title} — ${finding.file}${finding.line ? `:${finding.line}` : ''}`),
      ];

      return {
        content: lines.join('\n'),
        citations: [
          { title: analysis.overview.name, href: `/repositories/${project.id}`, kind: 'repository' },
        ],
      };
    },
  };

  const architectureTool: AssistantTool = {
    definition: {
      name: 'get_architecture_diagram',
      description:
        'A Mermaid diagram of a repository module graph, plus its layering and any circular dependencies.',
      parameters: {
        project: { type: 'string', description: 'Repository name or id.' },
      },
    },
    async execute(args) {
      const project = await resolveProject(workspaceId, args.project);
      if (!project) return { content: 'No repositories available.' };

      const analysis = await requireAnalysis(workspaceId, project.id);
      const diagram = toMermaidFlowchart(analysis.graph, { maxNodes: 30 });

      return {
        content: [
          '```mermaid',
          diagram,
          '```',
          '',
          analysis.cycles.length > 0
            ? `Circular dependencies:\n${analysis.cycles
                .slice(0, 5)
                .map((cycle) => `  ${cycle.cycle.join(' -> ')}`)
                .join('\n')}`
            : 'No circular dependencies detected.',
        ].join('\n'),
        citations: [{ title: 'Architecture', href: `/architecture?project=${project.id}`, kind: 'diagram' }],
      };
    },
  };

  const securityTool: AssistantTool = {
    definition: {
      name: 'scan_security',
      description:
        'Run or read a security scan: exposed credentials, insecure code patterns, and vulnerable dependencies.',
      parameters: { project: { type: 'string', description: 'Repository name or id.' } },
    },
    async execute(args) {
      const project = await resolveProject(workspaceId, args.project);
      if (!project) return { content: 'No repositories available.' };

      const [existing] = await store.listSecurityReports(workspaceId, project.id, { limit: 1 });
      const stored = existing ?? (await scanProjectSecurity(workspaceId, project.id));
      const { report } = stored;

      return {
        content: [
          `Security posture: ${report.posture.score}/100 (grade ${report.posture.grade})`,
          report.posture.summary,
          `Counts — critical ${report.counts.critical}, high ${report.counts.high}, moderate ${report.counts.moderate}, low ${report.counts.low}`,
          `Advisory sources consulted: ${report.advisorySources.join(', ')}`,
          '',
          report.secrets.length > 0
            ? `Potential credentials:\n${report.secrets.slice(0, 5).map((secret) => `  ${secret.description} at ${secret.file}:${secret.line} (${secret.confidence} confidence)`).join('\n')}`
            : 'No credentials detected in source.',
          '',
          report.code.length > 0
            ? `Code findings:\n${report.code.slice(0, 8).map((finding) => `  [${finding.severity}] ${finding.title} — ${finding.file}:${finding.line}`).join('\n')}`
            : 'No insecure patterns detected.',
          '',
          report.dependencies.length > 0
            ? `Vulnerable dependencies:\n${report.dependencies.slice(0, 8).map((match) => `  ${match.dependency.name}@${match.resolvedVersion} — ${match.advisory.severity}: ${match.advisory.summary}${match.advisory.patchedVersion ? ` (fixed in ${match.advisory.patchedVersion})` : ''}`).join('\n')}`
            : 'No dependencies matched the consulted advisories.',
        ].join('\n'),
        citations: [{ title: 'Security report', href: '/security', kind: 'security' }],
      };
    },
  };

  const docsTool: AssistantTool = {
    definition: {
      name: 'generate_documentation',
      description:
        'Generate documentation for a repository from its analysis: README, architecture, API reference, setup or deployment guide.',
      parameters: {
        project: { type: 'string', description: 'Repository name or id.' },
        kind: {
          type: 'string',
          description: 'Which document to generate.',
          enum: ['readme', 'architecture', 'api', 'setup', 'deployment'],
        },
      },
    },
    async execute(args) {
      const project = await resolveProject(workspaceId, args.project);
      if (!project) return { content: 'No repositories available.' };

      const analysis = await requireAnalysis(workspaceId, project.id);
      const documents = generateAll(analysis);
      const wanted = typeof args.kind === 'string' ? args.kind : 'readme';
      const document = documents.find((candidate) => candidate.kind === wanted) ?? documents[0];
      if (!document) return { content: 'Nothing could be generated.' };

      return {
        content: [
          `Generated ${document.kind} (${document.wordCount} words).`,
          document.gaps.length > 0
            ? `Gaps a human must fill:\n${document.gaps.map((gap) => `  - ${gap}`).join('\n')}`
            : 'No gaps flagged.',
          '',
          document.markdown.slice(0, 6000),
        ].join('\n'),
        citations: [{ title: document.title, href: '/documentation', kind: 'document' }],
      };
    },
  };

  const memoryTool: AssistantTool = {
    definition: {
      name: 'recall_memory',
      description:
        'Retrieve long-term memories relevant to a question — past decisions, conventions and facts the team recorded.',
      parameters: {
        query: { type: 'string', description: 'What to recall.', required: true },
      },
    },
    async execute(args) {
      const memory = await hydrateMemory(workspaceId);
      const results = await memory.retrieve(workspaceId, String(args.query ?? ''), { limit: 6 });
      if (results.length === 0) return { content: 'No relevant memories are stored.' };
      return {
        content: packMemories(results, 600),
        citations: results.map((result) => ({
          title: result.memory.content.slice(0, 60),
          href: `/memory?highlight=${result.memory.id}`,
          kind: 'memory',
        })),
      };
    },
  };

  const listProjectsTool: AssistantTool = {
    definition: {
      name: 'list_repositories',
      description: 'List the repositories in this workspace with their health scores.',
      parameters: {},
    },
    async execute() {
      const projects = await store.listProjects(workspaceId, { limit: 50 });
      if (projects.length === 0) return { content: 'This workspace has no repositories yet.' };

      const lines: string[] = [];
      for (const project of projects) {
        const latest = await store.getLatestAnalysis(workspaceId, project.id);
        lines.push(
          `- ${project.name} (${project.id}) — ${
            latest
              ? `${latest.analysis.overview.code.toLocaleString()} LOC, health ${latest.analysis.debt.score}/100`
              : 'not analysed yet'
          }`
        );
      }
      return {
        content: lines.join('\n'),
        citations: projects.slice(0, 5).map((project) => ({
          title: project.name,
          href: `/repositories/${project.id}`,
          kind: 'repository',
        })),
      };
    },
  };

  return [
    searchTool,
    analysisTool,
    architectureTool,
    securityTool,
    docsTool,
    memoryTool,
    listProjectsTool,
  ];
}

export interface AssistantOptionsInput {
  readonly workspaceId: string;
  readonly model?: string | undefined;
  readonly projectId?: string | undefined;
}

export async function createAssistant(input: AssistantOptionsInput): Promise<Assistant> {
  const { registry, store } = await getContext();
  const tools = await buildAssistantTools(input.workspaceId);

  // Ground the assistant in what the workspace actually contains, so it does
  // not have to spend a tool call discovering that it is empty.
  const projects = await store.listProjects(input.workspaceId, { limit: 10 });
  const context = [
    `Workspace contains ${projects.length} repositor${projects.length === 1 ? 'y' : 'ies'}.`,
    ...projects.map((project) => `- ${project.name} (id: ${project.id})`),
  ].join('\n');

  return new Assistant({
    registry,
    tools,
    context,
    ...(input.model ? { model: input.model } : {}),
    maxSteps: 4,
  });
}

export { detectInjectionAttempt };
