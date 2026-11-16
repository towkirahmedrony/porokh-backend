import type { Request, Response } from 'express';
import { supabase } from '../../config/supabase';

/**
 * Health and readiness probes.
 *
 * `/health` stays exactly as it was so existing uptime checks keep working.
 * The two new endpoints answer different questions:
 *
 *  - `/health/live` reports that the process is running. It never touches a
 *    dependency, so a database outage cannot make Render restart a healthy
 *    process.
 *  - `/health/ready` reports whether the API can serve traffic right now. The
 *    dependency check is bounded by a short timeout and the probe fails closed
 *    (503) when it cannot confirm readiness.
 */

const READY_TIMEOUT_MS = 2_000;

const withTimeout = async <T>(operation: PromiseLike<T>, timeoutMs: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('readiness check timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** One cheap read that proves the connection, the key and the schema work. */
const checkDatabase = async (): Promise<{ ok: boolean; detail?: string }> => {
  try {
    const { error } = await withTimeout(
      supabase.from('app_configs').select('key').limit(1),
      READY_TIMEOUT_MS
    );

    if (error) return { ok: false, detail: 'database query failed' };
    return { ok: true };
  } catch {
    return { ok: false, detail: 'database unavailable' };
  }
};

export const liveProbe = (_req: Request, res: Response): void => {
  res.status(200).json({ success: true, status: 'live' });
};

export const readyProbe = async (_req: Request, res: Response): Promise<void> => {
  const database = await checkDatabase();
  const ready = database.ok;

  res.status(ready ? 200 : 503).json({
    success: ready,
    status: ready ? 'ready' : 'not_ready',
    checks: {
      database: database.ok ? 'ok' : database.detail,
    },
  });
};
