import { type Result, ok, err } from './result.js';
import { invalidInput, type ForgeError } from './errors.js';

/**
 * A tiny structural validator.
 *
 * The web application uses Zod at its HTTP boundary. The kernel cannot: it must
 * stay dependency-free so that plugins, the CLI and edge runtimes can embed it
 * without pulling a validation library. This covers exactly what ForgeOS needs
 * to validate untrusted structured input — plugin manifests, workflow node
 * configuration and imported specifications.
 */
export interface Validator<T> {
  readonly name: string;
  /** Validate `value` at `path`, collecting human-readable issues. */
  check(value: unknown, path: string, issues: Issue[]): value is T;
}

export interface Issue {
  readonly path: string;
  readonly message: string;
}

export type Infer<V> = V extends Validator<infer T> ? T : never;

function validator<T>(name: string, fn: (value: unknown, path: string, issues: Issue[]) => boolean) {
  return {
    name,
    check(value: unknown, path: string, issues: Issue[]): value is T {
      return fn(value, path, issues);
    },
  } satisfies Validator<T>;
}

const fail = (issues: Issue[], path: string, message: string): false => {
  issues.push({ path: path || '(root)', message });
  return false;
};

export const s = {
  string(options: { min?: number; max?: number; pattern?: RegExp } = {}): Validator<string> {
    return validator<string>('string', (value, path, issues) => {
      if (typeof value !== 'string') return fail(issues, path, 'expected a string');
      if (options.min !== undefined && value.length < options.min) {
        return fail(issues, path, `expected at least ${options.min} characters`);
      }
      if (options.max !== undefined && value.length > options.max) {
        return fail(issues, path, `expected at most ${options.max} characters`);
      }
      if (options.pattern && !options.pattern.test(value)) {
        return fail(issues, path, `does not match ${String(options.pattern)}`);
      }
      return true;
    });
  },

  number(options: { min?: number; max?: number; int?: boolean } = {}): Validator<number> {
    return validator<number>('number', (value, path, issues) => {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return fail(issues, path, 'expected a number');
      }
      if (options.int && !Number.isInteger(value)) return fail(issues, path, 'expected an integer');
      if (options.min !== undefined && value < options.min) {
        return fail(issues, path, `expected >= ${options.min}`);
      }
      if (options.max !== undefined && value > options.max) {
        return fail(issues, path, `expected <= ${options.max}`);
      }
      return true;
    });
  },

  boolean(): Validator<boolean> {
    return validator<boolean>('boolean', (value, path, issues) =>
      typeof value === 'boolean' ? true : fail(issues, path, 'expected a boolean')
    );
  },

  literal<const T extends string | number | boolean>(expected: T): Validator<T> {
    return validator<T>('literal', (value, path, issues) =>
      value === expected ? true : fail(issues, path, `expected ${JSON.stringify(expected)}`)
    );
  },

  enum<const T extends readonly string[]>(values: T): Validator<T[number]> {
    return validator<T[number]>('enum', (value, path, issues) =>
      typeof value === 'string' && values.includes(value)
        ? true
        : fail(issues, path, `expected one of: ${values.join(', ')}`)
    );
  },

  array<T>(item: Validator<T>, options: { min?: number; max?: number } = {}): Validator<T[]> {
    return validator<T[]>('array', (value, path, issues) => {
      if (!Array.isArray(value)) return fail(issues, path, 'expected an array');
      if (options.min !== undefined && value.length < options.min) {
        return fail(issues, path, `expected at least ${options.min} items`);
      }
      if (options.max !== undefined && value.length > options.max) {
        return fail(issues, path, `expected at most ${options.max} items`);
      }
      let valid = true;
      value.forEach((entry, index) => {
        if (!item.check(entry, `${path}[${index}]`, issues)) valid = false;
      });
      return valid;
    });
  },

  record<T>(value: Validator<T>): Validator<Record<string, T>> {
    return validator<Record<string, T>>('record', (input, path, issues) => {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return fail(issues, path, 'expected an object');
      }
      let valid = true;
      for (const [key, entry] of Object.entries(input)) {
        if (!value.check(entry, path ? `${path}.${key}` : key, issues)) valid = false;
      }
      return valid;
    });
  },

  object<Shape extends Record<string, Validator<unknown>>>(
    shape: Shape,
    options: { optional?: readonly (keyof Shape)[] } = {}
  ): Validator<{ [K in keyof Shape]: Infer<Shape[K]> }> {
    const optional = new Set((options.optional ?? []) as readonly string[]);
    return validator<{ [K in keyof Shape]: Infer<Shape[K]> }>('object', (value, path, issues) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return fail(issues, path, 'expected an object');
      }
      const input = value as Record<string, unknown>;
      let valid = true;
      for (const [key, fieldValidator] of Object.entries(shape)) {
        const fieldPath = path ? `${path}.${key}` : key;
        if (!(key in input) || input[key] === undefined) {
          if (optional.has(key)) continue;
          valid = fail(issues, fieldPath, 'is required');
          continue;
        }
        if (!fieldValidator.check(input[key], fieldPath, issues)) valid = false;
      }
      return valid;
    });
  },

  optional<T>(inner: Validator<T>): Validator<T | undefined> {
    return validator<T | undefined>('optional', (value, path, issues) =>
      value === undefined ? true : inner.check(value, path, issues)
    );
  },

  union<T extends readonly Validator<unknown>[]>(members: T): Validator<Infer<T[number]>> {
    return validator<Infer<T[number]>>('union', (value, path, issues) => {
      for (const member of members) {
        if (member.check(value, path, [])) return true;
      }
      return fail(issues, path, `did not match any of: ${members.map((m) => m.name).join(' | ')}`);
    });
  },

  unknown(): Validator<unknown> {
    return validator<unknown>('unknown', () => true);
  },
};

/** Validate `value`, returning either the typed value or a descriptive error. */
export function parse<T>(schema: Validator<T>, value: unknown): Result<T, ForgeError> {
  const issues: Issue[] = [];
  if (schema.check(value, '', issues)) return ok(value);
  const summary = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
  return err(invalidInput(summary || 'validation failed', { issues }));
}
