/**
 * A tiny, safe expression language for workflow node configuration.
 *
 * Workflows need to reference earlier results (`{{steps.analyse.output.name}}`)
 * and branch on them (`steps.scan.output.critical > 0`). The obvious
 * implementation — `eval` or `new Function` — would hand arbitrary code
 * execution to anyone who can edit a workflow, which in a collaborative product
 * means anyone with edit access to a workspace. So this evaluates a deliberately
 * small grammar instead: path lookups, literals, comparisons, and boolean
 * combinators. Nothing can call a function, reach a global, or loop.
 */
export type Scope = Readonly<Record<string, unknown>>;

/** Resolve `a.b[0].c` against a scope. Returns `undefined` for any miss. */
export function resolvePath(scope: Scope, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);

  let cursor: unknown = scope;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    // Never traverse into prototype chains — that is how a template becomes a
    // prototype-pollution primitive.
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      return undefined;
    }
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      cursor = Number.isInteger(index) ? cursor[index] : undefined;
      continue;
    }
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Interpolate `{{path}}` placeholders in a string.
 * An unresolved path renders as an empty string, and is reported so the UI can
 * flag a workflow that references a step which no longer exists.
 */
export function interpolate(
  template: string,
  scope: Scope
): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const text = template.replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_match, path: string) => {
    const value = resolvePath(scope, path);
    if (value === undefined) unresolved.push(path);
    return stringify(value);
  });
  return { text, unresolved };
}

type Operator = '==' | '!=' | '>=' | '<=' | '>' | '<' | 'contains' | 'matches' | 'in';

const OPERATORS: readonly Operator[] = ['>=', '<=', '==', '!=', '>', '<', 'contains', 'matches', 'in'];

function parseLiteral(token: string, scope: Scope): unknown {
  const trimmed = token.trim();
  if (trimmed === '') return undefined;
  if (/^'.*'$/.test(trimmed) || /^".*"$/.test(trimmed)) return trimmed.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (trimmed === 'undefined') return undefined;
  return resolvePath(scope, trimmed);
}

function compare(left: unknown, operator: Operator, right: unknown): boolean {
  switch (operator) {
    case '==':
      // Loose by design: workflow values arrive as strings from form inputs.
      return String(left) === String(right) || left === right;
    case '!=':
      return !(String(left) === String(right) || left === right);
    case '>':
      return Number(left) > Number(right);
    case '<':
      return Number(left) < Number(right);
    case '>=':
      return Number(left) >= Number(right);
    case '<=':
      return Number(left) <= Number(right);
    case 'contains':
      if (Array.isArray(left)) return left.some((item) => String(item) === String(right));
      return String(left ?? '').toLowerCase().includes(String(right ?? '').toLowerCase());
    case 'in':
      if (Array.isArray(right)) return right.some((item) => String(item) === String(left));
      return String(right ?? '').includes(String(left ?? ''));
    case 'matches':
      try {
        return new RegExp(String(right), 'i').test(String(left ?? ''));
      } catch {
        return false;
      }
  }
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '' && value !== 'false';
  if (typeof value === 'object' && value !== null) return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * Evaluate a boolean condition.
 *
 * Grammar (deliberately flat — no parentheses, no nesting):
 *   condition   := clause (('and' | 'or') clause)*
 *   clause      := ['not'] operand [operator operand]
 *   operand     := literal | path
 */
export function evaluateCondition(expression: string, scope: Scope): boolean {
  const trimmed = expression.trim();
  if (trimmed === '') return true;

  // Split on top-level `or`, then `and`; `and` binds tighter.
  const orParts = trimmed.split(/\s+or\s+/i);
  if (orParts.length > 1) {
    return orParts.some((part) => evaluateCondition(part, scope));
  }

  const andParts = trimmed.split(/\s+and\s+/i);
  if (andParts.length > 1) {
    return andParts.every((part) => evaluateCondition(part, scope));
  }

  let clause = trimmed;
  let negate = false;
  const notMatch = /^not\s+(.+)$/i.exec(clause);
  if (notMatch?.[1]) {
    negate = true;
    clause = notMatch[1];
  }

  for (const operator of OPERATORS) {
    const pattern = new RegExp(`^(.+?)\\s+${operator.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')}\\s+(.+)$`, 'i');
    const match = pattern.exec(clause);
    if (!match?.[1] || !match[2]) continue;
    const result = compare(
      parseLiteral(match[1], scope),
      operator,
      parseLiteral(match[2], scope)
    );
    return negate ? !result : result;
  }

  const result = truthy(parseLiteral(clause, scope));
  return negate ? !result : result;
}

/** Deep-interpolate every string in a configuration object. */
export function interpolateDeep(value: unknown, scope: Scope): unknown {
  if (typeof value === 'string') return interpolate(value, scope).text;
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, scope));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = interpolateDeep(item, scope);
    }
    return out;
  }
  return value;
}
