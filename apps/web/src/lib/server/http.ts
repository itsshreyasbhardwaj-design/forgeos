import 'server-only';
import { NextResponse } from 'next/server';
import { ForgeError } from '@forgeos/core';
import { getActiveWorkspace, getContext, getCurrentUser } from './context';
import type { Workspace, User } from '@forgeos/db';

/**
 * HTTP plumbing shared by every route handler.
 *
 * The goal is that a route handler contains only its own logic: authentication,
 * workspace resolution, rate limiting, error shaping and audit are all handled
 * here, once, so they cannot be forgotten in one endpoint out of thirty.
 */
export interface RequestContext {
  readonly user: User;
  readonly workspace: Workspace;
  readonly request: Request;
}

export function json<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function errorResponse(error: unknown): NextResponse {
  const forgeError = ForgeError.from(error);
  // 5xx errors may carry internal detail; never echo it to the client.
  const safe =
    forgeError.status >= 500
      ? { error: { code: forgeError.code, message: 'An internal error occurred.', details: {} } }
      : forgeError.toJSON();
  return NextResponse.json(safe, { status: forgeError.status });
}

/**
 * A fixed-window rate limiter held in process memory.
 *
 * Honest about its limits: with multiple instances each has its own window, so
 * the effective limit is `limit x instances`. `REDIS_URL` upgrades this to a
 * shared limiter; until then this still stops a single client hammering an
 * expensive analysis endpoint, which is the case that matters locally.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    // Opportunistic sweep; the map would otherwise grow without bound.
    if (buckets.size > 10_000) {
      for (const [existingKey, existing] of buckets) {
        if (existing.resetAt <= now) buckets.delete(existingKey);
      }
    }
    return { allowed: true, remaining: limit - 1, resetAt };
  }

  bucket.count++;
  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt,
  };
}

export interface HandlerOptions {
  /** Requests permitted per window, per user. */
  readonly limit?: number;
  readonly windowMs?: number;
  /** Record the call in the audit log. */
  readonly audit?: string;
}

type Handler<T> = (context: RequestContext) => Promise<T>;

/**
 * Wrap a route handler with auth, workspace scoping, rate limiting and error
 * shaping. Every API route in ForgeOS goes through this.
 */
export function route<T>(handler: Handler<T>, options: HandlerOptions = {}) {
  return async (request: Request): Promise<NextResponse> => {
    try {
      const user = await getCurrentUser();
      const workspace = await getActiveWorkspace(request.headers.get('x-forgeos-workspace'));

      const limit = options.limit ?? 120;
      const windowMs = options.windowMs ?? 60_000;
      const url = new URL(request.url);
      const result = rateLimit(`${user.id}:${url.pathname}`, limit, windowMs);

      if (!result.allowed) {
        return NextResponse.json(
          {
            error: {
              code: 'rate_limited',
              message: 'Too many requests. Slow down and try again shortly.',
              details: { retryAfterSeconds: Math.ceil((result.resetAt - Date.now()) / 1000) },
            },
          },
          {
            status: 429,
            headers: {
              'retry-after': String(Math.ceil((result.resetAt - Date.now()) / 1000)),
              'x-ratelimit-remaining': '0',
            },
          }
        );
      }

      const data = await handler({ user, workspace, request });

      if (options.audit) {
        const { store } = await getContext();
        await store
          .recordAudit({
            id: `aud_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
            workspaceId: workspace.id,
            actorId: user.id,
            action: options.audit,
            createdAt: Date.now(),
            ...(request.headers.get('user-agent')
              ? { userAgent: request.headers.get('user-agent') as string }
              : {}),
          })
          .catch(() => undefined);
      }

      return NextResponse.json(data, {
        headers: { 'x-ratelimit-remaining': String(result.remaining) },
      });
    } catch (error) {
      const { logger } = await getContext().catch(() => ({ logger: null }) as never);
      logger?.error('request failed', {
        path: new URL(request.url).pathname,
        message: ForgeError.from(error).message,
      });
      return errorResponse(error);
    }
  };
}

/** Parse and validate a JSON body, rejecting anything that is not an object. */
export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  const text = await request.text();
  if (text.trim() === '') return {} as T;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ForgeError('The request body must be a JSON object', { code: 'invalid_input' });
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError('The request body is not valid JSON', { code: 'invalid_input' });
  }
}

/** Require a non-empty string field. */
export function requireString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 500
): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ForgeError(`'${field}' is required`, {
      code: 'invalid_input',
      details: { field },
    });
  }
  if (value.length > maxLength) {
    throw new ForgeError(`'${field}' must be at most ${maxLength} characters`, {
      code: 'invalid_input',
      details: { field, maxLength },
    });
  }
  return value.trim();
}

export function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
