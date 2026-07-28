import { NextResponse } from 'next/server';
import { FORGEOS_CORE_VERSION } from '@forgeos/core';
import { getContext, getRuntimeStatus } from '@/lib/server/context';

export const dynamic = 'force-dynamic';

/**
 * Liveness and configuration report.
 *
 * Deliberately unauthenticated and deliberately non-sensitive: it names which
 * subsystems are active, never their credentials or connection strings.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const { store, startedAt } = await getContext();
    const status = await getRuntimeStatus();
    const healthy = await store.healthy();

    return NextResponse.json(
      {
        status: healthy ? 'ok' : 'degraded',
        version: FORGEOS_CORE_VERSION,
        uptimeMs: Date.now() - startedAt,
        ...status,
      },
      { status: healthy ? 200 : 503 }
    );
  } catch (error) {
    return NextResponse.json(
      { status: 'error', message: (error as Error).message },
      { status: 503 }
    );
  }
}
