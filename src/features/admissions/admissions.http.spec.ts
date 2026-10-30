import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';

type Row = Record<string, any>;

const ADMIN_SESSION_ID = '00000000-0000-4000-8000-000000000002';
const ADMIN_TOKEN = `e30.${Buffer.from(JSON.stringify({ session_id: ADMIN_SESSION_ID })).toString('base64url')}.test`;
const UNIVERSITY_ID = '11111111-1111-4111-8111-111111111111';

const roles: Record<string, string> = {
  'admin-1': 'admin',
  'student-1': 'student',
};

const usersByToken: Record<string, string> = {
  [ADMIN_TOKEN]: 'admin-1',
  'student-token': 'student-1',
};

const state = {
  permissionGranted: true,
};

const createRbacBuilder = (table: string) => {
  const filters: Record<string, any> = {};
  const row = () => {
    if (table === 'user_roles') return { role: roles[String(filters.user_id)] };
    if (table === 'profiles') return { id: filters.id, account_status: 'active' };
    if (
      table === 'admin_auth_sessions' &&
      filters.auth_session_id === ADMIN_SESSION_ID
    ) {
      return { id: 'admin-session-record', user_id: 'admin-1', revoked_at: null };
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
  from: (table: string) => createRbacBuilder(table),
};

const fakeUserClient = {
  rpc: async () => ({ data: state.permissionGranted, error: null }),
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
stubModule('../../config/userSupabase', {
  createUserSupabaseClient: () => fakeUserClient,
});
stubModule('../../lib/utils/adminAudit', { recordAdminAudit: async () => undefined });

const { AdmissionAdminRoutes } = require('./admissions.admin.routes');

const app = express();
app.use(express.json());
app.use('/api/v1/admin/admissions', AdmissionAdminRoutes);
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(err?.status || 500).json({
    success: false,
    message: err?.message || 'error',
    data: null,
    ...(err?.errorCode ? { code: err.errorCode } : {}),
  });
});

let server: Server;
let baseUrl = '';

const request = (
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {}
) =>
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
  state.permissionGranted = true;
});

test('anonymous callers cannot list universities or create units', async () => {
  const list = await request('GET', '/api/v1/admin/admissions/universities');
  assert.equal(list.status, 401);

  const create = await request(
    'POST',
    `/api/v1/admin/admissions/universities/${UNIVERSITY_ID}/units`,
    { body: { name_bn: 'ক', code: 'A' } }
  );
  assert.equal(create.status, 401);

  const remove = await request(
    'DELETE',
    '/api/v1/admin/admissions/units/33333333-3333-4333-8333-333333333333'
  );
  assert.equal(remove.status, 401);
});

test('a forged token is rejected before authorization', async () => {
  const response = await request('GET', '/api/v1/admin/admissions/universities', {
    token: 'forged-token',
  });

  assert.equal(response.status, 401);
});

test('authenticated students cannot manage admission units', async () => {
  const response = await request(
    'POST',
    `/api/v1/admin/admissions/universities/${UNIVERSITY_ID}/units`,
    { token: 'student-token', body: { name_bn: 'ক', code: 'A' } }
  );

  assert.equal(response.status, 403);
});

test('an admin without exams.manage permission is denied', async () => {
  state.permissionGranted = false;

  const response = await request('GET', '/api/v1/admin/admissions/universities', {
    token: ADMIN_TOKEN,
  });

  assert.equal(response.status, 403);
});

test('an authorized admin reaches controller validation', async () => {
  const missingName = await request(
    'POST',
    `/api/v1/admin/admissions/universities/${UNIVERSITY_ID}/units`,
    { token: ADMIN_TOKEN, body: { code: 'A' } }
  );

  assert.equal(missingName.status, 400);
  const body = await missingName.json();
  assert.equal(body.code, 'VALIDATION_FAILED');

  const unknownField = await request(
    'POST',
    `/api/v1/admin/admissions/universities/${UNIVERSITY_ID}/units`,
    {
      token: ADMIN_TOKEN,
      body: { name_bn: 'ক', code: 'A', institution_id: UNIVERSITY_ID },
    }
  );

  assert.equal(unknownField.status, 400);
  assert.equal((await unknownField.json()).code, 'VALIDATION_FAILED');
});

test('an authorized admin cannot use malformed identifiers', async () => {
  const response = await request(
    'PATCH',
    '/api/v1/admin/admissions/units/not-a-uuid',
    { token: ADMIN_TOKEN, body: { is_active: false } }
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'VALIDATION_FAILED');
});

test('an authorized admin must send exactly one boolean status flag', async () => {
  const unitId = '33333333-3333-4333-8333-333333333333';
  const response = await request(
    'PATCH',
    `/api/v1/admin/admissions/units/${unitId}/status`,
    { token: ADMIN_TOKEN, body: { is_active: 'yes' } }
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'VALIDATION_FAILED');
});
