import { seededRandom, fnv1a32 } from '../kernel/hash.js';
import { slugify } from '../kernel/id.js';
import type { ApiRoute } from '../graph/api-surface.js';

/**
 * OpenAPI 3.1 modelling.
 *
 * A deliberately small subset of the specification is modelled — paths,
 * operations, parameters, request bodies, responses, schemas, security — chosen
 * because it is what the visual builder, the mock server, the request tester
 * and the SDK generators all need to share. Anything beyond it round-trips
 * untouched through the `extensions` fields rather than being silently dropped.
 */
export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

export type SchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

export interface Schema {
  readonly type?: SchemaType | readonly SchemaType[];
  readonly format?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly items?: Schema;
  readonly enum?: readonly (string | number | boolean)[];
  readonly example?: unknown;
  readonly default?: unknown;
  readonly nullable?: boolean;
  readonly $ref?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
}

export interface Parameter {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header' | 'cookie';
  readonly required?: boolean;
  readonly description?: string;
  readonly schema: Schema;
}

export interface RequestBody {
  readonly description?: string;
  readonly required?: boolean;
  readonly contentType: string;
  readonly schema: Schema;
}

export interface Response {
  readonly status: string;
  readonly description: string;
  readonly contentType?: string;
  readonly schema?: Schema;
  readonly example?: unknown;
}

export interface Operation {
  readonly id: string;
  readonly method: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';
  readonly path: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly parameters?: readonly Parameter[];
  readonly requestBody?: RequestBody;
  readonly responses: readonly Response[];
  readonly security?: readonly string[];
  readonly deprecated?: boolean;
}

export interface SecurityScheme {
  readonly name: string;
  readonly type: 'http' | 'apiKey' | 'oauth2' | 'openIdConnect';
  readonly scheme?: 'bearer' | 'basic';
  readonly in?: 'header' | 'query' | 'cookie';
  readonly parameterName?: string;
  readonly description?: string;
}

export interface ApiSpec {
  readonly openapi: '3.1.0';
  readonly info: OpenApiInfo;
  readonly servers: readonly { url: string; description?: string }[];
  readonly operations: readonly Operation[];
  readonly schemas: Readonly<Record<string, Schema>>;
  readonly securitySchemes: readonly SecurityScheme[];
}

export function createSpec(info: OpenApiInfo): ApiSpec {
  return {
    openapi: '3.1.0',
    info,
    servers: [{ url: 'https://api.example.com', description: 'Production' }],
    operations: [],
    schemas: {},
    securitySchemes: [],
  };
}

