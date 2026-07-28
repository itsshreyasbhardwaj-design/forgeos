/**
 * The ForgeOS error taxonomy. Every failure that crosses a module boundary is
 * one of these codes, which lets the HTTP layer map errors to status codes
 * without every route inventing its own vocabulary.
 */
export const ERROR_CODES = [
  'invalid_input',
  'not_found',
  'conflict',
  'unauthorized',
  'forbidden',
  'rate_limited',
  'unsupported',
  'timeout',
  'upstream_failure',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  unsupported: 422,
  timeout: 504,
  upstream_failure: 502,
  internal: 500,
};

export interface ForgeErrorOptions {
  readonly code?: ErrorCode;
  /** Machine-readable context. Must never contain secrets — it is serialised to clients. */
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class ForgeError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  override readonly cause: unknown;

  constructor(message: string, options: ForgeErrorOptions = {}) {
    super(message);
    this.name = 'ForgeError';
    this.code = options.code ?? 'internal';
    this.details = options.details ?? {};
    this.cause = options.cause;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }

  toJSON(): { error: { code: ErrorCode; message: string; details: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }

  static from(value: unknown, fallbackCode: ErrorCode = 'internal'): ForgeError {
    if (value instanceof ForgeError) return value;
    if (value instanceof Error) {
      return new ForgeError(value.message, { code: fallbackCode, cause: value });
    }
    return new ForgeError(String(value), { code: fallbackCode });
  }
}

export const invalidInput = (message: string, details?: Record<string, unknown>): ForgeError =>
  new ForgeError(message, { code: 'invalid_input', details });

export const notFound = (resource: string, id?: string): ForgeError =>
  new ForgeError(id ? `${resource} '${id}' was not found` : `${resource} was not found`, {
    code: 'not_found',
    details: id ? { resource, id } : { resource },
  });

export const unauthorized = (message = 'Authentication required'): ForgeError =>
  new ForgeError(message, { code: 'unauthorized' });

export const forbidden = (message = 'You do not have access to this resource'): ForgeError =>
  new ForgeError(message, { code: 'forbidden' });

export const conflict = (message: string, details?: Record<string, unknown>): ForgeError =>
  new ForgeError(message, { code: 'conflict', details });

export const rateLimited = (retryAfterSeconds: number): ForgeError =>
  new ForgeError('Rate limit exceeded', {
    code: 'rate_limited',
    details: { retryAfterSeconds },
  });

export const upstreamFailure = (service: string, cause?: unknown): ForgeError =>
  new ForgeError(`Upstream service '${service}' failed`, {
    code: 'upstream_failure',
    details: { service },
    cause,
  });
