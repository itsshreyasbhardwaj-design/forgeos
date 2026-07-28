import { cosineSimilarity, localEmbeddingProvider, type EmbeddingProvider } from './embedding.js';
import { SearchIndex, type SearchDocument } from '../search/index.js';
import { createId } from '../kernel/id.js';
import { round } from '../kernel/text.js';

/**
 * Long-term semantic memory.
 *
 * Retrieval is **hybrid**: BM25 lexical scoring and vector similarity are run
 * independently and fused with reciprocal rank fusion. This is not
 * over-engineering — the two methods fail in opposite directions. Lexical
 * search misses paraphrase; vector search misses exact identifiers, which is
 * catastrophic for a developer tool where the query is often a literal function
 * name. Fusing them recovers both.
 */
export type MemoryKind = 'fact' | 'decision' | 'preference' | 'summary' | 'snippet' | 'observation';

export interface Memory {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: MemoryKind;
  readonly content: string;
  /** Where this memory came from: a conversation, a file, an analysis. */
  readonly source: string;
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 0–1. Decays with age unless reinforced by retrieval. */
  readonly importance: number;
  readonly accessCount: number;
  readonly lastAccessedAt?: number;
  readonly projectId?: string;
  readonly embedding?: readonly number[];
  readonly meta?: Readonly<Record<string, string | number | boolean>>;
}

export interface MemoryInput {
  readonly workspaceId: string;
  readonly kind?: MemoryKind;
  readonly content: string;
  readonly source?: string;
  readonly tags?: readonly string[];
  readonly importance?: number;
  readonly projectId?: string;
  readonly meta?: Readonly<Record<string, string | number | boolean>>;
}

export interface RetrievalResult {
  readonly memory: Memory;
  readonly score: number;
  readonly lexicalRank: number | null;
  readonly semanticRank: number | null;
  readonly similarity: number;
}

export interface RetrieveOptions {
  readonly limit?: number;
  readonly kinds?: readonly MemoryKind[];
  readonly projectId?: string;
  readonly tags?: readonly string[];
  /** Minimum cosine similarity for a vector hit. Default 0.15. */
  readonly minSimilarity?: number;
  /** Reciprocal rank fusion constant. Higher flattens the ranking. */
  readonly rrfK?: number;
}

/**
 * Half-life, in days, of a memory's importance. A memory not retrieved for
 * this long is worth half what it was, which keeps stale context from crowding
 * out current context.
 */
export const IMPORTANCE_HALF_LIFE_DAYS = 45;

export function decayedImportance(memory: Memory, now: number): number {
  const reference = memory.lastAccessedAt ?? memory.createdAt;
  const ageDays = Math.max(0, (now - reference) / 86_400_000);
  const decay = Math.pow(0.5, ageDays / IMPORTANCE_HALF_LIFE_DAYS);
  // Frequently retrieved memories resist decay.
  const reinforcement = Math.min(1, memory.accessCount / 20);
  return round(memory.importance * (decay + (1 - decay) * reinforcement), 4);
}

export class MemoryStore {
  private memories = new Map<string, Memory>();
  private index = new SearchIndex();
  private indexDirty = false;

  constructor(
    private readonly embedder: EmbeddingProvider = localEmbeddingProvider,
    private readonly now: () => number = Date.now
  ) {}

  get size(): number {
    return this.memories.size;
  }

