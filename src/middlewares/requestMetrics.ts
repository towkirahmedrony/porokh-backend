import { NextFunction, Request, Response } from 'express';
import { performance } from 'perf_hooks';

/**
 * Lightweight request timing.
 *
 * A structured line is emitted only for slow requests: logging every request on
 * a small Render instance costs more than it explains, while a slow-request line
 * still answers "which route degraded". The in-process snapshot is bounded and
 * is exposed for tests and for future metrics without adding a public endpoint.
 */

const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_LOG_MS) > 0
  ? Number(process.env.SLOW_REQUEST_LOG_MS)
  : 1_500;

const MAX_ROUTES = 200;

type RouteStat = { count: number; slow: number; totalMs: number; maxMs: number };

const stats = new Map<string, RouteStat>();

const record = (route: string, durationMs: number, slow: boolean): void => {
  const existing = stats.get(route);

  if (!existing) {
    if (stats.size >= MAX_ROUTES) {
      const oldest = stats.keys().next().value;
      if (oldest !== undefined) stats.delete(oldest);
    }
    stats.set(route, { count: 1, slow: slow ? 1 : 0, totalMs: durationMs, maxMs: durationMs });
    return;
  }

  existing.count += 1;
  existing.totalMs += durationMs;
  if (durationMs > existing.maxMs) existing.maxMs = durationMs;
  if (slow) existing.slow += 1;
};

/** Route template rather than the raw URL: no ids, query strings or user data. */
const routeLabel = (req: Request): string => {
  const matched = req.route && typeof req.route.path === 'string' ? req.route.path : null;
  if (!matched) return `${req.method} unmatched`;

  return `${req.method} ${req.baseUrl || ''}${matched}`;
};

export const requestTiming = (req: Request, res: Response, next: NextFunction): void => {
  const startedAt = performance.now();

  res.once('finish', () => {
    // Health probes are polled constantly and carry no useful signal.
    if (req.path.startsWith('/health')) return;

    const durationMs = Math.round(performance.now() - startedAt);
    const route = routeLabel(req);
    const slow = durationMs >= SLOW_REQUEST_MS;

    record(route, durationMs, slow);

    if (slow) {
      console.warn(
        `[api:slow] ${JSON.stringify({
          event: 'slow_request',
          route,
          status_code: res.statusCode,
          duration_ms: durationMs,
        })}`
      );
    }
  });

  next();
};

export const requestMetricsSnapshot = (): Array<{
  route: string;
  count: number;
  slow: number;
  avg_ms: number;
  max_ms: number;
}> =>
  Array.from(stats.entries()).map(([route, value]) => ({
    route,
    count: value.count,
    slow: value.slow,
    avg_ms: value.count === 0 ? 0 : Math.round(value.totalMs / value.count),
    max_ms: value.maxMs,
  }));

export const resetRequestMetrics = (): void => {
  stats.clear();
};
