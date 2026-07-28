import type { LayerSummary, ModuleGraph } from './module-graph.js';
import { directoryOf } from './module-graph.js';
import { fnv1a32 } from '../kernel/hash.js';

/**
 * Mermaid rendering.
 *
 * Diagrams are emitted as Mermaid source rather than as an image so they are
 * diffable in version control, embeddable in generated Markdown, and rendered
 * client-side at whatever size the viewport needs.
 */

/** Mermaid node ids must be alphanumeric; keep them stable and collision-free. */
export function mermaidId(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9]/g, '_').slice(0, 40);
  return `n${fnv1a32(value).toString(36)}_${safe}`;
}

/** Escape text for a Mermaid node label. */
export function mermaidLabel(value: string): string {
  return value.replace(/["`]/g, "'").replace(/[<>]/g, '').replace(/\|/g, '/').slice(0, 80);
}

export interface FlowchartOptions {
  readonly direction?: 'TD' | 'LR' | 'BT' | 'RL';
  /** Group nodes into subgraphs by directory. Default true. */
  readonly cluster?: boolean;
  /** Cap rendered nodes; the most connected survive. Default 60. */
  readonly maxNodes?: number;
  /** Highlight these paths. */
  readonly highlight?: readonly string[];
}

const EDGE_STYLE: Record<string, string> = {
  static: '-->',
  type: '-.->',
  dynamic: '==>',
  're-export': '-->',
  'side-effect': '-.->',
};

/**
 * Render the module graph as a Mermaid flowchart, clustered by directory.
 *
 * Beyond ~60 nodes a flowchart stops being readable, so the renderer keeps the
 * most connected modules and reports the omission in a comment rather than
 * silently truncating.
 */
export function toMermaidFlowchart(graph: ModuleGraph, options: FlowchartOptions = {}): string {
  const direction = options.direction ?? 'LR';
  const maxNodes = options.maxNodes ?? 60;
  const cluster = options.cluster ?? true;
  const highlight = new Set(options.highlight ?? []);

  const ranked = [...graph.nodes].sort(
    (a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut) || b.loc - a.loc
  );
  const kept = ranked.slice(0, maxNodes);
  const keptIds = new Set(kept.map((node) => node.id));
  const omitted = graph.nodes.length - kept.length;

  const lines: string[] = [`flowchart ${direction}`];
  if (omitted > 0) {
    lines.push(`  %% Showing ${kept.length} of ${graph.nodes.length} modules by connectivity`);
  }

  if (cluster) {
    const byDirectory = new Map<string, typeof kept>();
    for (const node of kept) {
      const directory = directoryOf(node.path);
      const bucket = byDirectory.get(directory) ?? [];
      bucket.push(node);
      byDirectory.set(directory, bucket);
    }
    for (const [directory, nodes] of [...byDirectory.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      lines.push(`  subgraph ${mermaidId(directory)}["${mermaidLabel(directory)}"]`);
      for (const node of nodes) {
        lines.push(`    ${mermaidId(node.id)}["${mermaidLabel(node.label)}"]`);
      }
      lines.push('  end');
    }
  } else {
    for (const node of kept) {
      lines.push(`  ${mermaidId(node.id)}["${mermaidLabel(node.label)}"]`);
    }
  }

  const seen = new Set<string>();
  for (const edge of graph.edges) {
    if (!keptIds.has(edge.from) || !keptIds.has(edge.to)) continue;
    const key = `${edge.from}->${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const arrow = EDGE_STYLE[edge.kind] ?? '-->';
    lines.push(`  ${mermaidId(edge.from)} ${arrow} ${mermaidId(edge.to)}`);
  }

  for (const path of highlight) {
    if (keptIds.has(path)) {
      lines.push(`  style ${mermaidId(path)} stroke-width:3px,stroke:#7c5cff`);
    }
  }

  return lines.join('\n');
}

/** Render layer-to-layer dependencies, with violations drawn distinctly. */
export function toMermaidLayerDiagram(
  layers: readonly LayerSummary[],
  violations: readonly { fromLayer: string; toLayer: string }[] = []
): string {
  const lines: string[] = ['flowchart TD'];
  for (const layer of layers) {
    lines.push(
      `  ${mermaidId(layer.layer)}["${mermaidLabel(layer.layer)}<br/>${layer.modules} modules · ${layer.loc.toLocaleString()} LOC"]`
    );
  }

  const violating = new Set(violations.map((v) => `${v.fromLayer}->${v.toLayer}`));
  for (const layer of layers) {
    for (const [target, count] of Object.entries(layer.dependsOn)) {
      const key = `${layer.layer}->${target}`;
      const arrow = violating.has(key) ? '-.->' : '-->';
      const label = violating.has(key) ? `${count} ⚠` : String(count);
      lines.push(`  ${mermaidId(layer.layer)} ${arrow}|${label}| ${mermaidId(target)}`);
    }
  }
  return lines.join('\n');
}

export interface ErdEntity {
  readonly name: string;
  readonly columns: readonly { name: string; type: string; key?: 'PK' | 'FK' | 'UK' }[];
}

export interface ErdRelation {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly cardinality: 'one-to-one' | 'one-to-many' | 'many-to-many';
}

const CARDINALITY: Record<ErdRelation['cardinality'], string> = {
  'one-to-one': '||--||',
  'one-to-many': '||--o{',
  'many-to-many': '}o--o{',
};

/** Render an entity-relationship diagram from an extracted schema. */
export function toMermaidErd(
  entities: readonly ErdEntity[],
  relations: readonly ErdRelation[]
): string {
  const lines: string[] = ['erDiagram'];
  for (const relation of relations) {
    lines.push(
      `  ${sanitizeErdName(relation.from)} ${CARDINALITY[relation.cardinality]} ${sanitizeErdName(relation.to)} : "${mermaidLabel(relation.label)}"`
    );
  }
  for (const entity of entities) {
    lines.push(`  ${sanitizeErdName(entity.name)} {`);
    for (const column of entity.columns.slice(0, 24)) {
      const type = column.type.replace(/[^A-Za-z0-9_]/g, '_') || 'unknown';
      lines.push(`    ${type} ${sanitizeErdName(column.name)}${column.key ? ` ${column.key}` : ''}`);
    }
    lines.push('  }');
  }
  return lines.join('\n');
}

function sanitizeErdName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '_') || 'unnamed';
}

