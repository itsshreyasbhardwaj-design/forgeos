import { describe, expect, it } from 'vitest';
import { attempt, err, isErr, isOk, ok, partition, unwrapOr } from './result.js';
import { ForgeError, invalidInput, notFound } from './errors.js';
import { createId, deterministicId, isId, slugify } from './id.js';
import { contentHash, fnv1a32, seededRandom, shannonEntropy } from './hash.js';
import { createLogger, memoryTransport, redact, type LogRecord } from './logger.js';
import { parse, s } from './schema.js';
import { compareVersionStrings, coerceVersion, parseVersion, satisfies } from './semver.js';
import { fuzzyScore, groupBy, tokenize, truncate, unique } from './text.js';
import { parseJsonc, stripJsonComments } from './jsonc.js';

describe('result', () => {
  it('discriminates success from failure', () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isErr(err('bad'))).toBe(true);
    expect(unwrapOr(err<string>('bad'), 42)).toBe(42);
  });

  it('captures thrown errors', () => {
    const result = attempt(() => {
      throw new Error('boom');
    });
    expect(isErr(result)).toBe(true);
  });

  it('partitions a mixed list', () => {
    const { values, errors } = partition([ok(1), err('a'), ok(2)]);
    expect(values).toEqual([1, 2]);
    expect(errors).toEqual(['a']);
  });
});

describe('errors', () => {
  it('maps codes to HTTP statuses', () => {
    expect(invalidInput('nope').status).toBe(400);
    expect(notFound('project', 'x').status).toBe(404);
    expect(new ForgeError('internal').status).toBe(500);
  });

  it('serialises without leaking the cause', () => {
    const error = new ForgeError('failed', { code: 'conflict', cause: new Error('secret detail') });
    const json = JSON.stringify(error.toJSON());
    expect(json).toContain('conflict');
    expect(json).not.toContain('secret detail');
  });
});

describe('identifiers', () => {
  it('creates sortable prefixed ids', () => {
    const early = createId('wsp', 1_000);
    const late = createId('wsp', 2_000);
    expect(isId(early, 'wsp')).toBe(true);
    expect(early < late).toBe(true);
  });

  it('derives the same id from the same inputs', () => {
    expect(deterministicId('anl', 'a', 'b')).toBe(deterministicId('anl', 'a', 'b'));
    expect(deterministicId('anl', 'a', 'b')).not.toBe(deterministicId('anl', 'a', 'c'));
  });

  it('slugifies safely and never returns an empty string', () => {
    expect(slugify('My Project!')).toBe('my-project');
    expect(slugify('café')).toBe('cafe');
    expect(slugify('   ')).toBe('untitled');
  });
});

describe('hashing', () => {
  it('is stable and content-addressed', () => {
    expect(fnv1a32('abc')).toBe(fnv1a32('abc'));
    expect(contentHash('abc')).toBe(contentHash('abc'));
    expect(contentHash('abc')).not.toBe(contentHash('abd'));
  });

  it('produces a reproducible random sequence from a seed', () => {
    const a = seededRandom('seed');
    const b = seededRandom('seed');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('measures entropy', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
    expect(shannonEntropy('a1B2c3D4!@')).toBeGreaterThan(3);
  });
});

describe('logging', () => {
  it('redacts secret-looking fields', () => {
    const redacted = redact({ apiKey: 'abc', nested: { password: 'x', safe: 1 } }) as Record<
      string,
      unknown
    >;
    expect(redacted.apiKey).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).password).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).safe).toBe(1);
  });

  it('respects the level threshold and child scoping', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: 'warn', transport: memoryTransport(records) });
    logger.debug('ignored');
    logger.warn('kept');
    logger.child('sub').error('nested');

    expect(records.map((record) => record.message)).toEqual(['kept', 'nested']);
    expect(records[1]?.scope).toBe('forgeos:sub');
  });
});

