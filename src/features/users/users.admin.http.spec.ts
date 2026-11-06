import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

/**
 * HTTP contract tests for the Users & Access admin surface.
 *
 * The real Express app is started on an ephemeral port and driven over HTTP.
 * Only the Supabase transport is replaced, so the tests exercise the actual
 * middleware chain (requireAuth → rbacGuard → requirePermission → controller),
 * including the rules that must never live in the frontend: suspension,
 * privilege escalation, session revocation and audit attribution.
 */

type Row = Record<string, any>;

interface Filter {
  column: string;
  op: string;
  value: any;
  negate?: boolean;
}

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const STUDENT_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_SESSION = '44444444-4444-4444-8444-444444444444';

const tokenFor = new Map<string, string>();

const makeToken = (userId: string, claims: Row = {}): string => {
  const payload = Buffer.from(
    JSON.stringify({ session_id: ADMIN_SESSION, iat: Math.floor(Date.now() / 1000), ...claims })
  ).toString('base64url');
  const token = `e30.${payload}.test`;
  tokenFor.set(token, userId);
  return token;
};

const state: {
  tables: Record<string, Row[]>;
  grantedPermissions: Set<string>;
  rpcCalls: Array<{ name: string; args: Row }>;
  rpcOverrides: Record<string, (args: Row) => { data?: any; error?: any }>;
} = {
  tables: {},
  grantedPermissions: new Set(),
  rpcCalls: [],
  rpcOverrides: {},
};

const rowsFor = (table: string): Row[] => state.tables[table] ?? [];

const matches = (row: Row, filter: Filter): boolean => {
  const actual = row[filter.column];
  const expected = filter.value;
  let result: boolean;

  switch (filter.op) {
    case 'eq':
      result = String(actual ?? '') === String(expected ?? '');
      break;
    case 'neq':
      result = String(actual ?? '') !== String(expected ?? '');
      break;
    case 'is':
      result =
        expected === null || expected === 'null'
          ? actual === null || actual === undefined
          : String(actual) === String(expected);
      break;
    case 'in':
      result = Array.isArray(expected) ? expected.map(String).includes(String(actual)) : false;
      break;
    case 'gt':
      result = actual !== null && actual !== undefined && String(actual) > String(expected);
      break;
    case 'gte':
      result = actual !== null && actual !== undefined && String(actual) >= String(expected);
      break;
    case 'lt':
      result = actual !== null && actual !== undefined && String(actual) < String(expected);
      break;
    case 'lte':
      result = actual !== null && actual !== undefined && String(actual) <= String(expected);
      break;
    case 'like':
    case 'ilike': {
      const pattern = String(expected)
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/%/g, '.*')
        .replace(/_/g, '.');
      result = new RegExp(`^${pattern}$`, filter.op === 'ilike' ? 'i' : '').test(String(actual ?? ''));
      break;
    }
    default:
      result = true;
  }

  return filter.negate ? !result : result;
};

const parseOrExpression = (expression: string): Filter[] =>
  expression.split(',').map((part) => {
    const first = part.indexOf('.');
    const second = part.indexOf('.', first + 1);
    return {
      column: part.slice(0, first),
      op: part.slice(first + 1, second),
      value: part.slice(second + 1),
    };
  });

