import { Request, Response, NextFunction } from 'express';

type RateLimitOptions = {
  windowMs: number;
  max: number;
  keyPrefix: string;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

/**
 * Upper bound on tracked keys. Expired buckets are pruned first; if the map is
 * still full the oldest keys are dropped. Dropping a live bucket can only make
 * the limiter more permissive for that key (it restarts a window), never block
 * a legitimate user, and it keeps memory flat under an IP flood.
 */
const MAX_BUCKETS = 10_000;

let rejected = 0;

const prune = (now: number): void => {
  for (const [bucketKey, value] of buckets.entries()) {
    if (value.resetAt <= now) buckets.delete(bucketKey);
  }

  while (buckets.size >= MAX_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
};

const getClientKey = (req: Request, keyPrefix: string): string => {
  const userId = (req as Request & { user?: { id?: string } }).user?.id;

  if (userId) return `${keyPrefix}:user:${userId}`;

  return `${keyPrefix}:ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
};

/**
 * Lightweight fixed-window limiter for sensitive endpoints.
 *
 * This is intentionally process-local: it is a defence-in-depth control against
 * high-volume question-bank harvesting, not a distributed quota. Multi-instance
 * deployments should replace the Map with Redis when available.
 */
export const rateLimit = ({ windowMs, max, keyPrefix }: RateLimitOptions) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = getClientKey(req, keyPrefix);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      if (buckets.size >= MAX_BUCKETS) prune(now);
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= max) {
      const retryAfter = Math.max(0, Math.ceil((bucket.resetAt - now) / 1000));

      rejected += 1;
      // Key prefix only: never the user id or IP address.
      console.warn(`[rate-limit] rejected request on ${keyPrefix}`);

      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        message: 'Too many requests. Please slow down.',
        data: null,
      });
    }

    bucket.count += 1;

    return next();
  };
};

export const rateLimitStats = (): { buckets: number; rejected: number } => ({
  buckets: buckets.size,
  rejected,
});

/** Test hook: keeps cases independent without exporting the bucket map. */
export const resetRateLimitState = (): void => {
  buckets.clear();
  rejected = 0;
};

export default rateLimit;
