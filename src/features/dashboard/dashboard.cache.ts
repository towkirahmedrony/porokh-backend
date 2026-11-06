/**
 * Small in-process TTL cache for dashboard aggregates.
 *
 * The dashboard is read by a handful of staff and is refreshed every 30–60
 * seconds by the client, so a short-lived memory cache removes most duplicate
 * work without adding Redis (which this project does not run). Entries live in
 * one Render instance only; a second instance simply computes its own copy.
 */

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

const MAX_ENTRIES = 60;
const store = new Map<string, CacheEntry>();

export const withDashboardCache = async <T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>
): Promise<T> => {
  const cached = store.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;

  const value = await load();

  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }

  store.set(key, { expiresAt: Date.now() + ttlMs, value });
  return value;
};

/** Exposed for tests and for an explicit refresh after admin writes. */
export const clearDashboardCache = (): void => {
  store.clear();
};