describe('schema validation', () => {
  const schema = s.object(
    {
      name: s.string({ min: 1 }),
      count: s.number({ int: true, min: 0 }),
      mode: s.enum(['fast', 'slow'] as const),
      tags: s.optional(s.array(s.string())),
    },
    { optional: ['tags'] }
  );

  it('accepts valid input', () => {
    const result = parse(schema, { name: 'a', count: 2, mode: 'fast' });
    expect(isOk(result)).toBe(true);
  });

  it('reports every problem with its path', () => {
    const result = parse(schema, { name: '', count: 1.5, mode: 'sideways' });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.message).toContain('name');
      expect(result.error.message).toContain('count');
      expect(result.error.message).toContain('mode');
    }
  });

  it('rejects a missing required field', () => {
    expect(isErr(parse(schema, { count: 1, mode: 'fast' }))).toBe(true);
  });
});

describe('semver', () => {
  it('parses and orders versions, including prereleases', () => {
    expect(parseVersion('1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('not-a-version')).toBeNull();
    expect(compareVersionStrings('1.2.3', '1.10.0')).toBeLessThan(0);
    expect(compareVersionStrings('1.0.0-alpha', '1.0.0')).toBeLessThan(0);
  });

  it('evaluates the range syntax that appears in real manifests', () => {
    expect(satisfies('1.2.5', '^1.2.3')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false);
    expect(satisfies('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfies('1.5.0', '>=1.2.0 <2.0.0')).toBe(true);
    expect(satisfies('1.5.0', '1.0.0 - 2.0.0')).toBe(true);
    expect(satisfies('3.0.0', '^1.0.0 || ^3.0.0')).toBe(true);
    expect(satisfies('1.2.3', '*')).toBe(true);
  });

  it('coerces a range down to a concrete version', () => {
    expect(coerceVersion('^4.17.20')).toBe('4.17.20');
    expect(coerceVersion('no numbers')).toBeNull();
  });
});

describe('text', () => {
  it('splits identifiers on case and underscore boundaries', () => {
    const tokens = tokenize('parseRepositoryAnalysis snake_case_name');
    expect(tokens).toEqual(expect.arrayContaining(['parserepositoryanalysis', 'parse', 'repository', 'snake', 'case']));
  });

  it('scores fuzzy matches and rejects non-subsequences', () => {
    expect(fuzzyScore('wkfl', 'Workflows')).toBeGreaterThan(0);
    expect(fuzzyScore('zzz', 'Workflows')).toBeNull();
    const exact = fuzzyScore('work', 'Workflows') ?? 0;
    const scattered = fuzzyScore('wrfs', 'Workflows') ?? 0;
    expect(exact).toBeGreaterThan(scattered);
  });

  it('truncates, de-duplicates and groups', () => {
    expect(truncate('abcdefghij', 5)).toHaveLength(5);
    expect(unique([1, 2, 2, 3])).toEqual([1, 2, 3]);
    expect(groupBy(['aa', 'ab', 'bc'], (value) => value[0] as 'a' | 'b')).toEqual({
      a: ['aa', 'ab'],
      b: ['bc'],
    });
  });
});

describe('jsonc', () => {
  // Regression: a regex stripper treated the `/*` inside a string as a comment.
  it('does not treat comment markers inside strings as comments', () => {
    const text = '{ "paths": { "@/*": ["./src/*"] } }';
    expect(stripJsonComments(text)).toBe(text);
    expect(parseJsonc(text)).toEqual({ paths: { '@/*': ['./src/*'] } });
  });

  it('strips real comments and trailing commas', () => {
    expect(
      parseJsonc(`{
        // a line comment
        "a": 1, /* inline */
        "b": [1, 2,],
      }`)
    ).toEqual({ a: 1, b: [1, 2] });
  });

  it('returns null rather than throwing on malformed input', () => {
    expect(parseJsonc('{ definitely not json')).toBeNull();
  });
});
