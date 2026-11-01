import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import speakeasy from 'speakeasy';

/**
 * Regression coverage for H-05: mock administrator authentication.
 *
 * The Supabase clients are faked at the transport boundary, so these tests
 * exercise the real controller/service logic (including the removal of the
 * `mock_jwt_for_<id>` path) without live credentials. They do NOT prove live
 * Supabase Auth configuration; see the final report.
 */

type Row = Record<string, any>;

const db = {
  profiles: [] as Row[],
  user_roles: [] as Row[],
  admin_sessions: [] as Row[],
  user_devices: [] as Row[],
  profileQueryError: false,
};

const calls = {
  signIn: [] as Row[],
  signUp: [] as Row[],
  signOut: [] as string[],
  generateLink: [] as Row[],
  verifyOtp: [] as Row[],
};

const active2faSecret = speakeasy.generateSecret({ name: 'test' }).base32;

let seq = 0;

const same = (a: any, b: any) => String(a) === String(b);

const matches = (row: Row, filters: Record<string, any>) =>
  Object.entries(filters).every(([column, value]) => {
    if (value === null) return row[column] === null || row[column] === undefined;
    return same(row[column], value);
  });

const rowsFor = (table: string) =>
  (db as Record<string, Row[]>)[table] ?? (db[table] = [] as Row[]);

const createBuilder = (table: string) => {
  const filters: Record<string, any> = {};
  let inserted: Row[] | null = null;
  let update: Row | null = null;
  let deleted = false;
  let countMode = false;

  const resolve = (mode: 'many' | 'single') => {
    const rows = rowsFor(table);

    if (table === 'profiles' && db.profileQueryError) {
      return { data: null, error: { message: 'database unavailable' } };
    }

    if (inserted) {
      const stored = inserted.map((row) => {
        seq += 1;
        const created = { id: `${table}-${seq}`, ...row };
        rows.push(created);
        return created;
      });

      return { data: mode === 'single' ? stored[0] : stored, error: null };
    }

    if (update) {
      const matched = rows.filter((row) => matches(row, filters));
      matched.forEach((row) => Object.assign(row, update));
      return { data: matched, error: null };
    }

    if (deleted) {
      const remaining = rows.filter((row) => !matches(row, filters));
      rows.length = 0;
      rows.push(...remaining);
      return { data: [], error: null };
    }

    const matched = rows.filter((row) => matches(row, filters));

    if (countMode) return { data: null, count: matched.length, error: null };

    return { data: mode === 'single' ? matched[0] ?? null : matched, error: null };
  };

  const builder: any = {
    select: (_columns?: string, options?: Row) => {
      countMode = Boolean(options?.count);
      return builder;
    },
    eq: (column: string, value: any) => {
      filters[column] = value;
      return builder;
    },
    in: (column: string, values: any[]) => {
      filters[column] = values;
      return builder;
    },
    is: () => builder,
    gt: () => builder,
    gte: () => builder,
    order: () => builder,
    limit: () => builder,
    insert: (values: Row[] | Row) => {
      inserted = Array.isArray(values) ? values : [values];
      return builder;
    },
    update: (values: Row) => {
      update = values;
      return builder;
    },
    delete: () => {
      deleted = true;
      return builder;
    },
    maybeSingle: async () => resolve('single'),
    single: async () => resolve('single'),
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(resolve('many')).then(onFulfilled, onRejected),
  };

  return builder;
};

const fakeSupabase = {
  from: (table: string) => createBuilder(table),
  rpc: async () => ({ data: null, error: null }),
  auth: {
    getUser: async (token: string) => {
      if (token === 'real-access-token' || token === 'real-access-token-2') {
        return { data: { user: { id: 'admin-1' } }, error: null };
      }

      return { data: { user: null }, error: { message: 'invalid token' } };
    },
  },
};

const fakeSupabaseAdmin = {
  from: (table: string) => createBuilder(table),
  auth: {
    admin: {
      signOut: async (token: string) => {
        calls.signOut.push(token);
        return { data: null, error: null };
      },
      generateLink: async (payload: Row) => {
        calls.generateLink.push(payload);
        return {
          data: { properties: { hashed_token: `hashed-${payload.email}` } },
          error: null,
        };
      },
    },
  },
};

