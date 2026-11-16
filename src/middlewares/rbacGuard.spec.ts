import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * Authorization regression tests for the shared-auth-context change.
 *
 * The guard must not re-read `profiles` when `requireAuth` already verified the
 * account, must cache the role table read, and must still deny every case it
 * denied before: wrong role, suspended account, missing admin session, and a
 * failed lookup (which must never grant access).
 */

type Row = Record<string, any>;

const state: {
  roles: Row[];
  profiles: Row[];
  roleReads: number;
  profileReads: number;
  roleError: Row | null;
} = {
  roles: [],
  profiles: [],
  roleReads: 0,
  profileReads: 0,
  roleError: null,
};

const createBuilder = (table: string) => {
  const filters: Row = {};

  const resolve = () => {
    if (table === 'user_roles') {
      state.roleReads += 1;
      if (state.roleError) return { data: null, error: state.roleError };
      const row = state.roles.find((item) =>
        Object.entries(filters).every(([column, value]) => String(item[column]) === String(value))
      );
      return { data: row ?? null, error: null };
    }

    if (table === 'profiles') {
      state.profileReads += 1;
      const row = state.profiles.find((item) =>
        Object.entries(filters).every(([column, value]) => String(item[column]) === String(value))
      );
      return { data: row ?? null, error: null };
    }

    if (table === 'admin_auth_sessions') {
      return { data: null, error: null };
    }

    return { data: null, error: null };
  };

  const builder: any = {
    select: () => builder,
    eq: (column: string, value: any) => {
      filters[column] = value;
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => resolve(),
    single: async () => resolve(),
    insert: () => builder,
    update: () => builder,
  };

  return builder;
};

const fakeSupabase = {
  from: (table: string) => createBuilder(table),
  rpc: async () => ({ data: null, error: null }),
};

const nodeRequire = createRequire(__filename);

for (const [modulePath, exports] of [
  ['../config/supabase', { supabase: fakeSupabase }],
  ['../config/userSupabase', { createUserSupabaseClient: () => fakeSupabase }],
] as const) {
  const resolved = nodeRequire.resolve(modulePath);
  nodeRequire.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  } as any;
}

const { rbacGuard } = nodeRequire('./rbacGuard') as {
  rbacGuard: (roles: string[]) => (req: any, res: any, next: () => void) => Promise<any>;
};
const { clearRoleCache } = nodeRequire('./roleCache') as { clearRoleCache: () => void };

const makeRes = () => {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
  };
  return res;
};

const run = async (
  guard: ReturnType<typeof rbacGuard>,
  req: Row
): Promise<{ nextCalled: boolean; res: any }> => {
  const res = makeRes();
  let nextCalled = false;

  await guard(req, res, () => { nextCalled = true; });

  return { nextCalled, res };
};

beforeEach(() => {
  clearRoleCache();
  state.roleReads = 0;
  state.profileReads = 0;
  state.roleError = null;
  state.roles = [{ user_id: 'user-1', role: 'teacher', is_active: true }];
  state.profiles = [{ id: 'user-1', account_status: 'active' }];
});

test('a verified active account is not re-read from profiles', async () => {
  const { nextCalled } = await run(rbacGuard(['teacher']), {
    user: { id: 'user-1' },
    authAccount: { accountStatus: 'active', sessionsRevokedAt: null },
  });

  assert.equal(nextCalled, true);
  assert.equal(state.profileReads, 0, 'profiles must be read at most once per request');
  assert.equal(state.roleReads, 1);
});

test('without a shared context the account status is still read', async () => {
  const { nextCalled } = await run(rbacGuard(['teacher']), { user: { id: 'user-1' } });

  assert.equal(nextCalled, true);
  assert.equal(state.profileReads, 1, 'the check must never be skipped');
});

test('a suspended account is denied even when the role is allowed', async () => {
  const { nextCalled, res } = await run(rbacGuard(['teacher']), {
    user: { id: 'user-1' },
    authAccount: { accountStatus: 'suspended', sessionsRevokedAt: null },
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('a missing profile is denied', async () => {
  state.profiles = [];
  const { nextCalled, res } = await run(rbacGuard(['teacher']), { user: { id: 'user-1' } });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('the role is cached for the next request', async () => {
  await run(rbacGuard(['teacher']), { user: { id: 'user-1' } });
  await run(rbacGuard(['teacher']), { user: { id: 'user-1' } });

  assert.equal(state.roleReads, 1, 'the second request should reuse the cached role');
});

test('a cached role never widens access for a different user', async () => {
  state.roles = [
    { user_id: 'user-1', role: 'teacher', is_active: true },
    { user_id: 'user-2', role: 'student', is_active: true },
  ];

  const first = await run(rbacGuard(['teacher']), { user: { id: 'user-1' } });
  const second = await run(rbacGuard(['teacher']), { user: { id: 'user-2' } });

  assert.equal(first.nextCalled, true);
  assert.equal(second.nextCalled, false);
  assert.equal(second.res.statusCode, 403);
});

test('a disallowed role is forbidden', async () => {
  state.roles = [{ user_id: 'user-1', role: 'student', is_active: true }];

  const { nextCalled, res } = await run(rbacGuard(['teacher']), { user: { id: 'user-1' } });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('an unknown role value is never cached or allowed', async () => {
  state.roles = [{ user_id: 'user-1', role: 'finance', is_active: true }];

  const first = await run(rbacGuard(['teacher']), { user: { id: 'user-1' } });
  await run(rbacGuard(['teacher']), { user: { id: 'user-1' } });

  assert.equal(first.nextCalled, false);
  assert.equal(first.res.statusCode, 403);
  assert.equal(state.roleReads, 2, 'a non-canonical role must not be cached');
});

test('a failed role read denies access and is not cached', async () => {
  state.roleError = { code: '500', message: 'boom' };

  const first = await run(rbacGuard(['teacher']), { user: { id: 'user-1' } });
  await run(rbacGuard(['teacher']), { user: { id: 'user-1' } });

  assert.equal(first.nextCalled, false);
  assert.equal(first.res.statusCode, 500);
  assert.equal(state.roleReads, 2, 'an error must never become a cached answer');
});

test('an admin without a verified session is still rejected', async () => {
  state.roles = [{ user_id: 'user-1', role: 'admin', is_active: true }];

  const { nextCalled, res } = await run(rbacGuard(['admin']), {
    user: { id: 'user-1' },
    authAccount: { accountStatus: 'active', sessionsRevokedAt: null },
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('a request without a user is unauthorized', async () => {
  const { nextCalled, res } = await run(rbacGuard(['teacher']), {});

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});
