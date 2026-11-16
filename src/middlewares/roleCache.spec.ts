import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_CACHE_MAX_ENTRIES,
  ROLE_CACHE_TTL_MS,
  clearRoleCache,
  getCachedRole,
  invalidateUserRole,
  roleCacheStats,
  setCachedRole,
} from './roleCache';

beforeEach(() => clearRoleCache());

test('a cached role is returned until its TTL expires', () => {
  const now = 1_000_000;
  setCachedRole('user-a', 'teacher', now);

  assert.equal(getCachedRole('user-a', now + 1), 'teacher');
  assert.equal(getCachedRole('user-a', now + ROLE_CACHE_TTL_MS - 1), 'teacher');
  // At the TTL boundary the entry is expired and must be re-read.
  assert.equal(getCachedRole('user-a', now + ROLE_CACHE_TTL_MS), null);
});

test('a cache miss is never treated as a role', () => {
  assert.equal(getCachedRole('never-seen'), null);
  assert.equal(getCachedRole(''), null);
});

test('an explicit invalidation drops the entry immediately', () => {
  setCachedRole('user-b', 'admin');
  assert.equal(getCachedRole('user-b'), 'admin');

  invalidateUserRole('user-b');
  assert.equal(getCachedRole('user-b'), null);
});

test('cached roles are scoped per user and cannot leak between identities', () => {
  setCachedRole('user-c', 'super_admin');
  setCachedRole('user-d', 'student');

  assert.equal(getCachedRole('user-c'), 'super_admin');
  assert.equal(getCachedRole('user-d'), 'student');
  assert.equal(getCachedRole('user-e'), null);
});

test('the cache is bounded and stays usable when it fills up', () => {
  for (let index = 0; index < ROLE_CACHE_MAX_ENTRIES + 250; index += 1) {
    setCachedRole(`user-${index}`, 'student');
  }

  assert.ok(
    roleCacheStats().size <= ROLE_CACHE_MAX_ENTRIES,
    `cache grew to ${roleCacheStats().size} entries`
  );

  // The newest entry is still cached after eviction pressure.
  assert.equal(getCachedRole(`user-${ROLE_CACHE_MAX_ENTRIES + 249}`), 'student');
});

test('empty identifiers are ignored instead of creating junk entries', () => {
  setCachedRole('', 'admin');
  setCachedRole('user-f', '');

  assert.equal(roleCacheStats().size, 0);
});
