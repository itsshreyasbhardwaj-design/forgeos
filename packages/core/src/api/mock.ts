import { exampleForSchema, type ApiSpec, type Operation, type Schema } from './openapi.js';
import { seededRandom, fnv1a32 } from '../kernel/hash.js';

/**
 * A specification-driven mock server.
 *
 * Runs as a pure function — request in, response out — so it can be mounted
 * behind any HTTP framework, invoked directly in tests, or run in a browser
 * service worker. Responses are deterministic per (method, path, status), which
 * is the property that makes a mock usable as a test fixture.
 */
export interface MockRequest {
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface MockResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly matchedOperation?: string;
  readonly latencyMs: number;
}

export interface MockOptions {
  /** Force a specific status code, to exercise error handling. */
  readonly forceStatus?: number;
  /** Simulated latency in milliseconds. */
  readonly latencyMs?: number;
  /** Reject requests missing a configured security scheme. Default true. */
  readonly enforceSecurity?: boolean;
  /** Validate request bodies against the declared schema. Default true. */
  readonly validateRequests?: boolean;
}

/** Compile `/users/:id` into a matcher that also extracts parameters. */
export function matchPath(
  template: string,
  actual: string
): Readonly<Record<string, string>> | null {
  const templateParts = template.split('/').filter(Boolean);
  const actualParts = actual.split('?')[0]?.split('/').filter(Boolean) ?? [];

  const params: Record<string, string> = {};
  let templateIndex = 0;
  let actualIndex = 0;

  while (templateIndex < templateParts.length) {
    const segment = templateParts[templateIndex] as string;

    if (segment.startsWith('*')) {
      // Catch-all consumes the remainder.
      params[segment.slice(1)] = actualParts.slice(actualIndex).join('/');
      return params;
    }

    const actualSegment = actualParts[actualIndex];
    if (actualSegment === undefined) return null;

    if (segment.startsWith(':')) {
      params[segment.slice(1)] = decodeURIComponent(actualSegment);
    } else if (segment !== actualSegment) {
      return null;
    }

    templateIndex++;
    actualIndex++;
  }

  return actualIndex === actualParts.length ? params : null;
}

export interface RouteMatch {
  readonly operation: Operation;
  readonly params: Readonly<Record<string, string>>;
}

export function findOperation(spec: ApiSpec, request: MockRequest): RouteMatch | null {
  const method = request.method.toLowerCase();
  const candidates = spec.operations.filter((operation) => operation.method === method);

  // Static segments win over parameterised ones, so `/users/me` beats
  // `/users/:id` regardless of declaration order.
  const ranked = [...candidates].sort(
    (a, b) =>
      (a.path.match(/:/g)?.length ?? 0) - (b.path.match(/:/g)?.length ?? 0) ||
      b.path.length - a.path.length
  );

  for (const operation of ranked) {
    const params = matchPath(operation.path, request.path);
    if (params) return { operation, params };
  }
  return null;
}

export interface ValidationProblem {
  readonly field: string;
  readonly message: string;
}