const createBuilder = (table: string) => {
  const filters: Filter[] = [];
  const orExpressions: string[] = [];
  const orderings: Array<{ column: string; ascending: boolean; nullsFirst: boolean }> = [];
  let rangeFrom = 0;
  let rangeTo = Number.MAX_SAFE_INTEGER;
  let maxRows = Number.MAX_SAFE_INTEGER;
  let inserted: Row[] | null = null;
  let patch: Row | null = null;
  let countMode: 'exact' | null = null;
  let headOnly = false;

  const filtered = (): Row[] => {
    let rows = rowsFor(table).filter(
      (row) =>
        filters.every((filter) => matches(row, filter)) &&
        orExpressions.every((expression) => parseOrExpression(expression).some((filter) => matches(row, filter)))
    );

    if (orderings.length > 0) {
      rows = [...rows].sort((left, right) => {
        for (const ordering of orderings) {
          const a = left[ordering.column];
          const b = right[ordering.column];
          if (a === b) continue;
          if (a === null || a === undefined) return ordering.nullsFirst ? -1 : 1;
          if (b === null || b === undefined) return ordering.nullsFirst ? 1 : -1;
          const comparison = String(a) < String(b) ? -1 : 1;
          return ordering.ascending ? comparison : -comparison;
        }
        return 0;
      });
    }

    return rows;
  };

  const resolve = (mode: 'many' | 'single') => {
    if (inserted) {
      const rows = inserted.map((row) => ({ id: row.id ?? `${table}-${rowsFor(table).length + 1}`, ...row }));
      rowsFor(table).push(...rows);
      return { data: mode === 'single' ? rows[0] : rows, error: null, count: rows.length };
    }

    if (patch) {
      const rows = filtered();
      rows.forEach((row) => Object.assign(row, patch));
      return { data: mode === 'single' ? rows[0] ?? null : rows, error: null, count: rows.length };
    }

    const rows = filtered();
    const total = rows.length;
    const paged = rows.slice(rangeFrom, Math.min(rangeTo + 1, rangeFrom + maxRows));

    return {
      data: mode === 'single' ? rows[0] ?? null : headOnly ? null : paged,
      error: null,
      count: countMode ? total : null,
    };
  };

  const builder: any = {
    select: (_columns?: string, options?: Row) => {
      if (options?.count) countMode = options.count;
      if (options?.head) headOnly = true;
      return builder;
    },
    eq: (column: string, value: any) => {
      filters.push({ column, op: 'eq', value });
      return builder;
    },
    in: (column: string, value: any[]) => {
      filters.push({ column, op: 'in', value });
      return builder;
    },
    is: (column: string, value: any) => {
      filters.push({ column, op: 'is', value });
      return builder;
    },
    not: (column: string, op: string, value: any) => {
      filters.push({ column, op, value, negate: true });
      return builder;
    },
    gt: (column: string, value: any) => {
      filters.push({ column, op: 'gt', value });
      return builder;
    },
    gte: (column: string, value: any) => {
      filters.push({ column, op: 'gte', value });
      return builder;
    },
    lt: (column: string, value: any) => {
      filters.push({ column, op: 'lt', value });
      return builder;
    },
    lte: (column: string, value: any) => {
      filters.push({ column, op: 'lte', value });
      return builder;
    },
    or: (expression: string) => {
      orExpressions.push(expression);
      return builder;
    },
    order: (column: string, options?: Row) => {
      orderings.push({
        column,
        ascending: options?.ascending !== false,
        nullsFirst: options?.nullsFirst === true,
      });
      return builder;
    },
    range: (from: number, to: number) => {
      rangeFrom = from;
      rangeTo = to;
      return builder;
    },
    limit: (count: number) => {
      maxRows = count;
      return builder;
    },
    insert: (rows: Row | Row[]) => {
      inserted = Array.isArray(rows) ? rows : [rows];
      return builder;
    },
    update: (values: Row) => {
      patch = values;
      return builder;
    },
    delete: () => builder,
    maybeSingle: async () => {
      const result = resolve('single');
      return { data: result.data, error: result.error };
    },
    single: async () => {
      const result = resolve('single');
      return result.data ? { data: result.data, error: null } : { data: null, error: { message: 'no rows' } };
    },
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(resolve('many')).then(onFulfilled, onRejected),
  };

  return builder;
};

const defaultRpc = (name: string, args: Row): { data?: any; error?: any } => {
  if (name === 'has_permission') {
    return { data: state.grantedPermissions.has(String(args.p_action)), error: null };
  }
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
        features: [],
      },
      error: null,
    };
  }
  if (name === 'register_admin_auth_session') return { data: 'session-record', error: null };
  return { data: null, error: null };
};