/** Convert the internal model into a standards-compliant OpenAPI document. */
export function toOpenApiDocument(spec: ApiSpec): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const operation of spec.operations) {
    // OpenAPI uses `{id}`; ForgeOS stores the framework-neutral `:id`.
    const path = operation.path.replace(/:(\w+)/g, '{$1}');
    const entry = paths[path] ?? {};

    entry[operation.method] = {
      operationId: operation.id,
      ...(operation.summary ? { summary: operation.summary } : {}),
      ...(operation.description ? { description: operation.description } : {}),
      ...(operation.tags?.length ? { tags: operation.tags } : {}),
      ...(operation.deprecated ? { deprecated: true } : {}),
      ...(operation.parameters?.length
        ? {
            parameters: operation.parameters.map((parameter) => ({
              name: parameter.name,
              in: parameter.in,
              required: parameter.in === 'path' ? true : (parameter.required ?? false),
              ...(parameter.description ? { description: parameter.description } : {}),
              schema: parameter.schema,
            })),
          }
        : {}),
      ...(operation.requestBody
        ? {
            requestBody: {
              ...(operation.requestBody.description
                ? { description: operation.requestBody.description }
                : {}),
              required: operation.requestBody.required ?? false,
              content: {
                [operation.requestBody.contentType]: { schema: operation.requestBody.schema },
              },
            },
          }
        : {}),
      responses: Object.fromEntries(
        operation.responses.map((response) => [
          response.status,
          {
            description: response.description,
            ...(response.schema
              ? {
                  content: {
                    [response.contentType ?? 'application/json']: {
                      schema: response.schema,
                      ...(response.example !== undefined ? { example: response.example } : {}),
                    },
                  },
                }
              : {}),
          },
        ])
      ),
      ...(operation.security?.length
        ? { security: operation.security.map((name) => ({ [name]: [] })) }
        : {}),
    };

    paths[path] = entry;
  }

  return {
    openapi: spec.openapi,
    info: spec.info,
    servers: spec.servers,
    paths,
    components: {
      ...(Object.keys(spec.schemas).length > 0 ? { schemas: spec.schemas } : {}),
      ...(spec.securitySchemes.length > 0
        ? {
            securitySchemes: Object.fromEntries(
              spec.securitySchemes.map((scheme) => [
                scheme.name,
                {
                  type: scheme.type,
                  ...(scheme.scheme ? { scheme: scheme.scheme } : {}),
                  ...(scheme.in ? { in: scheme.in } : {}),
                  ...(scheme.parameterName ? { name: scheme.parameterName } : {}),
                  ...(scheme.description ? { description: scheme.description } : {}),
                },
              ])
            ),
          }
        : {}),
    },
  };
}

