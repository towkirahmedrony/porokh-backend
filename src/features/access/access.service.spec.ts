import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dhakaDayKey } from '../../lib/utils/time';

/**
 * Access administration rules (grants, quota configuration, usage reset and
 * overview statistics). The Supabase transport is faked; the real service runs.
 */

type Row = Record<string, any>;

const state: {
  featureQuotas: Row[];
  grants: Row[];
  usageEvents: Row[];
  profiles: Row[];
  updates: { table: string; patch: Row; filters: Row[] }[];
  orFilters: { table: string; expression: string }[];
  rpcCalls: { name: string; args: Row }[];
} = {
  featureQuotas: [],
  grants: [],
  usageEvents: [],
  profiles: [],
  updates: [],
  orFilters: [],
  rpcCalls: [],
  limitRpcError: false,
};

let seq = 0;

const compare = (row: Row, filters: Row[]) =>
  filters.every(({ column, op, value }) => {
    const actual = row[column];

    switch (op) {
      case 'eq':
        return String(actual) === String(value);
      case 'neq':
        return String(actual) !== String(value);
      case 'in':
        return (value as any[]).map(String).includes(String(actual));
      case 'is':
        return value === null ? actual === null || actual === undefined : String(actual) === String(value);
      case 'gte':
        return Date.parse(String(actual)) >= Date.parse(String(value));
      case 'lt':
        return Date.parse(String(actual)) < Date.parse(String(value));
      case 'gt':
        return Date.parse(String(actual)) > Date.parse(String(value));
      case 'not':
        return actual !== null && actual !== undefined;
      default:
        return true;
    }
  });

const rowsFor = (table: string): Row[] => {
  if (table === 'feature_quotas') return state.featureQuotas;
  if (table === 'access_grants') return state.grants;
  if (table === 'usage_events') return state.usageEvents;
  if (table === 'profiles') return state.profiles;
  return [];
};