const fakeSupabase = {
  from: (table: string) => createBuilder(table),
  auth: {
    getUser: async (token: string) => {
      const userId = tokenFor.get(token);
      if (!userId) return { data: { user: null }, error: { message: 'invalid token' } };
      return { data: { user: { id: userId } }, error: null };
    },
  },
  rpc: async (name: string, args: Row = {}) => {
    state.rpcCalls.push({ name, args });
    const override = state.rpcOverrides[name];
    return override ? override(args) : defaultRpc(name, args);
  },
};

const require = createRequire(__filename);

const stub = (request: string, exports: Row) => {
  const resolved = require.resolve(request);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any;
};

stub('../../config/supabase', { supabase: fakeSupabase });
stub('../../config/supabaseAdmin', { supabaseAdmin: fakeSupabase });
stub('../../config/supabaseAuth', { supabaseAuth: fakeSupabase });
stub('../../config/userSupabase', { createUserSupabaseClient: () => fakeSupabase });

const app = require('../../app').default;

let server: any;
let baseUrl = '';
let adminToken = '';
let studentToken = '';

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  tokenFor.clear();
  adminToken = makeToken(ADMIN_ID);
  studentToken = makeToken(STUDENT_ID, { session_id: '55555555-5555-4555-8555-555555555555' });

  state.rpcCalls = [];
  state.rpcOverrides = {};
  state.grantedPermissions = new Set([
    'users.read',
    'users.manage',
    'roles.assign.staff',
    'quotas.manage',
  ]);

  state.tables = {
    profiles: [
      {
        id: ADMIN_ID,
        full_name: 'Admin Actor',
        email: 'admin@porokh.test',
        account_status: 'active',
        subscription_status: 'free',
        created_at: '2026-01-01T00:00:00.000Z',
        last_active_at: '2026-11-05T00:00:00.000Z',
        total_xp: 0,
        coin_balance: 0,
        current_streak: 0,
        sessions_revoked_at: null,
      },
      {
        id: STUDENT_ID,
        full_name: 'Rahim Uddin',
        email: 'rahim@porokh.test',
        username: 'rahim',
        phone_number: '01700000000',
        account_status: 'active',
        subscription_status: 'free',
        class_level: 'SSC',
        institution: 'Test School',
        created_at: '2026-02-01T00:00:00.000Z',
        last_active_at: '2026-11-06T00:00:00.000Z',
        total_xp: 120,
        coin_balance: 10,
        current_streak: 3,
        sessions_revoked_at: null,
      },
      {
        id: TARGET_ID,
        full_name: '=cmd|calc',
        email: 'target@porokh.test',
        account_status: 'suspended',
        subscription_status: 'premium',
        created_at: '2026-03-01T00:00:00.000Z',
        last_active_at: null,
        total_xp: 40,
        coin_balance: 5,
        current_streak: 0,
        sessions_revoked_at: null,
      },
    ],
    user_roles: [
      { user_id: ADMIN_ID, role: 'admin', is_active: true },
      { user_id: STUDENT_ID, role: 'student', is_active: true },
      { user_id: TARGET_ID, role: 'moderator', is_active: true },
    ],
    access_grants: [],
    admin_auth_sessions: [
      { id: 'session-record-1', user_id: ADMIN_ID, auth_session_id: ADMIN_SESSION, revoked_at: null },
    ],
    user_devices: [],
    security_audit_logs: [],
    audit_logs: [],
    coin_transactions: [],
    permissions: [],
    role_permissions: [],
    feature_quotas: [],
    usage_events: [],
  };
});

const get = (path: string, token: string) =>
  fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });

const post = (path: string, token: string, body: Row = {}) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

test('the directory rejects requests without a token', async () => {
  const response = await fetch(`${baseUrl}/api/v1/admin/users`);
  assert.equal(response.status, 401);
});

test('the directory rejects a student token', async () => {
  const response = await get('/api/v1/admin/users', studentToken);
  assert.equal(response.status, 403);
});

