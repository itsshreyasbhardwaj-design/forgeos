import type { RepoSnapshot } from '../fs/types.js';
import { extname } from '../analysis/languages.js';
import type { ErdEntity, ErdRelation } from './mermaid.js';

type ErdColumn = ErdEntity['columns'][number];

/**
 * Database schema extraction.
 *
 * Reads the schema from wherever the project actually declares it — raw SQL
 * DDL, a Prisma schema, or Drizzle table definitions — and normalises all three
 * into entities and relations so the visualiser has one shape to render.
 */
export interface ExtractedSchema {
  readonly entities: readonly ErdEntity[];
  readonly relations: readonly ErdRelation[];
  readonly sources: readonly string[];
  readonly dialect: 'sql' | 'prisma' | 'drizzle' | 'mixed' | 'none';
}

const EMPTY: ExtractedSchema = { entities: [], relations: [], sources: [], dialect: 'none' };

/** `CREATE TABLE` statements, including column types and inline references. */
export function extractSqlSchema(sql: string): { entities: ErdEntity[]; relations: ErdRelation[] } {
  const entities: ErdEntity[] = [];
  const relations: ErdRelation[] = [];

  const tablePattern =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?["`[]?([\w.]+)["`\]]?\s*\(([\s\S]*?)\)\s*(?:;|$)/gi;

  for (const table of sql.matchAll(tablePattern)) {
    const name = (table[1] ?? '').split('.').pop() ?? '';
    const body = table[2] ?? '';
    if (name === '') continue;

    const columns: ErdColumn[] = [];
    // Split on commas that are not inside parentheses (e.g. `numeric(10, 2)`).
    let depth = 0;
    let current = '';
    const parts: string[] = [];
    for (const char of body) {
      if (char === '(') depth++;
      else if (char === ')') depth--;
      if (char === ',' && depth === 0) {
        parts.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    if (current.trim() !== '') parts.push(current);

    for (const rawPart of parts) {
      const part = rawPart.trim();
      if (part === '') continue;

      const foreignKey =
        /foreign\s+key\s*\(\s*["`[]?(\w+)["`\]]?\s*\)\s*references\s+["`[]?([\w.]+)["`\]]?/i.exec(part);
      if (foreignKey) {
        relations.push({
          from: (foreignKey[2] ?? '').split('.').pop() ?? '',
          to: name,
          label: foreignKey[1] ?? 'references',
          cardinality: 'one-to-many',
        });
        continue;
      }

      const primaryKeyConstraint = /^primary\s+key\s*\(([^)]+)\)/i.exec(part);
      if (primaryKeyConstraint) {
        const keys = (primaryKeyConstraint[1] ?? '')
          .split(',')
          .map((key) => key.trim().replace(/["`[\]]/g, ''));
        for (const key of keys) {
          const existing = columns.findIndex((column) => column.name === key);
          if (existing >= 0) {
            columns[existing] = { ...(columns[existing] as ErdColumn), key: 'PK' };
          }
        }
        continue;
      }

      if (/^(constraint|unique|check|index|key)\b/i.test(part)) continue;

      const column = /^["`[]?(\w+)["`\]]?\s+([\w()\s,]+?)(?:\s+(?:not\s+null|null|default|primary|unique|references|generated|check)\b|$)/i.exec(
        part
      );
      if (!column?.[1]) continue;

      const inlineReference = /references\s+["`[]?([\w.]+)["`\]]?/i.exec(part);
      if (inlineReference) {
        relations.push({
          from: (inlineReference[1] ?? '').split('.').pop() ?? '',
          to: name,
          label: column[1],
          cardinality: 'one-to-many',
        });
      }

      columns.push({
        name: column[1],
        type: (column[2] ?? 'text').trim().replace(/\s+/g, '_'),
        ...(/(primary\s+key)/i.test(part)
          ? { key: 'PK' as const }
          : inlineReference
            ? { key: 'FK' as const }
            : /unique/i.test(part)
              ? { key: 'UK' as const }
              : {}),
      });
    }

    entities.push({ name, columns });
  }

  return { entities, relations };
}

/** Prisma models, including `@relation` edges and implicit many-to-many. */
export function extractPrismaSchema(schema: string): {
  entities: ErdEntity[];
  relations: ErdRelation[];
} {
  const entities: ErdEntity[] = [];
  const relations: ErdRelation[] = [];
  const modelNames = new Set<string>();

  const modelPattern = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  const models: { name: string; body: string }[] = [];
  for (const match of schema.matchAll(modelPattern)) {
    const name = match[1] ?? '';
    modelNames.add(name);
    models.push({ name, body: match[2] ?? '' });
  }

  for (const model of models) {
    const columns: ErdColumn[] = [];
    for (const rawLine of model.body.split('\n')) {
      const line = rawLine.split('//')[0]?.trim() ?? '';
      if (line === '' || line.startsWith('@@')) continue;

      const field = /^(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(line);
      if (!field?.[1] || !field[2]) continue;

      const [, fieldName, fieldType, list, optional, rest = ''] = field;

      if (modelNames.has(fieldType)) {
        relations.push({
          from: model.name,
          to: fieldType,
          label: fieldName,
          cardinality: list ? 'one-to-many' : 'one-to-one',
        });
        continue;
      }

      columns.push({
        name: fieldName,
        type: `${fieldType}${list ?? ''}${optional ?? ''}`.replace(/[^A-Za-z0-9_]/g, '_'),
        ...(rest.includes('@id')
          ? { key: 'PK' as const }
          : rest.includes('@unique')
            ? { key: 'UK' as const }
            : {}),
      });
    }
    entities.push({ name: model.name, columns });
  }

  // Collapse the two halves of a bidirectional relation into one edge.
  const deduped: ErdRelation[] = [];
  const seen = new Set<string>();
  for (const relation of relations) {
    const key = [relation.from, relation.to].sort().join('~');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(relation);
  }

  return { entities, relations: deduped };
}

/** Drizzle ORM table definitions. */
export function extractDrizzleSchema(source: string): {
  entities: ErdEntity[];
  relations: ErdRelation[];
} {
  const entities: ErdEntity[] = [];
  const relations: ErdRelation[] = [];

  const tablePattern =
    /(?:export\s+)?const\s+(\w+)\s*=\s*(?:pg|mysql|sqlite)Table\(\s*['"](\w+)['"]\s*,\s*\{([\s\S]*?)\n\s*\}/g;

  for (const table of source.matchAll(tablePattern)) {
    const tableName = table[2] ?? table[1] ?? '';
    const body = table[3] ?? '';
    const columns: ErdColumn[] = [];

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      const field = /^(\w+)\s*:\s*(\w+)\(/.exec(line);
      if (!field?.[1]) continue;

      const reference = /references\(\s*\(\)\s*=>\s*(\w+)\./.exec(line);
      if (reference?.[1]) {
        relations.push({
          from: reference[1],
          to: tableName,
          label: field[1],
          cardinality: 'one-to-many',
        });
      }

      columns.push({
        name: field[1],
        type: field[2] ?? 'text',
        ...(line.includes('primaryKey()')
          ? { key: 'PK' as const }
          : reference
            ? { key: 'FK' as const }
            : line.includes('unique()')
              ? { key: 'UK' as const }
              : {}),
      });
    }

    entities.push({ name: tableName, columns });
  }

  return { entities, relations };
}

/** Detect and extract whatever schema the repository declares. */
export function extractSchema(snapshot: RepoSnapshot): ExtractedSchema {
  const entities: ErdEntity[] = [];
  const relations: ErdRelation[] = [];
  const sources: string[] = [];
  const dialects = new Set<ExtractedSchema['dialect']>();

  for (const file of snapshot.files) {
    if (file.text === null) continue;
    const extension = extname(file.path);

    if (extension === '.sql') {
      const result = extractSqlSchema(file.text);
      if (result.entities.length === 0) continue;
      entities.push(...result.entities);
      relations.push(...result.relations);
      sources.push(file.path);
      dialects.add('sql');
      continue;
    }

    if (extension === '.prisma') {
      const result = extractPrismaSchema(file.text);
      if (result.entities.length === 0) continue;
      entities.push(...result.entities);
      relations.push(...result.relations);
      sources.push(file.path);
      dialects.add('prisma');
      continue;
    }

    if (
      (extension === '.ts' || extension === '.js') &&
      /drizzle-orm/.test(file.text) &&
      /Table\(/.test(file.text)
    ) {
      const result = extractDrizzleSchema(file.text);
      if (result.entities.length === 0) continue;
      entities.push(...result.entities);
      relations.push(...result.relations);
      sources.push(file.path);
      dialects.add('drizzle');
    }
  }

  if (entities.length === 0) return EMPTY;

  // De-duplicate entities that appear in both a migration and a schema file,
  // preferring the definition with the most columns.
  const byName = new Map<string, ErdEntity>();
  for (const entity of entities) {
    const existing = byName.get(entity.name);
    if (!existing || existing.columns.length < entity.columns.length) byName.set(entity.name, entity);
  }

  const known = new Set(byName.keys());
  const validRelations = relations.filter(
    (relation) => known.has(relation.from) && known.has(relation.to)
  );

  return {
    entities: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    relations: validRelations,
    sources,
    dialect: dialects.size === 1 ? ([...dialects][0] as ExtractedSchema['dialect']) : 'mixed',
  };
}