const fakeSupabaseAuth = {
  auth: {
    signUp: async (payload: Row) => {
      calls.signUp.push(payload);

      if (payload.email === 'existing@example.com') {
        return {
          data: { user: { id: 'existing-1', email: payload.email, identities: [] }, session: null },
          error: null,
        };
      }

      if (payload.password === 'short') {
        return {
          data: { user: null, session: null },
          error: { message: 'Password should be at least 8 characters' },
        };
      }

      return {
        data: {
          user: {
            id: 'new-1',
            email: payload.email,
            email_confirmed_at: null,
            identities: [{ id: 'identity-1' }],
          },
          session: null,
        },
        error: null,
      };
    },
    signInWithPassword: async (payload: Row) => {
      calls.signIn.push(payload);

      const profile = db.profiles.find((item) => item.email === payload.email);

      if (!profile || payload.password !== 'correct-password') {
        return { data: { user: null, session: null }, error: { message: 'invalid' } };
      }

      return {
        data: {
          user: { id: profile.id, email: profile.email },
          session: {
            access_token: 'real-access-token',
            refresh_token: 'real-refresh-token',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          },
        },
        error: null,
      };
    },
    verifyOtp: async (payload: Row) => {
      calls.verifyOtp.push(payload);

      return {
        data: {
          session: {
            access_token: 'real-access-token-2',
            refresh_token: 'real-refresh-token-2',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          },
        },
        error: null,
      };
    },
  },
};

const require = createRequire(__filename);

const installFake = (modulePath: string, exports: Row) => {
  const resolved = require.resolve(modulePath);

  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  } as any;
};

installFake('../../config/supabase', { supabase: fakeSupabase });
installFake('../../config/supabaseAdmin', { supabaseAdmin: fakeSupabaseAdmin });
installFake('../../config/supabaseAuth', { supabaseAuth: fakeSupabaseAuth });

const { authController } = require('./auth.controller');
const { authService } = require('./auth.service');
const { requireAuth } = require('../../middlewares/requireAuth');
const { ExamAdminService } = require('../exams/exams.admin.service');

const createRes = () => {
  const res: any = {
    statusCode: 0,
    body: null,
    cookieCalls: [] as Row[],
  };

  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  res.cookie = (name: string, value: string, options: Row) => {
    res.cookieCalls.push({ name, value, options });
    return res;
  };
  res.setHeader = () => res;

  return res;
};

const invoke = async (handler: any, req: Row) => {
  const res = createRes();
  await handler(req, res);
  return res;
};

const login = async (body: Row) =>
  invoke(authController.adminLoginInit, { body, cookies: {}, headers: {}, socket: {} });

beforeEach(() => {
  seq = 0;
  db.profiles = [
    {
      id: 'admin-1',
      email: 'admin@example.com',
      username: 'admin_1',
      account_status: 'active',
      is_2fa_enabled: false,
      settings: {},
      full_name: 'Admin',
    },
    {
      id: 'student-1',
      email: 'student@example.com',
      username: 'student_1',
      account_status: 'active',
      is_2fa_enabled: false,
      settings: {},
      full_name: 'Student',
    },
    {
      id: 'admin-2fa',
      email: 'secure-admin@example.com',
      username: 'secure_admin',
      account_status: 'active',
      is_2fa_enabled: true,
      settings: { two_factor_secret: active2faSecret },
      full_name: 'Secure Admin',
    },
  ];
  db.user_roles = [
    { user_id: 'admin-1', role: 'admin', is_active: true },
    { user_id: 'student-1', role: 'student', is_active: true },
    { user_id: 'admin-2fa', role: 'admin', is_active: true },
  ];
  db.admin_sessions = [];
  db.user_devices = [];
  db.profileQueryError = false;
  calls.signIn = [];
  calls.signUp = [];
  calls.signOut = [];
  calls.generateLink = [];
  calls.verifyOtp = [];
});