  async remember(input: MemoryInput): Promise<Memory> {
    const timestamp = this.now();
    const [embedding] = await this.embedder.embed([input.content]);

    const memory: Memory = {
      id: createId('mem', timestamp),
      workspaceId: input.workspaceId,
      kind: input.kind ?? 'fact',
      content: input.content,
      source: input.source ?? 'manual',
      tags: input.tags ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
      importance: Math.min(1, Math.max(0, input.importance ?? 0.5)),
      accessCount: 0,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(embedding ? { embedding } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    };

    this.memories.set(memory.id, memory);
    this.indexDirty = true;
    return memory;
  }

  /** Insert pre-built memories, e.g. when hydrating from a database. */
  load(memories: Iterable<Memory>): void {
    for (const memory of memories) this.memories.set(memory.id, memory);
    this.indexDirty = true;
  }

  get(id: string): Memory | undefined {
    return this.memories.get(id);
  }

  forget(id: string): boolean {
    const deleted = this.memories.delete(id);
    if (deleted) this.indexDirty = true;
    return deleted;
  }

  all(workspaceId?: string): Memory[] {
    const list = [...this.memories.values()];
    const filtered = workspaceId ? list.filter((m) => m.workspaceId === workspaceId) : list;
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }

  private rebuildIndex(): void {
    if (!this.indexDirty) return;
    this.index.clear();
    for (const memory of this.memories.values()) {
      this.index.add(toSearchDocument(memory));
    }
    this.indexDirty = false;
  }

  /**
   * Hybrid retrieval with reciprocal rank fusion.
   *
   * RRF is used rather than a weighted score sum because the two scorers are on
   * incomparable scales — a BM25 score of 8 and a cosine of 0.4 cannot be added
   * meaningfully. Fusing *ranks* sidesteps the normalisation problem entirely.
   */
  async retrieve(
    workspaceId: string,
    query: string,
    options: RetrieveOptions = {}
  ): Promise<RetrievalResult[]> {
    const limit = options.limit ?? 8;
    const rrfK = options.rrfK ?? 60;
    const minSimilarity = options.minSimilarity ?? 0.15;
    const now = this.now();

    const candidates = [...this.memories.values()].filter((memory) => {
      if (memory.workspaceId !== workspaceId) return false;
      if (options.projectId && memory.projectId !== options.projectId) return false;
      if (options.kinds && !options.kinds.includes(memory.kind)) return false;
      if (options.tags?.length && !options.tags.some((tag) => memory.tags.includes(tag))) {
        return false;
      }
      return true;
    });
    if (candidates.length === 0) return [];

    const allowed = new Set(candidates.map((memory) => memory.id));

    this.rebuildIndex();
    const lexicalHits = this.index
      .search(query, { limit: limit * 5, workspaceId, fuzzyTitles: false })
      .filter((hit) => allowed.has(hit.document.id));

    const lexicalRank = new Map<string, number>();
    lexicalHits.forEach((hit, index) => lexicalRank.set(hit.document.id, index + 1));

    const [queryVector] = await this.embedder.embed([query]);
    const similarities = new Map<string, number>();

    if (queryVector) {
      for (const memory of candidates) {
        if (!memory.embedding) continue;
        const similarity = cosineSimilarity(queryVector, memory.embedding);
        if (similarity >= minSimilarity) similarities.set(memory.id, similarity);
      }
    }

    const semanticRank = new Map<string, number>();
    [...similarities.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([id], index) => semanticRank.set(id, index + 1));

    const results: RetrievalResult[] = [];
    const considered = new Set([...lexicalRank.keys(), ...semanticRank.keys()]);

    for (const id of considered) {
      const memory = this.memories.get(id);
      if (!memory) continue;

      const lexical = lexicalRank.get(id) ?? null;
      const semantic = semanticRank.get(id) ?? null;
      const fused =
        (lexical === null ? 0 : 1 / (rrfK + lexical)) +
        (semantic === null ? 0 : 1 / (rrfK + semantic));

      // Importance nudges ranking without being able to override relevance.
      const score = fused * (1 + decayedImportance(memory, now));

      results.push({
        memory,
        score: round(score, 6),
        lexicalRank: lexical,
        semanticRank: semantic,
        similarity: round(similarities.get(id) ?? 0, 4),
      });
    }

    const ranked = results.sort((a, b) => b.score - a.score).slice(0, limit);

    // Retrieval is reinforcement: touched memories decay more slowly.
    for (const result of ranked) {
      const updated: Memory = {
        ...result.memory,
        accessCount: result.memory.accessCount + 1,
        lastAccessedAt: now,
      };
      this.memories.set(updated.id, updated);
    }

    return ranked;
  }

  /** Memories most similar to a given memory. Powers "related context". */
  related(id: string, limit = 5): RetrievalResult[] {
    const target = this.memories.get(id);
    if (!target?.embedding) return [];

    return [...this.memories.values()]
      .filter(
        (memory) =>
          memory.id !== id && memory.workspaceId === target.workspaceId && memory.embedding
      )
      .map((memory) => ({
        memory,
        similarity: round(cosineSimilarity(target.embedding as number[], memory.embedding as number[]), 4),
        score: 0,
        lexicalRank: null,
        semanticRank: null,
      }))
      .filter((result) => result.similarity > 0.2)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
      .map((result) => ({ ...result, score: result.similarity }));
  }

  /**
   * Find near-duplicate memories so the same fact is not stored five times.
   * Returns groups; the caller decides which to keep.
   */
  duplicates(workspaceId: string, threshold = 0.92): Memory[][] {
    const memories = [...this.memories.values()].filter(
      (memory) => memory.workspaceId === workspaceId && memory.embedding
    );
    const groups: Memory[][] = [];
    const claimed = new Set<string>();

    for (const memory of memories) {
      if (claimed.has(memory.id)) continue;
      const group = [memory];
      claimed.add(memory.id);

      for (const other of memories) {
        if (claimed.has(other.id)) continue;
        const similarity = cosineSimilarity(
          memory.embedding as number[],
          other.embedding as number[]
        );
        if (similarity >= threshold) {
          group.push(other);
          claimed.add(other.id);
        }
      }

      if (group.length > 1) groups.push(group);
    }

    return groups;
  }
}

export function toSearchDocument(memory: Memory): SearchDocument {
  return {
    id: memory.id,
    kind: 'memory',
    title: memory.content.slice(0, 80),
    body: `${memory.content} ${memory.tags.join(' ')}`,
    href: `/memory/${memory.id}`,
    workspaceId: memory.workspaceId,
    ...(memory.projectId ? { projectId: memory.projectId } : {}),
    updatedAt: memory.updatedAt,
    boost: 1 + memory.importance * 0.5,
  };
}

/**
 * Assemble retrieved memories into a prompt block within a token budget.
 * Budget is approximated at four characters per token, which is close enough
 * for a context-packing decision and costs nothing to compute.
 */
export function packMemories(results: readonly RetrievalResult[], maxTokens = 800): string {
  const budget = maxTokens * 4;
  const lines: string[] = [];
  let used = 0;

  for (const result of results) {
    const line = `- (${result.memory.kind}) ${result.memory.content}`;
    // Count the separator too: joining N lines adds N-1 newlines, and ignoring
    // them lets the packed block overrun the budget it was given.
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (used + cost > budget) break;
    lines.push(line);
    used += cost;
  }

  return lines.join('\n');
}