const createBuilder = (table: string) => {
  const filters: { column: string; op: string; value: any }[] = [];
  let inserted: Row[] | null = null;
  let patch: Row | null = null;
  let countHead = false;
  let rangeFrom = 0;
  let rangeTo = Number.POSITIVE_INFINITY;

  const matching = () => rowsFor(table).filter((row) => compare(row, filters));

  const resolve = (mode: 'many' | 'single') => {
    if (inserted) {
      const stored = inserted.map((row) => {
        seq += 1;
        const created = { id: `${table}-${seq}`, created_at: new Date().toISOString(), ...row };
        rowsFor(table).push(created);
        return created;
      });
      return { data: mode === 'single' ? stored[0] : stored, error: null };
    }

    if (patch) {
      const rows = matching();
      state.updates.push({ table, patch, filters: filters.map((filter) => ({ ...filter })) });
      rows.forEach((row) => Object.assign(row, patch));
      return { data: mode === 'single' ? rows[0] ?? null : rows, error: null, count: rows.length };
    }

    const rows = matching();

    if (countHead) {
      return { data: null, error: null, count: rows.length };
    }

    const page = rows.slice(rangeFrom, rangeTo + 1);
    return { data: mode === 'single' ? page[0] ?? null : page, error: null, count: rows.length };
  };

  const builder: any = {
    select: (_columns?: string, options?: Row) => {
      if (options?.head) countHead = true;
      return builder;
    },
    eq: (column: string, value: any) => {
      filters.push({ column, op: 'eq', value });
      return builder;
    },
    neq: (column: string, value: any) => {
      filters.push({ column, op: 'neq', value });
      return builder;
    },
    in: (column: string, values: any[]) => {
      filters.push({ column, op: 'in', value: values });
      return builder;
    },
    is: (column: string, value: any) => {
      filters.push({ column, op: 'is', value });
      return builder;
    },
    gte: (column: string, value: any) => {
      filters.push({ column, op: 'gte', value });
      return builder;
    },
    lte: () => builder,
    lt: (column: string, value: any) => {
      filters.push({ column, op: 'lt', value });
      return builder;
    },
    gt: (column: string, value: any) => {
      filters.push({ column, op: 'gt', value });
      return builder;
    },
    not: (column: string) => {
      filters.push({ column, op: 'not', value: null });
      return builder;
    },
    or: (expression: string) => {
      state.orFilters.push({ table, expression });
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    range: (from: number, to: number) => {
      rangeFrom = from;
      rangeTo = to;
      return builder;
    },
    insert: (rows: Row[]) => {
      inserted = rows;
      return builder;
    },
    update: (values: Row) => {
      patch = values;
      return builder;
    },
    maybeSingle: async () => {
      const result = resolve('single');
      return { data: result.data, error: result.error };
    },
    single: async () => {
      const result = resolve('single');
      if (!result.data) {
        return { data: null, error: { code: 'PGRST116', message: 'no rows returned' } };
      }
      return { data: result.data, error: null };
    },
    then: (onFulfilled: any, onRejected: any) => Promise.resolve(resolve('many')).then(onFulfilled, onRejected),
  };

  return builder;
};

const fakeSupabase = {
  from: (table: string) => createBuilder(table),
  rpc: async (name: string, args: Row) => {
    state.rpcCalls.push({ name, args });

    if (name === 'get_quota_status') {
      return {
        data: {
          access: {
            tier: 'free',
            premium: false,
            source: 'free',
            premium_expires_at: null,
            unlimited_all: false,
            unlimited_features: [],
          },
          features: [
            {
              feature: 'exam_start',
              title_bn: 'পরীক্ষা শুরু',
              title_en: 'Exam start',
              unlimited: false,
              limit: 3,
              used: 1,
              remaining: 2,
              reset_at: '2026-10-22T18:00:00.000Z',
            },
          ],
        },
        error: null,
      };
    }

    return { data: null, error: null };
  },
};

const require = createRequire(__filename);
const supabaseConfigPath = require.resolve('../../config/supabase');

require.cache[supabaseConfigPath] = {
  id: supabaseConfigPath,
  filename: supabaseConfigPath,
  loaded: true,
  exports: { supabase: fakeSupabase },
} as any;

const {
  createGrant,
  revokeGrant,
  updateQuota,
  resetUsage,
  searchUsers,
  getOverview,
  getUserAccessDetails,
  AccessError,
} = require('./access.service');

const ADMIN_ID = 'admin-verified-id';

const grantPayload = (overrides: Row = {}) => ({
  scope: 'user',
  user_id: 'user-1',
  grant_type: 'premium',
  features: null,
  reason: 'Scholarship student',
  expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  ...overrides,
});

const expectAccessError = (status: number) => (error: any) => {
  assert.ok(error instanceof AccessError, `expected AccessError, received ${error?.name}`);
  assert.equal(error.status, status);
  return true;
};

beforeEach(() => {
  state.featureQuotas = [
    { feature: 'exam_start', title_bn: 'পরীক্ষা শুরু', title_en: 'Exam start', free_daily_limit: 3, is_enabled: true },
    { feature: 'ai_message', title_bn: 'এআই', title_en: 'AI message', free_daily_limit: 0, is_enabled: false },
  ];
  state.grants = [];
  state.usageEvents = [];
  state.profiles = [
    { id: 'user-1', subscription_status: 'free' },
    { id: 'user-2', subscription_status: 'premium' },
    { id: 'user-3', subscription_status: 'free' },
  ];
  state.updates = [];
  state.orFilters = [];
  state.rpcCalls = [];
  seq = 0;
});

test('scope=user requires a user_id', async () => {
  await assert.rejects(createGrant(grantPayload({ user_id: null }), ADMIN_ID), expectAccessError(400));
});

test('scope=all rejects a user_id', async () => {
  await assert.rejects(
    createGrant(grantPayload({ scope: 'all', user_id: 'user-1' }), ADMIN_ID),
    expectAccessError(400)
  );
});

test('an invalid grant_type is rejected', async () => {
  await assert.rejects(
    createGrant(grantPayload({ grant_type: 'lifetime' }), ADMIN_ID),
    expectAccessError(400)
  );
});

test('a missing reason is rejected', async () => {
  await assert.rejects(
    createGrant(grantPayload({ reason: '   ' }), ADMIN_ID),
    expectAccessError(400)
  );
});

test('an expiry in the past is rejected', async () => {
  await assert.rejects(
    createGrant(grantPayload({ expires_at: '2020-01-01T00:00:00.000Z' }), ADMIN_ID),
    expectAccessError(400)
  );
});

test('an unknown feature is rejected for unlimited grants', async () => {
  await assert.rejects(
    createGrant(
      grantPayload({ grant_type: 'unlimited_quota', features: ['exam_start', 'not_a_feature'] }),
      ADMIN_ID
    ),
    (error: any) => {
      expectAccessError(400)(error);
      assert.deepEqual(error.details.unknown_features, ['not_a_feature']);
      return true;
    }
  );
});

test('an unlimited_quota grant without features is rejected', async () => {
  await assert.rejects(
    createGrant(grantPayload({ grant_type: 'unlimited_quota', features: [] }), ADMIN_ID),
    expectAccessError(400)
  );
});

test('a valid premium grant records the verified administrator as granted_by', async () => {
  const grant = await createGrant(grantPayload(), ADMIN_ID);

  assert.equal(grant.granted_by, ADMIN_ID);
  assert.equal(grant.scope, 'user');
  assert.equal(grant.user_id, 'user-1');
  assert.equal(grant.grant_type, 'premium');
  assert.equal(grant.features, null);
  assert.ok(grant.starts_at);
});

test('a client-supplied granted_by cannot override the verified administrator', async () => {
  const grant = await createGrant(grantPayload({ granted_by: 'attacker-id' }), ADMIN_ID);

  assert.equal(grant.granted_by, ADMIN_ID);
});

test('an all-users grant stores no user_id', async () => {
  const grant = await createGrant(grantPayload({ scope: 'all', user_id: null }), ADMIN_ID);

  assert.equal(grant.scope, 'all');
  assert.equal(grant.user_id, null);
});

test('unlimited grant features are normalised against feature_quotas', async () => {
  const grant = await createGrant(
    grantPayload({ grant_type: 'unlimited_quota', features: ['exam_start', 'exam_start', ' '] }),
    ADMIN_ID
  );

  assert.deepEqual(grant.features, ['exam_start']);
});

test('revocation records the verified administrator as revoked_by', async () => {
  const grant = await createGrant(grantPayload(), ADMIN_ID);
  const revoked = await revokeGrant(grant.id, ADMIN_ID);

  assert.equal(revoked.revoked_by, ADMIN_ID);
  assert.ok(revoked.revoked_at);
});

test('a revoked grant cannot be revoked again', async () => {
  const grant = await createGrant(grantPayload(), ADMIN_ID);
  await revokeGrant(grant.id, ADMIN_ID);

  await assert.rejects(revokeGrant(grant.id, 'other-admin'), expectAccessError(409));
  assert.equal(state.grants[0].revoked_by, ADMIN_ID);
});

test('revoking an unknown grant returns 404', async () => {
  await assert.rejects(revokeGrant('missing-grant', ADMIN_ID), expectAccessError(404));
});

test('a negative or fractional free_daily_limit is rejected', async () => {
  await assert.rejects(updateQuota('exam_start', { free_daily_limit: -1 }), expectAccessError(400));
  await assert.rejects(updateQuota('exam_start', { free_daily_limit: 1.5 }), expectAccessError(400));
  await assert.rejects(
    updateQuota('exam_start', { free_daily_limit: '3' as unknown as number }),
    expectAccessError(400)
  );
});

test('zero is a valid free_daily_limit', async () => {
  const updated = await updateQuota('exam_start', { free_daily_limit: 0 });

  assert.equal(updated.free_daily_limit, 0);
});

test('an unknown feature cannot be configured', async () => {
  await assert.rejects(updateQuota('does_not_exist', { free_daily_limit: 5 }), expectAccessError(404));
});

test('quota updates ignore unsupported fields', async () => {
  await updateQuota('exam_start', { free_daily_limit: 2, title_bn: 'hacked' } as any);

  const write = state.updates.find((entry) => entry.table === 'feature_quotas');
  assert.deepEqual(write?.patch, { free_daily_limit: 2 });
});

test('usage reset uses the Asia/Dhaka day boundary, not the server timezone', async () => {
  // 00:30 on 23 Oct in Dhaka (18:30 UTC on 22 Oct) is still the same Dhaka day
  // that started at 18:00 UTC on 22 Oct.
  const now = new Date('2026-10-22T18:30:00.000Z');

  state.usageEvents = [
    { id: 'u1', user_id: 'user-1', feature: 'exam_start', usage_date: '2026-10-23', refunded_at: null },
    { id: 'u2', user_id: 'user-1', feature: 'exam_start', usage_date: '2026-10-22', refunded_at: null },
    { id: 'u3', user_id: 'user-2', feature: 'exam_start', usage_date: '2026-10-23', refunded_at: null },
  ];

  const result = await resetUsage('user-1', 'exam_start', now);

  assert.equal(result.since, '2026-10-22T18:00:00.000Z');
  assert.equal(result.refunded, 1);
  assert.ok(state.usageEvents[0].refunded_at);
  assert.equal(state.usageEvents[1].refunded_at, null, 'yesterday must not be touched');
  assert.equal(state.usageEvents[2].refunded_at, null, "another user's usage must not be touched");
});

test('usage reset rejects an unknown feature', async () => {
  await assert.rejects(resetUsage('user-1', 'not_a_feature'), expectAccessError(404));
});

test('user search requires a usable query', async () => {
  await assert.rejects(searchUsers('a'), expectAccessError(400));
  await assert.rejects(searchUsers('ab,cd'), expectAccessError(400));
});

test('overview keeps grants without an expiry active', async () => {
  state.grants = [
    { id: 'g1', scope: 'all', grant_type: 'premium', revoked_at: null, starts_at: '2026-01-01T00:00:00.000Z', expires_at: null },
    { id: 'g2', scope: 'user', user_id: 'user-1', grant_type: 'premium', revoked_at: null, starts_at: '2026-01-01T00:00:00.000Z', expires_at: null },
  ];

  const overview = await getOverview();

  const expiryFilter = state.orFilters.find((entry) => entry.expression.startsWith('expires_at'));
  assert.ok(expiryFilter, 'expiry handling must be expressed as a nullable filter');
  assert.match(expiryFilter!.expression, /expires_at\.is\.null/);
  assert.equal(overview.active_grants, 2);
});

test('overview counts users at the daily limit from today usage events', async () => {
  state.usageEvents = [
    { id: 'e1', user_id: 'user-1', feature: 'exam_start', usage_date: dhakaDayKey(), refunded_at: null },
    { id: 'e2', user_id: 'user-1', feature: 'exam_start', usage_date: dhakaDayKey(), refunded_at: null },
    { id: 'e3', user_id: 'user-1', feature: 'exam_start', usage_date: dhakaDayKey(), refunded_at: null },
    { id: 'e4', user_id: 'user-2', feature: 'exam_start', usage_date: dhakaDayKey(), refunded_at: null },
  ];

  const overview = await getOverview();

  // user-1 reached the limit of 3; user-2 did not.
  assert.equal(overview.users_who_hit_limit_today, 1);
});

test('user access details preserve the get_quota_status contract', async () => {
  const details = await getUserAccessDetails('user-1');

  assert.equal(details.access.source, 'free');
  assert.equal(details.features[0].feature, 'exam_start');
  assert.equal(details.features[0].remaining, 2);
  assert.deepEqual(details.grants, []);
  assert.deepEqual(details.recent_events, []);
});