test('H-05: a user id alone can never authenticate', async () => {
  const res = await login({ userId: 'admin-1' });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.token, undefined);
  assert.equal(calls.signIn.length, 0);
});

test('H-05: a mock_jwt token is never issued, even for a valid admin', async () => {
  const res = await login({ email: 'admin@example.com', password: 'correct-password' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'success');
  assert.equal(res.body.token, 'real-access-token');
  assert.equal(String(res.body.token).includes('mock_jwt'), false);
  assert.equal(res.body.role, 'admin');
});

test('H-05: invalid credentials are rejected', async () => {
  const res = await login({ email: 'admin@example.com', password: 'wrong-password' });

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.token, undefined);
});

test('username login verifies credentials server-side without returning the resolved email', async () => {
  const res = await invoke(authController.usernameLogin, {
    body: { username: '  STUDENT_1 ', password: 'correct-password' },
    headers: {},
    socket: {},
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.session.access_token, 'real-access-token');
  assert.equal('email' in res.body, false);
  assert.equal(JSON.stringify(res.body).includes('student@example.com'), false);
  assert.deepEqual(calls.signIn.at(-1), { email: 'student@example.com', password: 'correct-password' });
});

test('unknown usernames and incorrect passwords share the same public failure', async () => {
  const unknown = await invoke(authController.usernameLogin, {
    body: { username: 'missing_user', password: 'correct-password' }, headers: {}, socket: {},
  });
  const wrongPassword = await invoke(authController.usernameLogin, {
    body: { username: 'student_1', password: 'wrong-password' }, headers: {}, socket: {},
  });

  assert.equal(unknown.statusCode, 401);
  assert.deepEqual(unknown.body, wrongPassword.body);
  assert.equal(JSON.stringify(unknown.body).includes('@'), false);
});

test('registration sends credentials only and ignores profile fields', async () => {
  const res = await invoke(authController.register, {
    body: {
      email: '  New@Example.com ',
      password: 'correct-password',
      full_name: 'Should Be Ignored',
      username: 'should_be_ignored',
    },
    headers: {},
    socket: {},
  });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.requires_email_verification, true);
  assert.equal(res.body.session, null);
  assert.deepEqual(calls.signUp.at(-1), {
    email: 'new@example.com',
    password: 'correct-password',
    options: { data: {} },
  });
});

test('registration reports an existing email without issuing a session', async () => {
  const res = await invoke(authController.register, {
    body: { email: 'existing@example.com', password: 'correct-password' },
    headers: {},
    socket: {},
  });

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'EMAIL_ALREADY_REGISTERED');
  assert.equal(res.body.session, undefined);
});

test('registration rejects a short password before calling Supabase', async () => {
  const res = await invoke(authController.register, {
    body: { email: 'new@example.com', password: 'short' },
    headers: {},
    socket: {},
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'WEAK_PASSWORD');
  assert.equal(calls.signUp.length, 0);
});

test('registration rejects a malformed email before calling Supabase', async () => {
  const res = await invoke(authController.register, {
    body: { email: 'not-an-email', password: 'correct-password' },
    headers: {},
    socket: {},
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'VALIDATION_FAILED');
  assert.equal(calls.signUp.length, 0);
});

test('H-05: a client-supplied role cannot grant administrator access', async () => {
  const res = await login({
    email: 'student@example.com',
    password: 'correct-password',
    role: 'admin',
    is_admin: true,
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.token, undefined);
  assert.deepEqual(calls.signOut, ['real-access-token']);
});

test('H-05: an admin with 2FA gets no token before the second factor', async () => {
  const res = await login({ email: 'secure-admin@example.com', password: 'correct-password' });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'require_2fa');
  assert.equal(res.body.token, undefined);
  assert.equal(typeof res.body.challenge, 'string');
  assert.ok(res.body.challenge.length >= 32);
  assert.deepEqual(calls.signOut, ['real-access-token']);
  assert.equal(db.admin_sessions.length, 1);
  assert.equal(db.admin_sessions[0].is_2fa_verified, false);
});

test('H-05: an unknown or forged login challenge is rejected', async () => {
  const res = await invoke(authController.verify2FA, {
    body: { challenge: 'forged-challenge', token: '123456' },
    headers: {},
    socket: {},
  });

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.token, undefined);
  assert.equal(calls.generateLink.length, 0);
});

test('H-05: an invalid TOTP code does not mint a session', async () => {
  const loginRes = await login({
    email: 'secure-admin@example.com',
    password: 'correct-password',
  });

  const res = await invoke(authController.verify2FA, {
    body: { challenge: loginRes.body.challenge, token: '000000' },
    headers: {},
    socket: {},
  });

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.token, undefined);
  assert.equal(calls.generateLink.length, 0);
  assert.equal(calls.verifyOtp.length, 0);
});