test('the directory returns a paginated envelope with role and access facts', async () => {
  const response = await get('/api/v1/admin/users?page=1&page_size=2&sort=created_at&direction=desc', adminToken);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.total, 3);
  assert.equal(body.data.items.length, 2);
  assert.equal(body.data.page, 1);
  assert.equal(body.data.page_size, 2);
  assert.equal(body.data.has_more, true);

  const row = body.data.items.find((item: Row) => item.id === STUDENT_ID);
  assert.ok(row, 'the newest two users are returned');
  assert.equal(row.role, 'student');
  assert.equal(row.access.subscription_premium, false);
  assert.equal(row.access.active_grant_count, 0);
});

test('the directory filters by account status, role and search term', async () => {
  const suspended = await (await get('/api/v1/admin/users?status=suspended', adminToken)).json();
  assert.deepEqual(suspended.data.items.map((item: Row) => item.id), [TARGET_ID]);

  const moderators = await (await get('/api/v1/admin/users?role=moderator', adminToken)).json();
  assert.deepEqual(moderators.data.items.map((item: Row) => item.id), [TARGET_ID]);

  const search = await (await get('/api/v1/admin/users?q=rahim', adminToken)).json();
  assert.deepEqual(search.data.items.map((item: Row) => item.id), [STUDENT_ID]);
});

test('the directory rejects an unsupported page size instead of clamping it', async () => {
  const response = await get('/api/v1/admin/users?page_size=500', adminToken);
  assert.equal(response.status, 400);
});

test('the CSV export is owner-scoped, formula-safe and downloadable', async () => {
  const response = await get('/api/v1/admin/users/export?status=suspended', adminToken);
  const csv = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="porokh-users-/);
  assert.match(csv.split('\r\n')[0], /^id,full_name,email/);
  // A name starting with "=" must not become a live spreadsheet formula.
  assert.ok(csv.includes(`'=cmd|calc`), 'formula characters are neutralised');
});

