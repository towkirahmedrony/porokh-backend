import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';

type Row = Record<string, any>;

const ADMIN_SESSION_ID = '00000000-0000-4000-8000-000000000002';
const ADMIN_TOKEN = `e30.${Buffer.from(JSON.stringify({ session_id: ADMIN_SESSION_ID })).toString('base64url')}.test`;

const roles: Record<string, string> = {
  'admin-1': 'admin',
  'student-1': 'student',
};

const usersByToken: Record<string, string> = {
  [ADMIN_TOKEN]: 'admin-1',
  'student-token': 'student-1',
};

const state: {
  writes: Row[];
  reads: Row[];
  configs: Record<string, Row>;
  sessionRevoked: boolean;
} = {
  writes: [],
  reads: [],
  sessionRevoked: false,
  configs: {
    xp_rules: { key: 'xp_rules', value: { per_correct_answer: 5 } },
    daily_quote: { key: 'daily_quote', value: { text: 'Hello' } },
    theme_config: { key: 'theme_config', value: { preset: 'default' } },
    private_secret: {
      key: 'private_secret',
      value: { api_key: 'super-secret' },
      maintenance_mode: true,
    },
  },
};

const createRbacBuilder = (table: string) => {
  const filters: Record<string, any> = {};
  const row = () => {
    if (table === 'user_roles') return { role: roles[String(filters.user_id)] };
    if (table === 'profiles') return { id: filters.id, account_status: 'active' };
    if (table === 'admin_auth_sessions' && filters.auth_session_id === ADMIN_SESSION_ID) {
      return { id: 'admin-session-record', user_id: 'admin-1', revoked_at: state.sessionRevoked ? new Date().toISOString() : null };
    }
    return null;
  };

  const builder: any = {
    select: () => builder,
    eq: (column: string, value: any) => {
      filters[column] = value;
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    in: () => builder,
    maybeSingle: async () => ({ data: row(), error: null }),
    single: async () => ({ data: row(), error: null }),
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected),
  };

  return builder;
};

const fakeSupabase = {
  auth: {
    getUser: async (token: string) => {
      const id = usersByToken[token];

      if (!id) return { data: { user: null }, error: { message: 'invalid token' } };

      return { data: { user: { id } }, error: null };
    },
  },
  from: (table: string) =>
    ['user_roles', 'profiles', 'admin_auth_sessions'].includes(table) ? createRbacBuilder(table) : createAdminBuilder(table),
};

const createAdminBuilder = (table: string) => {
  const filters: Record<string, any> = {};
  let selectColumns = '*';
  let operation: string | null = null;
  let payload: Row | null = null;

  const resolve = () => {
    if (operation) {
      state.writes.push({ table, operation, payload, filters: { ...filters } });
      return { data: operation === 'delete' ? null : payload ?? { ...filters }, error: null };
    }

    state.reads.push({ table, selectColumns, filters: { ...filters } });

    if (table === 'app_configs') {
      const key = String(filters.key ?? '');

      if (selectColumns === '*') {
        return { data: Object.values(state.configs), error: null };
      }

      const row = state.configs[key];

      if (!row) return { data: null, error: null };

      const picked: Row = {};
      selectColumns.split(',').map((column) => column.trim()).forEach((column) => {
        if (column in row) picked[column] = row[column];
      });

      return { data: picked, error: null };
    }

    if (table === 'home_banners') return { data: [], error: null };
    if (table === 'home_grids') return { data: [], error: null };
    if (table === 'levels_master') return { data: [], error: null };

    return { data: [], error: null };
  };

  const builder: any = {
    select: (columns: string = '*') => {
      selectColumns = String(columns);
      return builder;
    },
    insert: (rows: Row) => {
      operation = 'insert';
      payload = rows;
      return builder;
    },
    upsert: (rows: Row) => {
      operation = 'upsert';
      payload = rows;
      return builder;
    },
    update: (rows: Row) => {
      operation = 'update';
      payload = rows;
      return builder;
    },
    delete: () => {
      operation = 'delete';
      return builder;
    },
    eq: (column: string, value: any) => {
      filters[column] = value;
      return builder;
    },
    in: () => builder,
    is: () => builder,
    order: () => builder,
    limit: () => builder,
    single: async () => resolve(),
    maybeSingle: async () => resolve(),
    then: (onFulfilled: any, onRejected: any) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
  };

  return builder;
};

const fakeSupabaseAdmin = {
  from: (table: string) => createAdminBuilder(table),
  rpc: async () => ({ data: null, error: null }),
};

const require = createRequire(__filename);

const stubModule = (relativePath: string, exports: unknown) => {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  } as any;
};