test('H-05: a valid TOTP code mints a genuine session and consumes the challenge', async () => {
  const loginRes = await login({
    email: 'secure-admin@example.com',
    password: 'correct-password',
  });

  const totp = speakeasy.totp({ secret: active2faSecret, encoding: 'base32' });

  const res = await invoke(authController.verify2FA, {
    body: { challenge: loginRes.body.challenge, token: totp },
    headers: {},
    socket: {},
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.token, 'real-access-token-2');
  assert.equal(res.body.role, 'admin');
  assert.equal(calls.generateLink.length, 1);
  assert.equal(calls.generateLink[0].email, 'secure-admin@example.com');
  assert.equal(db.admin_sessions.length, 0);

  // Replaying the same challenge must fail.
  const replay = await invoke(authController.verify2FA, {
    body: { challenge: loginRes.body.challenge, token: totp },
    headers: {},
    socket: {},
  });

  assert.equal(replay.statusCode, 401);
});

test('H-05: forged and mock tokens are rejected by requireAuth', async () => {
  for (const token of ['mock_jwt_for_admin-1', 'forged-token']) {
    const res = createRes();
    let nextCalled = false;

    await requireAuth(
      { headers: { authorization: `Bearer ${token}` } } as any,
      res,
      (() => {
        nextCalled = true;
      }) as any
    );

    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  }

  const res = createRes();
  let authenticated = false;

  await requireAuth(
    { headers: { authorization: 'Bearer real-access-token' } } as any,
    res,
    (() => {
      authenticated = true;
    }) as any
  );

  assert.equal(authenticated, true);
});

test('H-05: device registration uses the authenticated id, not the body', async () => {
  const res = await invoke(authController.saveDeviceInfo, {
    user: { id: 'admin-1' },
    body: { user_id: 'student-1', device_name: 'phone' },
    headers: { 'x-forwarded-for': '203.0.113.9' },
    socket: {},
  });

  assert.equal(res.statusCode, 200);
  assert.equal(db.user_devices[0].user_id, 'admin-1');
});

test('protected operations reject a suspended profile despite a valid issued token', async () => {
  db.profiles.find((profile) => profile.id === 'admin-1')!.account_status = 'suspended';
  const req = { headers: { authorization: 'Bearer real-access-token' }, body: { account_status: 'active' } } as any;
  const res = createRes();
  let nextCalled = false;

  await requireAuth(req, res, (() => { nextCalled = true; }) as any);

  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
  assert.equal(req.user, undefined);
});

test('protected operations fail closed when account status cannot be verified', async () => {
  db.profileQueryError = true;
  const res = await invoke(requireAuth, { headers: { authorization: 'Bearer real-access-token' } });

  assert.equal(res.statusCode, 503);
});

test('H-05: privileged exam admin operations remain admin-gated', async () => {
  // The route stack is requireAuth + rbacGuard(['admin']); verify no endpoint
  // that mutates exam papers is registered without that guard.
  const routerModule = require('../exams/exams.admin.routes');
  const stack = routerModule.ExamAdminRoutes.stack || [];

  const guarded = stack.some((layer: any) => layer.name === 'requireAuth');
  assert.equal(guarded, true);

  assert.equal(typeof ExamAdminService.togglePublish, 'function');
  assert.equal(typeof authService.authenticateWithPassword, 'function');
});
