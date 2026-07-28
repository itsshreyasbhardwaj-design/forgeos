import { fnv1a32 } from '../kernel/hash.js';
import { nGrams, tokenize } from '../kernel/text.js';

/**
 * Embeddings.
 *
 * ForgeOS must produce useful semantic recall with no API key, no network and
 * no cost, so the default provider is a **local lexical embedder** built on the
 * hashing trick: tokens and character trigrams are hashed into a fixed-width
 * signed vector, weighted, and L2-normalised. Cosine similarity over these
 * vectors captures lexical and morphological relatedness — `authenticate` and
 * `authentication` land close together — and it is fully deterministic, which
 * makes retrieval reproducible and testable.
 *
 * What it does *not* do is capture meaning across different vocabulary:
 * "car" and "automobile" are unrelated to it. That is a real limitation, and
 * the reason {@link EmbeddingProvider} exists — point it at a hosted embedding
 * model and every consumer improves with no other change.
 */
export const LOCAL_EMBEDDING_DIMENSIONS = 384;

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

/**
 * Hash a feature into a bucket and a sign. The sign is what makes feature
 * hashing work: collisions cancel out on average instead of accumulating.
 */
function bucketOf(feature: string, dimensions: number): { index: number; sign: number } {
  const hash = fnv1a32(feature);
  return {
    index: hash % dimensions,
    sign: (fnv1a32(`${feature}#sign`) & 1) === 0 ? 1 : -1,
  };
}

export function embedLocal(text: string, dimensions = LOCAL_EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);

  const tokens = tokenize(text, { stopWords: true });
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

  for (const [token, count] of counts) {
    // Sub-linear term frequency: the tenth occurrence matters far less than
    // the second, exactly as in TF-IDF.
    const weight = 1 + Math.log(count);
    const { index, sign } = bucketOf(token, dimensions);
    vector[index] = (vector[index] ?? 0) + sign * weight;

    // Character trigrams give partial credit for morphological variants and
    // for typos, which pure token matching cannot do.
    for (const gram of nGrams(token, 3)) {
      const gramBucket = bucketOf(`g:${gram}`, dimensions);
      vector[gramBucket.index] = (vector[gramBucket.index] ?? 0) + gramBucket.sign * weight * 0.25;
    }
  }

  return normalise(vector);
}

/** L2-normalise in place and return the vector. */
export function normalise(vector: number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  if (sumSquares === 0) return vector;
  const inverse = 1 / Math.sqrt(sumSquares);
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) * inverse;
  return vector;
}

/** Cosine similarity. Assumes both vectors are already normalised. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

export const localEmbeddingProvider: EmbeddingProvider = {
  id: 'forge-local',
  dimensions: LOCAL_EMBEDDING_DIMENSIONS,
  async embed(texts) {
    return texts.map((text) => embedLocal(text));
  },
};

/**
 * An embedding provider backed by an OpenAI-compatible `/embeddings` endpoint.
 * Only constructed when an API key is configured.
 */
export function createRemoteEmbeddingProvider(options: {
  readonly id?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly dimensions: number;
  readonly fetchImpl?: typeof fetch;
}): EmbeddingProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    id: options.id ?? options.model,
    dimensions: options.dimensions,
    async embed(texts) {
      const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ model: options.model, input: texts }),
      });
      if (!response.ok) {
        throw new Error(`Embedding request failed with status ${response.status}`);
      }
      const body = (await response.json()) as { data?: { embedding: number[] }[] };
      return (body.data ?? []).map((entry) => normalise([...entry.embedding]));
    },
  };
}

/**
 * Split long text into overlapping chunks on natural boundaries.
 *
 * Overlap matters: a fact that straddles a chunk boundary is otherwise
 * unretrievable, because neither chunk contains it in full.
 */
export function chunkText(
  text: string,
  options: { maxChars?: number; overlap?: number } = {}
): string[] {
  const maxChars = options.maxChars ?? 1200;
  const overlap = options.overlap ?? 150;
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed === '' ? [] : [trimmed];

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < trimmed.length) {
    let end = Math.min(trimmed.length, cursor + maxChars);

    if (end < trimmed.length) {
      // Prefer a paragraph break, then a sentence end, then a line break.
      const window = trimmed.slice(cursor, end);
      const boundary = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('. '),
        window.lastIndexOf('\n')
      );
      if (boundary > maxChars * 0.5) end = cursor + boundary + 1;
    }

    chunks.push(trimmed.slice(cursor, end).trim());
    if (end >= trimmed.length) break;
    cursor = Math.max(cursor + 1, end - overlap);
  }

  return chunks.filter((chunk) => chunk.length > 0);
}