stubModule('../../config/supabase', { supabase: fakeSupabase });
stubModule('../../config/supabaseAdmin', { supabaseAdmin: fakeSupabaseAdmin });

const appBuilderRoutes = require('./app-builder.routes').default;
const systemRoutes = require('../system/system.routes').default;

const app = express();
app.use(express.json());
app.use('/api/v1/app-builder', appBuilderRoutes);
app.use('/api/v1/system', systemRoutes);
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(err?.status || 500).json({ success: false, message: err?.message || 'error' });
});

let server: Server;
let baseUrl = '';

const request = (method: string, path: string, options: { token?: string; body?: unknown } = {}) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();

  if (address && typeof address === 'object') {
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
});

after(() => {
  server.close();
});

beforeEach(() => {
  state.writes = [];
  state.reads = [];
  state.sessionRevoked = false;
});

test('anonymous callers cannot modify XP rules', async () => {
  const response = await request('PUT', '/api/v1/app-builder/xp-rules', {
    body: { per_correct_answer: 9999 },
  });

  assert.equal(response.status, 401);
  assert.equal(state.writes.length, 0);
});

test('authenticated students cannot modify XP rules', async () => {
  const response = await request('PUT', '/api/v1/app-builder/xp-rules', {
    token: 'student-token',
    body: { per_correct_answer: 9999 },
  });

  assert.equal(response.status, 403);
  assert.equal(state.writes.length, 0);
});

test('a client-supplied admin role cannot bypass authorization', async () => {
  const response = await request('PUT', '/api/v1/app-builder/xp-rules', {
    token: 'student-token',
    body: { role: 'admin', is_admin: true, per_correct_answer: 9999 },
  });

  assert.equal(response.status, 403);
  assert.equal(state.writes.length, 0);
});

test('a missing or invalid token is rejected', async () => {
  const missing = await request('PUT', '/api/v1/app-builder/xp-rules', {
    body: { per_correct_answer: 1 },
  });
  assert.equal(missing.status, 401);

  const invalid = await request('PUT', '/api/v1/app-builder/xp-rules', {
    token: 'forged-token',
    body: { per_correct_answer: 1 },
  });
  assert.equal(invalid.status, 401);
  assert.equal(state.writes.length, 0);
});

test('authorized administrators can update XP rules with a validated payload', async () => {
  const response = await request('PUT', '/api/v1/app-builder/xp-rules', {
    token: ADMIN_TOKEN,
    body: { per_correct_answer: 10, profile_completion: 50 },
  });

  assert.equal(response.status, 200);
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].table, 'app_configs');
  assert.deepEqual(state.writes[0].payload, {
    key: 'xp_rules',
    value: { per_correct_answer: 10, profile_completion: 50 },
  });
});

test('a revoked application session cannot use an otherwise active Admin role', async () => {
  state.sessionRevoked = true;
  const response = await request('PUT', '/api/v1/app-builder/xp-rules', {
    token: ADMIN_TOKEN,
    body: { per_correct_answer: 10 },
  });

  assert.equal(response.status, 401);
  assert.equal(state.writes.length, 0);
});

test('invalid XP rule payloads are rejected without a write', async () => {
  const stringValue = await request('PUT', '/api/v1/app-builder/xp-rules', {
    token: ADMIN_TOKEN,
    body: { per_correct_answer: 'lots' },
  });
  assert.equal(stringValue.status, 400);

  const nested = await request('PUT', '/api/v1/app-builder/xp-rules', {
    token: ADMIN_TOKEN,
    body: { nested: { deep: true } } as unknown,
  });
  assert.equal(nested.status, 400);
  assert.equal(state.writes.length, 0);
});

test('anonymous callers cannot delete banners', async () => {
  const response = await request('DELETE', '/api/v1/app-builder/banners/banner-1');

  assert.equal(response.status, 401);
  assert.equal(state.writes.length, 0);
});

test('students cannot delete banners and admins can', async () => {
  const student = await request('DELETE', '/api/v1/app-builder/banners/banner-1', {
    token: 'student-token',
  });
  assert.equal(student.status, 403);
  assert.equal(state.writes.length, 0);

  const admin = await request('DELETE', '/api/v1/app-builder/banners/banner-1', {
    token: ADMIN_TOKEN,
  });
  assert.equal(admin.status, 200);
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].operation, 'delete');
  assert.equal(state.writes[0].filters.id, 'banner-1');
});

test('anonymous callers cannot create banners', async () => {
  const response = await request('POST', '/api/v1/app-builder/banners', {
    body: { image_url: 'https://cdn.example.com/a.png' },
  });

  assert.equal(response.status, 401);
  assert.equal(state.writes.length, 0);
});

