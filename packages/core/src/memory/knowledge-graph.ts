import type { Memory } from './store.js';
import { deterministicId } from '../kernel/id.js';
import { unique } from '../kernel/text.js';

/**
 * A knowledge graph derived from stored memories.
 *
 * Entities are extracted with conservative patterns — identifiers, file paths,
 * package names, capitalised proper nouns — and linked by co-occurrence within
 * a memory. Co-occurrence is a weak relation, so edges carry a weight and a
 * list of supporting memories; the UI can then show *why* two things are
 * believed to be related rather than asserting it.
 */
export type EntityType =
  | 'symbol'
  | 'file'
  | 'package'
  | 'service'
  | 'person'
  | 'concept'
  | 'decision';

export interface KnowledgeEntity {
  readonly id: string;
  readonly name: string;
  readonly type: EntityType;
  readonly mentions: number;
  readonly memoryIds: readonly string[];
}

export interface KnowledgeEdge {
  readonly from: string;
  readonly to: string;
  readonly weight: number;
  readonly memoryIds: readonly string[];
}

export interface KnowledgeGraph {
  readonly entities: readonly KnowledgeEntity[];
  readonly edges: readonly KnowledgeEdge[];
}

interface Extractor {
  readonly type: EntityType;
  readonly pattern: RegExp;
  readonly normalise?: (value: string) => string;
}

const EXTRACTORS: readonly Extractor[] = [
  // Paths: `src/lib/auth.ts`
  { type: 'file', pattern: /\b((?:[\w.-]+\/){1,6}[\w.-]+\.[a-z]{1,5})\b/g },
  // Backticked identifiers: `parseRepository`
  { type: 'symbol', pattern: /`([A-Za-z_$][\w$]{2,})`/g },
  // Scoped or dashed package names: `@forgeos/core`, `react-dom`
  { type: 'package', pattern: /\b(@[\w-]+\/[\w-]+|[a-z][\w]*-[\w-]+)\b/g },
  // Decision language: "we decided to X", "chose X"
  { type: 'decision', pattern: /\b(?:decided|chose|agreed|standardised|standardized) (?:to |on )?([^.;\n]{6,70})/gi },
  // Capitalised multi-word proper nouns: `Postgres`, `Vector Search`
  { type: 'concept', pattern: /\b([A-Z][a-zA-Z]{2,}(?: [A-Z][a-zA-Z]{2,}){0,2})\b/g },
];

/** Words that would otherwise flood the graph as "concepts". */
const CONCEPT_STOP_WORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'There', 'When', 'Where', 'What', 'Which', 'While',
  'After', 'Before', 'Because', 'However', 'Also', 'Note', 'TODO', 'And', 'But', 'For', 'With',
  'From', 'Into', 'Once', 'Then', 'They', 'Their', 'Should', 'Would', 'Could', 'Will', 'Must',
]);

function entityId(type: EntityType, name: string): string {
  return deterministicId('mem', type, name.toLowerCase());
}

export function extractEntities(text: string): { name: string; type: EntityType }[] {
  const found: { name: string; type: EntityType }[] = [];

  for (const extractor of EXTRACTORS) {
    const pattern = new RegExp(extractor.pattern.source, extractor.pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const raw = (match[1] ?? '').trim();
      if (raw === '') continue;

      if (extractor.type === 'concept') {
        if (CONCEPT_STOP_WORDS.has(raw.split(' ')[0] ?? '')) continue;
        if (raw.length < 4) continue;
      }
      if (extractor.type === 'symbol' && raw.length < 3) continue;
      if (extractor.type === 'package' && raw.split('-').length < 2 && !raw.startsWith('@')) continue;

      found.push({ name: extractor.normalise ? extractor.normalise(raw) : raw, type: extractor.type });
      if (pattern.lastIndex <= match.index) pattern.lastIndex = match.index + 1;
    }
  }

  // A path also matches the concept and package extractors; the most specific
  // type wins, so de-duplicate by name keeping the earliest (most specific).
  const priority: Record<EntityType, number> = {
    file: 0,
    symbol: 1,
    package: 2,
    decision: 3,
    service: 4,
    person: 5,
    concept: 6,
  };

  const byName = new Map<string, { name: string; type: EntityType }>();
  for (const entity of found) {
    const key = entity.name.toLowerCase();
    const existing = byName.get(key);
    if (!existing || priority[entity.type] < priority[existing.type]) byName.set(key, entity);
  }

  return [...byName.values()];
}

export function buildKnowledgeGraph(memories: readonly Memory[]): KnowledgeGraph {
  const entities = new Map<string, { entity: KnowledgeEntity; memoryIds: string[] }>();
  const edges = new Map<string, { from: string; to: string; weight: number; memoryIds: string[] }>();

  for (const memory of memories) {
    const extracted = extractEntities(memory.content);
    const ids: string[] = [];

    for (const item of extracted) {
      const id = entityId(item.type, item.name);
      ids.push(id);
      const existing = entities.get(id);
      if (existing) {
        entities.set(id, {
          entity: { ...existing.entity, mentions: existing.entity.mentions + 1 },
          memoryIds: [...existing.memoryIds, memory.id],
        });
      } else {
        entities.set(id, {
          entity: { id, name: item.name, type: item.type, mentions: 1, memoryIds: [] },
          memoryIds: [memory.id],
        });
      }
    }

    // Co-occurrence edges, undirected, stored with a canonical ordering.
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i] as string;
        const b = ids[j] as string;
        const [from, to] = a < b ? [a, b] : [b, a];
        const key = `${from}~${to}`;
        const existing = edges.get(key);
        if (existing) {
          existing.weight++;
          existing.memoryIds.push(memory.id);
        } else {
          edges.set(key, { from, to, weight: 1, memoryIds: [memory.id] });
        }
      }
    }
  }

  return {
    entities: [...entities.values()]
      .map(({ entity, memoryIds }) => ({ ...entity, memoryIds: unique(memoryIds) }))
      .sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name)),
    edges: [...edges.values()]
      .map((edge) => ({ ...edge, memoryIds: unique(edge.memoryIds) }))
      .sort((a, b) => b.weight - a.weight),
  };
}

/** Entities within `depth` hops of a starting entity, breadth-first. */
export function neighbourhood(
  graph: KnowledgeGraph,
  entityId: string,
  depth = 1
): KnowledgeGraph {
  const adjacency = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    const bucket = adjacency.get(from);
    if (bucket) bucket.push(to);
    else adjacency.set(from, [to]);
  };
  for (const edge of graph.edges) {
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }

  const visited = new Set<string>([entityId]);
  let frontier = [entityId];

  for (let level = 0; level < depth; level++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbour of adjacency.get(node) ?? []) {
        if (visited.has(neighbour)) continue;
        visited.add(neighbour);
        next.push(neighbour);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  return {
    entities: graph.entities.filter((entity) => visited.has(entity.id)),
    edges: graph.edges.filter((edge) => visited.has(edge.from) && visited.has(edge.to)),
  };
}

/**
 * The most structurally important entities, by weighted degree centrality.
 * Used to summarise "what this workspace is mostly about".
 */
export function centralEntities(graph: KnowledgeGraph, limit = 10): KnowledgeEntity[] {
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + edge.weight);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + edge.weight);
  }
  return [...graph.entities]
    .sort(
      (a, b) =>
        (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || b.mentions - a.mentions
    )
    .slice(0, limit);
}