/** Validate a value against a schema. Structural checks only, no coercion. */
export function validateAgainstSchema(
  value: unknown,
  schema: Schema,
  spec?: ApiSpec,
  path = 'body',
  depth = 0
): ValidationProblem[] {
  if (depth > 8) return [];

  if (schema.$ref && spec) {
    const resolved = spec.schemas[schema.$ref.replace('#/components/schemas/', '')];
    return resolved ? validateAgainstSchema(value, resolved, spec, path, depth + 1) : [];
  }

  const problems: ValidationProblem[] = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];

  if (value === null || value === undefined) {
    if (schema.nullable || types.includes('null') || types.length === 0) return problems;
    return [{ field: path, message: 'is required' }];
  }

  const actual = Array.isArray(value) ? 'array' : typeof value;
  const matches =
    types.length === 0 ||
    types.some((type) =>
      type === 'integer'
        ? Number.isInteger(value)
        : type === 'number'
          ? typeof value === 'number'
          : type === actual
    );

  if (!matches) {
    return [{ field: path, message: `expected ${types.join(' or ')}, received ${actual}` }];
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      problems.push({ field: path, message: `must be at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      problems.push({ field: path, message: `must be at most ${schema.maxLength} characters` });
    }
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          problems.push({ field: path, message: `must match ${schema.pattern}` });
        }
      } catch {
        // An invalid pattern in the spec is a spec problem, not a request problem.
      }
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      problems.push({ field: path, message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      problems.push({ field: path, message: `must be <= ${schema.maximum}` });
    }
  }

  if (schema.enum && !schema.enum.some((option) => option === value)) {
    problems.push({ field: path, message: `must be one of: ${schema.enum.join(', ')}` });
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      problems.push(
        ...validateAgainstSchema(item, schema.items as Schema, spec, `${path}[${index}]`, depth + 1)
      );
    });
  }

  if (actual === 'object' && schema.properties) {
    const record = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (record[required] === undefined) {
        problems.push({ field: `${path}.${required}`, message: 'is required' });
      }
    }
    for (const [name, property] of Object.entries(schema.properties)) {
      if (record[name] === undefined) continue;
      problems.push(
        ...validateAgainstSchema(record[name], property, spec, `${path}.${name}`, depth + 1)
      );
    }
  }

  return problems;
}

function hasCredential(spec: ApiSpec, operation: Operation, request: MockRequest): boolean {
  const names = operation.security ?? [];
  if (names.length === 0) return true;

  const headers = Object.fromEntries(
    Object.entries(request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );

  return names.some((name) => {
    const scheme = spec.securitySchemes.find((candidate) => candidate.name === name);
    if (!scheme) return true;
    if (scheme.type === 'http') return Boolean(headers.authorization);
    if (scheme.type === 'apiKey') {
      const parameterName = (scheme.parameterName ?? 'x-api-key').toLowerCase();
      if (scheme.in === 'query') return Boolean(request.query?.[scheme.parameterName ?? 'api_key']);
      return Boolean(headers[parameterName]);
    }
    return Boolean(headers.authorization);
  });
}

export function handleMockRequest(
  spec: ApiSpec,
  request: MockRequest,
  options: MockOptions = {}
): MockResponse {
  const latencyMs = options.latencyMs ?? 0;
  const jsonHeaders = { 'content-type': 'application/json' } as const;

  const match = findOperation(spec, request);
  if (!match) {
    return {
      status: 404,
      headers: jsonHeaders,
      body: {
        error: 'not_found',
        message: `No operation matches ${request.method.toUpperCase()} ${request.path}`,
      },
      latencyMs,
    };
  }

  const { operation } = match;

  if ((options.enforceSecurity ?? true) && !hasCredential(spec, operation, request)) {
    return {
      status: 401,
      headers: jsonHeaders,
      body: { error: 'unauthorized', message: 'Missing or invalid credentials.' },
      matchedOperation: operation.id,
      latencyMs,
    };
  }

  if ((options.validateRequests ?? true) && operation.requestBody?.required) {
    const problems = validateAgainstSchema(request.body, operation.requestBody.schema, spec);
    if (problems.length > 0) {
      return {
        status: 400,
        headers: jsonHeaders,
        body: {
          error: 'invalid_request',
          message: 'The request body does not match the schema.',
          problems,
        },
        matchedOperation: operation.id,
        latencyMs,
      };
    }
  }

  const missingQuery = (operation.parameters ?? [])
    .filter((parameter) => parameter.in === 'query' && parameter.required)
    .filter((parameter) => request.query?.[parameter.name] === undefined);

  if (missingQuery.length > 0) {
    return {
      status: 400,
      headers: jsonHeaders,
      body: {
        error: 'invalid_request',
        message: 'Missing required query parameters.',
        problems: missingQuery.map((parameter) => ({
          field: parameter.name,
          message: 'is required',
        })),
      },
      matchedOperation: operation.id,
      latencyMs,
    };
  }

  const target = options.forceStatus
    ? operation.responses.find((response) => response.status === String(options.forceStatus))
    : (operation.responses.find((response) => response.status.startsWith('2')) ??
      operation.responses[0]);

  if (!target) {
    return {
      status: options.forceStatus ?? 501,
      headers: jsonHeaders,
      body: { error: 'not_implemented', message: 'No matching response is documented.' },
      matchedOperation: operation.id,
      latencyMs,
    };
  }

  const body =
    target.example ??
    (target.schema
      ? exampleForSchema(target.schema, spec, `${operation.id}:${target.status}`)
      : null);

  return {
    status: Number(target.status) || 200,
    headers: { ...jsonHeaders, 'x-forgeos-mock': operation.id },
    body,
    matchedOperation: operation.id,
    latencyMs,
  };
}

/**
 * Generate a deterministic collection of example records for an operation,
 * so list endpoints return something plausible rather than a single stub.
 */
export function generateCollection(schema: Schema, spec: ApiSpec, count: number, seed: string): unknown[] {
  const random = seededRandom(fnv1a32(seed));
  return Array.from({ length: count }, (_, index) => {
    const example = exampleForSchema(schema, spec, `${seed}:${index}`);
    if (example === null || typeof example !== 'object' || Array.isArray(example)) return example;

    const record = { ...(example as Record<string, unknown>) };
    // Vary identifiers and numbers so a list looks like a list.
    for (const [key, value] of Object.entries(record)) {
      if (/^(id|uuid)$/i.test(key)) record[key] = `${String(value).slice(0, 8)}-${index + 1}`;
      else if (typeof value === 'number') record[key] = Math.round(value * (0.5 + random()));
    }
    return record;
  });
}