test('anonymous callers cannot retrieve the full app configuration dump', async () => {
  const response = await request('GET', '/api/v1/app-builder/configs');

  assert.equal(response.status, 401);
  assert.equal(state.reads.length, 0);
});

test('administrators can read the full configuration dump', async () => {
  const response = await request('GET', '/api/v1/app-builder/configs', {
    token: ADMIN_TOKEN,
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((row: Row) => row.key === 'private_secret'));
});

test('public config endpoints return only approved key/value fields', async () => {
  const xpRules = await request('GET', '/api/v1/app-builder/configs/xp_rules');
  assert.equal(xpRules.status, 200);
  const xpBody = await xpRules.json();
  assert.deepEqual(Object.keys(xpBody.data).sort(), ['key', 'value']);

  const dailyQuote = await request('GET', '/api/v1/app-builder/configs/daily_quote');
  assert.equal(dailyQuote.status, 200);
  const quoteBody = await dailyQuote.json();
  assert.deepEqual(Object.keys(quoteBody.data).sort(), ['key', 'value']);
  assert.equal('maintenance_mode' in quoteBody.data, false);
});

test('other privileged app-builder routes are guarded consistently', async () => {
  const anonymousGrid = await request('POST', '/api/v1/app-builder/home-grids', {
    body: { title: 'Hack', icon_name: 'hack' },
  });
  assert.equal(anonymousGrid.status, 401);

  const studentLevels = await request('PUT', '/api/v1/app-builder/levels', {
    token: 'student-token',
    body: { levels: [{ name_bn: 'ক', name_en: 'A', min_xp: 0 }] },
  });
  assert.equal(studentLevels.status, 403);

  const studentQuote = await request('POST', '/api/v1/app-builder/configs/daily_quote', {
    token: 'student-token',
    body: { value: 'hacked' },
  });
  assert.equal(studentQuote.status, 403);

  assert.equal(state.writes.length, 0);
});

test('home-grid writes accept image_url and targeting, and reject unsafe image URLs', async () => {
  const valid = await request('POST', '/api/v1/app-builder/home-grids', {
    token: ADMIN_TOKEN,
    body: {
      title: 'লিডারবোর্ড',
      title_en: 'Leaderboard',
      icon_name: 'trophy',
      image_url: 'https://pbswsbfcmztmbcqnuqny.supabase.co/storage/v1/object/public/app-assets/home-grids/trophy.webp',
      link: '/dashboard/leaderboard',
      type: 'link',
      color: '#16a34a',
      bg_color: '#f0fdf4',
      is_active: true,
      target_rules: { study_goal: ['hsc'] },
    },
  });

  assert.equal(valid.status, 200);
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].table, 'home_grids');
  assert.equal(state.writes[0].payload.image_url.includes('/app-assets/'), true);
  assert.deepEqual(state.writes[0].payload.target_rules, { study_goal: ['hsc'] });

  const invalid = await request('POST', '/api/v1/app-builder/home-grids', {
    token: ADMIN_TOKEN,
    body: {
      title: 'Bad',
      icon_name: 'trophy',
      image_url: 'javascript:alert(1)',
    },
  });

  assert.equal(invalid.status, 400);
  assert.equal(state.writes.length, 1);
});

test('home-grid reorder updates serial_order for each row', async () => {
  const response = await request('PATCH', '/api/v1/app-builder/home-grids/reorder', {
    token: ADMIN_TOKEN,
    body: {
      grids: [
        { id: 'grid-1', serial_order: 1 },
        { id: 'grid-2', serial_order: 2 },
      ],
    },
  });

  assert.equal(response.status, 200);
  assert.equal(state.writes.length, 2);
  assert.deepEqual(
    state.writes.map((write) => ({ id: write.filters.id, order: write.payload.serial_order })),
    [
      { id: 'grid-1', order: 1 },
      { id: 'grid-2', order: 2 },
    ]
  );
});

test('the public active home-grid read filters inactive rows', async () => {
  const response = await request('GET', '/api/v1/app-builder/home-grids?active=true');

  assert.equal(response.status, 200);
  const read = state.reads.find((row) => row.table === 'home_grids');
  assert.ok(read);
  assert.equal(read.filters.is_active, true);
});

test('system configuration reads are restricted to the public allowlist', async () => {
  const privateRead = await request('GET', '/api/v1/system/configs/private_secret');
  assert.equal(privateRead.status, 404);

  const publicRead = await request('GET', '/api/v1/system/configs/xp_rules');
  assert.equal(publicRead.status, 200);
  const body = await publicRead.json();
  assert.deepEqual(Object.keys(body.data).sort(), ['key', 'value']);
});
