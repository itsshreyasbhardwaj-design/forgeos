import { fuzzyScore, tokenize } from '../kernel/text.js';

/**
 * Full-text search over every entity in a workspace.
 *
 * Uses Okapi BM25 rather than plain TF-IDF because BM25's term-frequency
 * saturation is exactly what a code search needs: a file that mentions
 * `useState` two hundred times is not a hundred times more relevant than one
 * that mentions it twice, and BM25 is the standard way of saying so.
 *
 * The index is deliberately in-memory and rebuildable. Persisting an inverted
 * index invites it to drift out of sync with the data it describes; rebuilding
 * a workspace-sized index takes milliseconds.
 */
export type SearchKind =
  | 'repository'
  | 'file'
  | 'symbol'
  | 'document'
  | 'api'
  | 'memory'
  | 'workflow'
  | 'benchmark'
  | 'finding'
  | 'conversation';

export interface SearchDocument {
  readonly id: string;
  readonly kind: SearchKind;
  readonly title: string;
  /** Indexed body text. */
  readonly body: string;
  /** Where the UI should navigate on selection. */
  readonly href: string;
  readonly workspaceId?: string;
  readonly projectId?: string;
  /** Static importance multiplier, e.g. a README outranks a lockfile. */
  readonly boost?: number;
  readonly updatedAt?: number;
  readonly meta?: Readonly<Record<string, string | number | boolean>>;
}

export interface SearchHit {
  readonly document: SearchDocument;
  readonly score: number;
  /** Terms that matched, for highlighting. */
  readonly matched: readonly string[];
  /** A short excerpt around the best match. */
  readonly excerpt: string;
}

export interface SearchOptions {
  readonly limit?: number;
  readonly kinds?: readonly SearchKind[];
  readonly workspaceId?: string;
  readonly projectId?: string;
  /** Blend in fuzzy title matching for command-palette style queries. */
  readonly fuzzyTitles?: boolean;
}

interface Posting {
  readonly docIndex: number;
  readonly termFrequency: number;
  /** Term appears in the title, which is worth far more than a body hit. */
  readonly inTitle: boolean;
}

const K1 = 1.5;
const B = 0.75;
const TITLE_BOOST = 2.5;

export class SearchIndex {
  private documents: SearchDocument[] = [];
  private postings = new Map<string, Posting[]>();
  private lengths: number[] = [];
  private averageLength = 0;

  get size(): number {
    return this.documents.length;
  }

  add(document: SearchDocument): void {
    const docIndex = this.documents.length;
    this.documents.push(document);

    const titleTokens = tokenize(document.title);
    const bodyTokens = tokenize(document.body);
    const titleSet = new Set(titleTokens);

    const frequencies = new Map<string, number>();
    for (const token of [...titleTokens, ...bodyTokens]) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }

    for (const [term, termFrequency] of frequencies) {
      const bucket = this.postings.get(term) ?? [];
      bucket.push({ docIndex, termFrequency, inTitle: titleSet.has(term) });
      this.postings.set(term, bucket);
    }

    const length = titleTokens.length + bodyTokens.length;
    this.lengths.push(length);
    this.averageLength =
      (this.averageLength * (this.lengths.length - 1) + length) / this.lengths.length;
  }

  addAll(documents: Iterable<SearchDocument>): void {
    for (const document of documents) this.add(document);
  }

  clear(): void {
    this.documents = [];
    this.postings.clear();
    this.lengths = [];
    this.averageLength = 0;
  }

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const limit = options.limit ?? 20;
    const terms = tokenize(query);
    const totalDocuments = this.documents.length;
    if (totalDocuments === 0) return [];

    const allowedKinds = options.kinds ? new Set(options.kinds) : null;
    const scores = new Map<number, number>();
    const matchedTerms = new Map<number, Set<string>>();

    for (const term of terms) {
      const bucket = this.postings.get(term);
      if (!bucket) continue;

      // BM25 IDF. The +0.5 smoothing keeps very common terms from going
      // negative, which would otherwise *penalise* documents for matching.
      const documentFrequency = bucket.length;
      const idf = Math.log(
        1 + (totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5)
      );

      for (const posting of bucket) {
        const length = this.lengths[posting.docIndex] ?? 1;
        const numerator = posting.termFrequency * (K1 + 1);
        const denominator =
          posting.termFrequency + K1 * (1 - B + (B * length) / Math.max(1, this.averageLength));
        const weight = idf * (numerator / denominator) * (posting.inTitle ? TITLE_BOOST : 1);

        scores.set(posting.docIndex, (scores.get(posting.docIndex) ?? 0) + weight);
        const matched = matchedTerms.get(posting.docIndex) ?? new Set<string>();
        matched.add(term);
        matchedTerms.set(posting.docIndex, matched);
      }
    }

    // Fuzzy title matching catches the command-palette case where the user
    // types `wkflw` and means `Workflows` — no token would ever match.
    if (options.fuzzyTitles !== false && query.trim().length >= 2) {
      this.documents.forEach((document, index) => {
        const fuzzy = fuzzyScore(query.replace(/\s+/g, ''), document.title);
        if (fuzzy === null) return;
        scores.set(index, (scores.get(index) ?? 0) + fuzzy * 0.15);
      });
    }

    const hits: SearchHit[] = [];
    for (const [docIndex, rawScore] of scores) {
      const document = this.documents[docIndex];
      if (!document) continue;
      if (allowedKinds && !allowedKinds.has(document.kind)) continue;
      if (options.workspaceId && document.workspaceId !== options.workspaceId) continue;
      if (options.projectId && document.projectId !== options.projectId) continue;

      const score = rawScore * (document.boost ?? 1);
      if (score <= 0) continue;

      const matched = [...(matchedTerms.get(docIndex) ?? [])];
      hits.push({
        document,
        score: Math.round(score * 1000) / 1000,
        matched,
        excerpt: buildExcerpt(document.body, matched),
      });
    }

    return hits
      .sort((a, b) => b.score - a.score || (b.document.updatedAt ?? 0) - (a.document.updatedAt ?? 0))
      .slice(0, limit);
  }
}

/** Extract a readable window of text around the first matching term. */
export function buildExcerpt(body: string, terms: readonly string[], width = 180): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= width) return flat;
  if (terms.length === 0) return `${flat.slice(0, width)}…`;

  const lower = flat.toLowerCase();
  let best = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index !== -1 && (best === -1 || index < best)) best = index;
  }
  if (best === -1) return `${flat.slice(0, width)}…`;

  const start = Math.max(0, best - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

/** Group hits by kind, preserving rank, for the segmented search UI. */
export function groupHits(hits: readonly SearchHit[]): { kind: SearchKind; hits: SearchHit[] }[] {
  const groups = new Map<SearchKind, SearchHit[]>();
  for (const hit of hits) {
    const bucket = groups.get(hit.document.kind) ?? [];
    bucket.push(hit);
    groups.set(hit.document.kind, bucket);
  }
  return [...groups.entries()]
    .map(([kind, kindHits]) => ({ kind, hits: kindHits }))
    .sort((a, b) => (b.hits[0]?.score ?? 0) - (a.hits[0]?.score ?? 0));
}