test('suspending an account goes through the authoritative RPC and is audited', async () => {
  const response = await post(`/api/v1/admin/users/${STUDENT_ID}/status`, adminToken, {
    status: 'suspended',
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.account_status, 'suspended');

  const call = state.rpcCalls.find((entry) => entry.name === 'set_user_account_status');
  assert.ok(call, 'the guard RPC is invoked');
  assert.deepEqual(call?.args, { p_target_user_id: STUDENT_ID, p_status: 'suspended' });

  const audit = rowsFor('audit_logs').find((row) => row.action === 'users.account.suspend');
  assert.ok(audit, 'the action is recorded');
  assert.equal(audit?.user_id, ADMIN_ID, 'the actor comes from the verified token');
  assert.equal(audit?.target_id, STUDENT_ID);
});

test('a refused status change returns 403 and writes no audit row', async () => {
  state.rpcOverrides.set_user_account_status = () => ({
    error: { code: '42501', message: 'insufficient role authority' },
  });

  const response = await post(`/api/v1/admin/users/${ADMIN_ID}/status`, adminToken, {
    status: 'suspended',
  });

  assert.equal(response.status, 403);
  assert.equal(rowsFor('audit_logs').length, 0);
});

test('role assignment is refused when the caller lacks the staff-assignment permission', async () => {
  state.grantedPermissions.delete('roles.assign.staff');

  const response = await post(`/api/v1/admin/users/${STUDENT_ID}/role`, adminToken, {
    role: 'moderator',
  });

  assert.equal(response.status, 403);
  assert.equal(state.rpcCalls.some((entry) => entry.name === 'assign_user_role'), false);
});

test('privilege escalation is refused by the database guard', async () => {
  state.rpcOverrides.assign_user_role = () => ({
    error: { code: '42501', message: 'insufficient role authority' },
  });

  const response = await post(`/api/v1/admin/users/${TARGET_ID}/role`, adminToken, {
    role: 'super_admin',
  });
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.match(body.message, /role does not permit/i);
});

test('force logout surfaces a missing migration instead of reporting success', async () => {
  state.rpcOverrides.revoke_user_sessions = () => ({
    error: { code: 'PGRST202', message: 'Could not find the function public.revoke_user_sessions' },
  });

  const response = await post(`/api/v1/admin/users/${STUDENT_ID}/force-logout`, adminToken, {});
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.match(body.message, /not available/i);
});

test('force logout revokes sessions and records the actor', async () => {
  const response = await post(`/api/v1/admin/users/${STUDENT_ID}/force-logout`, adminToken, {});

  assert.equal(response.status, 200);

  const call = state.rpcCalls.find((entry) => entry.name === 'revoke_user_sessions');
  assert.deepEqual(call?.args, { p_target_user_id: STUDENT_ID });

  const audit = rowsFor('audit_logs').find((row) => row.action === 'users.sessions.force_logout');
  assert.equal(audit?.user_id, ADMIN_ID);
});

test('an access token issued before a revocation is rejected immediately', async () => {
  const issuedAt = Math.floor(Date.now() / 1000) - 60;
  const revokedToken = makeToken(STUDENT_ID, { session_id: ADMIN_SESSION, iat: issuedAt });

  (rowsFor('profiles').find((row) => row.id === STUDENT_ID) as Row).sessions_revoked_at =
    new Date((issuedAt + 5) * 1000).toISOString();

  // The admin endpoint is used only to observe authentication: a revoked token
  // must fail before authorization is evaluated.
  const response = await get('/api/v1/admin/users', revokedToken);
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.match(body.message, /Session revoked/i);
});

test('the risk monitor reports only accounts with recorded signals', async () => {
  state.tables.user_devices = [
    ...[1, 2, 3, 4, 5].map((index) => ({
      id: `device-${index}`,
      user_id: TARGET_ID,
      device_name: `Phone ${index}`,
      platform: 'android',
      ip_address: `10.0.0.${index}`,
      last_active_at: new Date(Date.now() - 60_000).toISOString(),
      is_trusted: true,
    })),
    {
      id: 'device-quiet',
      user_id: STUDENT_ID,
      device_name: 'Quiet phone',
      platform: 'android',
      ip_address: '10.1.1.1',
      last_active_at: new Date(Date.now() - 60_000).toISOString(),
      is_trusted: true,
    },
  ];

  const response = await get('/api/v1/admin/users/security/risk', adminToken);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.length, 1, 'a single-device account is not flagged');
  assert.equal(body.data[0].user_id, TARGET_ID);
  assert.equal(body.data[0].level, 'high');
  assert.equal(body.data[0].active_devices_24h, 5);
  assert.ok(body.data[0].signals.length >= 2);
  assert.ok(
    body.data[0].signals.every((signal: Row) => typeof signal.detail === 'string' && signal.detail.length > 0),
    'every signal carries its evidence'
  );
});

test('a coin deduction that would go negative is refused', async () => {
  const response = await post(`/api/v1/admin/users/${STUDENT_ID}/adjust-balance`, adminToken, {
    amount: -50,
    reason: 'Correcting a mistaken reward',
  });
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.match(body.message, /is not possible/);
  assert.equal(rowsFor('coin_transactions').length, 0);
});

test('a coin adjustment updates the balance and writes the ledger', async () => {
  const response = await post(`/api/v1/admin/users/${STUDENT_ID}/adjust-balance`, adminToken, {
    amount: 30,
    reason: 'Support compensation',
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.balance_before, 10);
  assert.equal(body.data.balance_after, 40);

  const profile = rowsFor('profiles').find((row) => row.id === STUDENT_ID) as Row;
  assert.equal(profile.coin_balance, 40);

  const ledger = rowsFor('coin_transactions')[0];
  assert.equal(ledger.amount, 30);
  assert.equal(ledger.transaction_type, 'admin_adjustment');
  assert.equal(ledger.description, 'Support compensation');
});