export interface SequenceStep {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly kind?: 'call' | 'return' | 'async';
}

/** Render an execution flow as a sequence diagram. */
export function toMermaidSequence(participants: readonly string[], steps: readonly SequenceStep[]): string {
  const lines: string[] = ['sequenceDiagram', '  autonumber'];
  for (const participant of participants) {
    lines.push(`  participant ${mermaidId(participant)} as ${mermaidLabel(participant)}`);
  }
  for (const step of steps) {
    const arrow = step.kind === 'return' ? '-->>' : step.kind === 'async' ? '-)' : '->>';
    lines.push(
      `  ${mermaidId(step.from)}${arrow}${mermaidId(step.to)}: ${mermaidLabel(step.label)}`
    );
  }
  return lines.join('\n');
}

/** Render an API surface grouped by resource prefix. */
export function toMermaidApiMap(
  routes: readonly { method: string; path: string; handler: string }[]
): string {
  const lines: string[] = ['flowchart LR', '  client(["Client"])'];
  type Route = (typeof routes)[number];
  const byPrefix = new Map<string, Route[]>();
  for (const route of routes) {
    const prefix = route.path.split('/').filter(Boolean)[0] ?? 'root';
    const bucket = byPrefix.get(prefix) ?? [];
    bucket.push(route);
    byPrefix.set(prefix, bucket);
  }
  for (const [prefix, group] of [...byPrefix.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  subgraph ${mermaidId(prefix)}["/${mermaidLabel(prefix)}"]`);
    for (const route of group.slice(0, 20)) {
      lines.push(
        `    ${mermaidId(route.method + route.path)}["${route.method} ${mermaidLabel(route.path)}"]`
      );
    }
    lines.push('  end');
    lines.push(`  client --> ${mermaidId(prefix)}`);
  }
  return lines.join('\n');
}
