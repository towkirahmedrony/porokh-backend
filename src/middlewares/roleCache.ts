/**
 * Bounded, short-lived cache for a user's active role.
 *
 * Every authenticated request used to read `user_roles` again. The value changes
 * only when an administrator assigns a role, so a role lookup can live for a few
 * seconds without changing any security decision that matters:
 *
 *  - the TTL is 30 seconds, so a role change or deactivation is honoured within
 *    a clearly bounded interval even if an invalidation is missed (for example
 *    on another Render instance);
 *  - explicit invalidation happens on the assignment path in this process, so
 *    an admin sees the change immediately on the instance serving the request;
 *  - only a successful lookup is cached. A failed or empty read is never stored,
 *    so an error can never turn into a cached "role exists" answer;
 *  - the map is bounded: expired entries are dropped first, then the oldest
 *    entries, so a flood of distinct user ids cannot grow memory without limit.
 *
 * Session state (admin session rows, session revocation, account status) is
 * deliberately NOT cached here: revoking a session must take effect at once.
 */

const TTL_MS = 30_000;
const MAX_ENTRIES = 5_000;

type Entry = {
  role: string;
  expiresAt: number;
};

const store = new Map<string, Entry>();

const stats = { hits: 0, misses: 0 };

/** Drops expired entries, then the oldest ones while the map is over budget. */
const evict = (now: number): void => {
  for (const [key, entry] of store.entries()) {
    if (entry.expiresAt <= now) store.delete(key);
  }

  while (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
};

export const getCachedRole = (userId: string, now: number = Date.now()): string | null => {
  const entry = store.get(userId);

  if (!entry) {
    stats.misses += 1;
    return null;
  }

  if (entry.expiresAt <= now) {
    store.delete(userId);
    stats.misses += 1;
    return null;
  }

  stats.hits += 1;
  return entry.role;
};

export const setCachedRole = (userId: string, role: string, now: number = Date.now()): void => {
  if (!userId || !role) return;

  // Re-insert so the entry becomes the newest one for eviction ordering.
  store.delete(userId);
  evict(now);
  store.set(userId, { role, expiresAt: now + TTL_MS });
};

/** Call after a role change so the next request re-reads the database. */
export const invalidateUserRole = (userId: string): void => {
  if (!userId) return;
  store.delete(userId);
};

export const clearRoleCache = (): void => {
  store.clear();
};

export const roleCacheStats = (): { size: number; hits: number; misses: number } => ({
  size: store.size,
  hits: stats.hits,
  misses: stats.misses,
});

export const ROLE_CACHE_TTL_MS = TTL_MS;
export const ROLE_CACHE_MAX_ENTRIES = MAX_ENTRIES;