interface RawOperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: {
    name: string;
    in: Parameter['in'];
    required?: boolean;
    description?: string;
    schema?: Schema;
  }[];
  requestBody?: {
    description?: string;
    required?: boolean;
    content?: Record<string, { schema?: Schema }>;
  };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: Schema; example?: unknown }> }>;
  security?: Record<string, unknown>[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

/** Parse an OpenAPI document into the internal model. */
export function fromOpenApiDocument(document: Record<string, unknown>): ApiSpec {
  const info = (document.info ?? {}) as Partial<OpenApiInfo>;
  const paths = (document.paths ?? {}) as Record<string, Record<string, unknown>>;
  const components = (document.components ?? {}) as {
    schemas?: Record<string, Schema>;
    securitySchemes?: Record<string, Record<string, string>>;
  };

  const operations: Operation[] = [];

  for (const [rawPath, pathItem] of Object.entries(paths)) {
    for (const method of METHODS) {
      const raw = pathItem[method] as RawOperationObject | undefined;
      if (!raw) continue;

      const path = rawPath.replace(/\{(\w+)\}/g, ':$1');
      const bodyContentType = Object.keys(raw.requestBody?.content ?? {})[0];

      operations.push({
        id: raw.operationId ?? `${method}${slugify(path).replace(/-/g, '_')}`,
        method,
        path,
        ...(raw.summary ? { summary: raw.summary } : {}),
        ...(raw.description ? { description: raw.description } : {}),
        ...(raw.tags ? { tags: raw.tags } : {}),
        ...(raw.deprecated ? { deprecated: true } : {}),
        ...(raw.parameters
          ? {
              parameters: raw.parameters.map((parameter) => ({
                name: parameter.name,
                in: parameter.in,
                required: parameter.required ?? parameter.in === 'path',
                ...(parameter.description ? { description: parameter.description } : {}),
                schema: parameter.schema ?? { type: 'string' },
              })),
            }
          : {}),
        ...(bodyContentType
          ? {
              requestBody: {
                ...(raw.requestBody?.description ? { description: raw.requestBody.description } : {}),
                required: raw.requestBody?.required ?? false,
                contentType: bodyContentType,
                schema: raw.requestBody?.content?.[bodyContentType]?.schema ?? { type: 'object' },
              },
            }
          : {}),
        responses: Object.entries(raw.responses ?? {}).map(([status, response]) => {
          const contentType = Object.keys(response.content ?? {})[0];
          return {
            status,
            description: response.description ?? '',
            ...(contentType ? { contentType } : {}),
            ...(contentType && response.content?.[contentType]?.schema
              ? { schema: response.content[contentType].schema as Schema }
              : {}),
            ...(contentType && response.content?.[contentType]?.example !== undefined
              ? { example: response.content[contentType].example }
              : {}),
          };
        }),
        ...(raw.security
          ? { security: raw.security.flatMap((entry) => Object.keys(entry)) }
          : {}),
      });
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: info.title ?? 'Untitled API',
      version: info.version ?? '1.0.0',
      ...(info.description ? { description: info.description } : {}),
    },
    servers: (document.servers as { url: string; description?: string }[] | undefined) ?? [
      { url: '/' },
    ],
    operations,
    schemas: components.schemas ?? {},
    securitySchemes: Object.entries(components.securitySchemes ?? {}).map(([name, scheme]) => ({
      name,
      type: (scheme.type as SecurityScheme['type']) ?? 'http',
      ...(scheme.scheme ? { scheme: scheme.scheme as 'bearer' | 'basic' } : {}),
      ...(scheme.in ? { in: scheme.in as SecurityScheme['in'] } : {}),
      ...(scheme.name ? { parameterName: scheme.name } : {}),
    })),
  };
}

/**
 * Seed a specification from routes discovered in a repository.
 * This is the bridge between Module 1 (repository intelligence) and Module 8:
 * an API that already exists gets a spec without anyone typing it out.
 */
export function specFromRoutes(routes: readonly ApiRoute[], info: OpenApiInfo): ApiSpec {
  const spec = createSpec(info);
  const operations: Operation[] = [];

  for (const route of routes) {
    const method = route.method.toLowerCase();
    if (!(METHODS as readonly string[]).includes(method)) continue;

    const parameters: Parameter[] = [...route.path.matchAll(/:(\w+)/g)].map((match) => ({
      name: match[1] ?? '',
      in: 'path' as const,
      required: true,
      description: `The ${match[1]} identifier.`,
      schema: { type: 'string' as const },
    }));

    const tag = route.path.split('/').filter(Boolean)[0] ?? 'default';

    operations.push({
      id: `${method}_${slugify(route.path, 'root').replace(/-/g, '_')}`,
      method: method as Operation['method'],
      path: route.path,
      summary: `${route.method} ${route.path}`,
      description: `Discovered in \`${route.file}\` (${route.framework}).`,
      tags: [tag],
      ...(parameters.length > 0 ? { parameters } : {}),
      responses: [
        { status: '200', description: 'Successful response', contentType: 'application/json', schema: { type: 'object' } },
        { status: '400', description: 'Invalid request' },
        { status: '500', description: 'Server error' },
      ],
    });
  }

  return { ...spec, operations };
}

export interface SpecIssue {
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly message: string;
}

/**
 * Lint a specification.
 *
 * These checks catch the mistakes that make a published API painful to consume:
 * undocumented error paths, missing operation ids (which break every code
 * generator), path parameters with no declaration, and unreferenced schemas.
 */
export function validateSpec(spec: ApiSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const seenIds = new Set<string>();

  if (!spec.info.title.trim()) {
    issues.push({ severity: 'error', path: 'info.title', message: 'The API needs a title.' });
  }
  if (!/^\d+\.\d+\.\d+/.test(spec.info.version)) {
    issues.push({
      severity: 'warning',
      path: 'info.version',
      message: 'Use a semantic version so consumers can reason about compatibility.',
    });
  }
  if (spec.operations.length === 0) {
    issues.push({ severity: 'error', path: 'paths', message: 'The specification has no operations.' });
  }

  for (const operation of spec.operations) {
    const where = `${operation.method.toUpperCase()} ${operation.path}`;

    if (!operation.id) {
      issues.push({ severity: 'error', path: where, message: 'Missing operationId — SDK generation requires it.' });
    } else if (seenIds.has(operation.id)) {
      issues.push({ severity: 'error', path: where, message: `Duplicate operationId '${operation.id}'.` });
    } else {
      seenIds.add(operation.id);
    }

    const declared = new Set(
      (operation.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name)
    );
    for (const match of operation.path.matchAll(/:(\w+)/g)) {
      const name = match[1] ?? '';
      if (!declared.has(name)) {
        issues.push({
          severity: 'error',
          path: where,
          message: `Path parameter '${name}' is used but not declared.`,
        });
      }
    }

    if (operation.responses.length === 0) {
      issues.push({ severity: 'error', path: where, message: 'No responses are documented.' });
    }
    if (!operation.responses.some((response) => response.status.startsWith('2'))) {
      issues.push({ severity: 'warning', path: where, message: 'No success response is documented.' });
    }
    if (!operation.responses.some((response) => /^[45]/.test(response.status))) {
      issues.push({
        severity: 'warning',
        path: where,
        message: 'No error response is documented — consumers cannot handle failure.',
      });
    }
    if (!operation.summary) {
      issues.push({ severity: 'warning', path: where, message: 'Missing summary.' });
    }
    if (['post', 'put', 'patch'].includes(operation.method) && !operation.requestBody) {
      issues.push({
        severity: 'warning',
        path: where,
        message: `${operation.method.toUpperCase()} usually carries a request body.`,
      });
    }
  }

  const referenced = new Set<string>();
  const walk = (schema: Schema | undefined): void => {
    if (!schema) return;
    if (schema.$ref) referenced.add(schema.$ref.replace('#/components/schemas/', ''));
    if (schema.items) walk(schema.items);
    for (const property of Object.values(schema.properties ?? {})) walk(property);
  };
  for (const operation of spec.operations) {
    walk(operation.requestBody?.schema);
    for (const response of operation.responses) walk(response.schema);
  }
  for (const name of Object.keys(spec.schemas)) {
    if (!referenced.has(name)) {
      issues.push({
        severity: 'warning',
        path: `components.schemas.${name}`,
        message: 'Schema is defined but never referenced.',
      });
    }
  }

  return issues;
}

/**
 * Generate a deterministic example value for a schema.
 * Determinism matters: a mock server whose responses change on every call is
 * useless for writing tests against.
 */
export function exampleForSchema(schema: Schema, spec?: ApiSpec, seedKey = 'example', depth = 0): unknown {
  if (depth > 6) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;

  if (schema.$ref && spec) {
    const name = schema.$ref.replace('#/components/schemas/', '');
    const resolved = spec.schemas[name];
    if (resolved) return exampleForSchema(resolved, spec, `${seedKey}.${name}`, depth + 1);
    return null;
  }

  if (schema.enum && schema.enum.length > 0) return schema.enum[0];

  const random = seededRandom(fnv1a32(seedKey));
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case 'string':
      switch (schema.format) {
        case 'date-time':
          return '2024-01-15T09:30:00Z';
        case 'date':
          return '2024-01-15';
        case 'email':
          return 'user@example.com';
        case 'uri':
        case 'url':
          return 'https://example.com/resource';
        case 'uuid':
          return '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
        default:
          return schema.description ? schema.description.slice(0, 40) : 'string';
      }
    case 'integer':
      return Math.floor((schema.minimum ?? 1) + random() * 100);
    case 'number':
      return Math.round(((schema.minimum ?? 0) + random() * 100) * 100) / 100;
    case 'boolean':
      return true;
    case 'array':
      return schema.items
        ? [exampleForSchema(schema.items, spec, `${seedKey}[0]`, depth + 1)]
        : [];
    case 'null':
      return null;
    case 'object':
    default: {
      if (!schema.properties) return {};
      const out: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(schema.properties)) {
        out[name] = exampleForSchema(property, spec, `${seedKey}.${name}`, depth + 1);
      }
      return out;
    }
  }
}
