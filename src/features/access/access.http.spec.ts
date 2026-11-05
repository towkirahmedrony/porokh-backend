import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

/**
 * HTTP-level contract tests for the freemium endpoints.
 *
 * A real Express app is started on an ephemeral local port and driven over
 * HTTP; only the Supabase/Firebase transports are faked. This verifies the
 * status codes and JSON bodies the clients actually receive — in particular the
 * FREE_LIMIT_REACHED / PREMIUM_REQUIRED contract, the /me/access payload, admin
 * authorization and the CORS allowlist.
 *
 * No network, no credentials and no database are involved.
 */

type Row = Record<string, any>;

const QUOTA_RESET_AT = '2026-10-22T18:00:00.000Z';
const ADMIN_SESSION_ID = '00000000-0000-4000-8000-000000000001';
const ADMIN_TOKEN = `e30.${Buffer.from(JSON.stringify({ session_id: ADMIN_SESSION_ID })).toString('base64url')}.test`;

const state: {
  examPapers: Row[];
  examPaperQuestions: Row[];
  questions: Row[];
  attempts: Row[];
  roles: Row[];
  profiles: Row[];
  adminSessions: Row[];
  featureQuotas: Row[];
  quotaAllowed: boolean;
  access: Row;
} = {
  examPapers: [],
  examPaperQuestions: [],
  questions: [],
  attempts: [],
  roles: [],
  profiles: [],
  adminSessions: [],
  featureQuotas: [],
  quotaAllowed: true,
  access: {
    tier: 'free',
    premium: false,
    source: 'free',
    premium_expires_at: null,
    unlimited_all: false,
    unlimited_features: [],
  },
};

let seq = 0;

const filtersMatch = (row: Row, filters: Row[]) =>
  filters.every(({ column, op, value }) => {
    const actual = row[column];
    if (Array.isArray(value)) return value.map(String).includes(String(actual));
    if (op === 'is') return value === null ? actual === null || actual === undefined : String(actual) === String(value);
    return String(actual) === String(value);
  });

const createBuilder = (table: string) => {
  const filters: Row[] = [];
  let inserted: Row[] | null = null;
  let patch: Row | null = null;

  const rowsFor = (): Row[] => {
    if (table === 'exam_papers') return state.examPapers;
    if (table === 'exam_paper_questions') return state.examPaperQuestions;
    if (table === 'questions') return state.questions;
    if (table === 'exam_progress') return state.attempts;
    if (table === 'user_roles') return state.roles;
    if (table === 'profiles') return state.profiles;
    if (table === 'admin_auth_sessions') return state.adminSessions;
    if (table === 'feature_quotas') return state.featureQuotas;
    return [];
  };

  const resolve = (mode: 'many' | 'single') => {
    if (inserted) {
      seq += 1;
      const rows = inserted.map((row) => ({
        id: row.id ?? `${table}-${seq}`,
        answers_draft: {},
        current_question_index: 0,
        submitted_at: null,
        exam_history_id: null,
        last_updated_at: new Date().toISOString(),
        ...row,
      }));
      rowsFor().push(...rows);
      return { data: mode === 'single' ? rows[0] : rows, error: null };
    }

    if (patch) {
      const rows = rowsFor().filter((row) => filtersMatch(row, filters));
      rows.forEach((row) => Object.assign(row, patch));
      return { data: mode === 'single' ? rows[0] ?? null : rows, error: null };
    }

    const rows = rowsFor().filter((row) => filtersMatch(row, filters));
    return { data: mode === 'single' ? rows[0] ?? null : rows, error: null };
  };

  const builder: any = {
    select: () => builder,
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
    gt: () => builder,
    gte: () => builder,
    or: () => builder,
    order: () => builder,
    limit: () => builder,
    insert: (rows: Row[]) => {
      inserted = rows;
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
    then: (onFulfilled: any, onRejected: any) => Promise.resolve(resolve('many')).then(onFulfilled, onRejected),
  };

  return builder;
};

const fakeSupabase = {
  from: (table: string) => createBuilder(table),
  auth: {
    getUser: async (token: string) => {
      if (token === 'token-student') return { data: { user: { id: 'user-1' } }, error: null };
      if (token === ADMIN_TOKEN) return { data: { user: { id: 'admin-1' } }, error: null };
      return { data: { user: null }, error: { message: 'invalid token' } };
    },
  },
  rpc: async (name: string) => {
    if (name === 'has_permission') return { data: true, error: null };
    if (name === 'get_user_access') return { data: { ...state.access }, error: null };

    if (name === 'consume_quota') {
      return {
        data: state.quotaAllowed
          ? {
              allowed: true,
              metered: true,
              unlimited: false,
              used: 1,
              limit: 3,
              remaining: 2,
              reset_at: QUOTA_RESET_AT,
              reason: 'consumed',
              idempotent: false,
            }
          : {
              allowed: false,
              metered: true,
              unlimited: false,
              used: 3,
              limit: 3,
              remaining: 0,
              reset_at: QUOTA_RESET_AT,
              reason: 'daily_limit_reached',
              idempotent: false,
            },
        error: null,
      };
    }

    if (name === 'get_quota_status') {
      return {
        data: {
          access: { ...state.access },
          features: [
            {
              feature: 'exam_start',
              title_bn: 'পরীক্ষা শুরু',
              title_en: 'Exam start',
              unlimited: false,
              limit: 3,
              used: state.quotaAllowed ? 1 : 3,
              remaining: state.quotaAllowed ? 2 : 0,
              reset_at: QUOTA_RESET_AT,
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
  seq = 0;
  state.quotaAllowed = true;
  state.examPapers = [
    {
      id: 'exam-1',
      is_published: true,
      is_premium: false,
      duration_min: 30,
      start_time: null,
      end_time: null,
      default_negative_marks: 0.25,
      total_marks: 2,
      result_publish_time: null,
    },
  ];
  state.examPaperQuestions = [{ exam_id: 'exam-1', question_id: 'q-1', sequence: 1 }];
  state.questions = [{ id: 'q-1', is_active: true, status: 'published', deleted_at: null }];
  state.attempts = [];
  state.roles = [
    { user_id: 'user-1', role: 'student', is_active: true },
    { user_id: 'admin-1', role: 'admin', is_active: true },
  ];
  state.profiles = [
    { id: 'user-1', account_status: 'active' },
    { id: 'admin-1', account_status: 'active' },
  ];
  state.adminSessions = [{ id: 'session-record-1', user_id: 'admin-1', auth_session_id: ADMIN_SESSION_ID, revoked_at: null }];
  state.featureQuotas = [
    { feature: 'exam_start', title_bn: 'পরীক্ষা শুরু', title_en: 'Exam start', free_daily_limit: 3, is_enabled: true },
    { feature: 'ai_message', title_bn: 'এআই', title_en: 'AI message', free_daily_limit: 0, is_enabled: false },
  ];
  state.access = {
    tier: 'free',
    premium: false,
    source: 'free',
    premium_expires_at: null,
    unlimited_all: false,
    unlimited_features: [],
  };
});

const post = (path: string, token: string, body: Row = {}) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const get = (path: string, token: string) =>
  fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });

test('a denied exam start returns 403 with the FREE_LIMIT_REACHED contract', async () => {
  state.quotaAllowed = false;

  const response = await post('/api/v1/exams/user/attempts/start', 'token-student', { exam_id: 'exam-1' });
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.success, false);
  assert.equal(body.code, 'FREE_LIMIT_REACHED');
  assert.equal(typeof body.message, 'string');
  assert.deepEqual(body.details, {
    // The code is repeated inside details so clients that only inspect the
    // details object can still recognise the paywall trigger.
    code: 'FREE_LIMIT_REACHED',
    feature: 'exam_start',
    limit: 3,
    used: 3,
    reset_at: QUOTA_RESET_AT,
  });
  assert.equal(state.attempts.length, 0, 'a denied request must not create an attempt');
});

test('an allowed exam start returns the created attempt', async () => {
  const response = await post('/api/v1/exams/user/attempts/start', 'token-student', { exam_id: 'exam-1' });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.ok(body.data?.id);
  assert.equal(body.data.status, 'in_progress');
  assert.equal(state.attempts.length, 1);
});

test('a premium exam returns 403 PREMIUM_REQUIRED for a free student', async () => {
  state.examPapers[0].is_premium = true;

  const response = await post('/api/v1/exams/user/attempts/start', 'token-student', { exam_id: 'exam-1' });
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.code, 'PREMIUM_REQUIRED');
  assert.equal(body.details.feature, 'premium_content');
  assert.equal(state.attempts.length, 0);
});

test('an unauthenticated exam start is rejected with 401', async () => {
  const response = await fetch(`${baseUrl}/api/v1/exams/user/attempts/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exam_id: 'exam-1' }),
  });

  assert.equal(response.status, 401);
});

test('GET /me/access exposes the authoritative access and features arrays', async () => {
  const response = await get('/api/v1/me/access', 'token-student');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.access.source, 'free');
  assert.equal(body.data.access.premium, false);
  assert.equal(body.data.features[0].feature, 'exam_start');
  assert.equal(body.data.features[0].title_en, 'Exam start');
  assert.equal(body.data.features[0].reset_at, QUOTA_RESET_AT);
});

test('admin access endpoints reject an ordinary student token', async () => {
  for (const path of ['/api/v1/admin/access/quotas', '/api/v1/admin/access/grants', '/api/v1/admin/access/overview']) {
    const response = await get(path, 'token-student');
    assert.equal(response.status, 403, `expected 403 for ${path}`);
  }
});

test('admin access endpoints accept an administrator token', async () => {
  const response = await get('/api/v1/admin/access/quotas', ADMIN_TOKEN);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.length, 2);
});

test('the deployed user-app origin is allowed by CORS', async () => {
  const response = await fetch(`${baseUrl}/api/v1/me/access`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://parapothexam.web.app',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });

  assert.ok(response.status === 204 || response.status === 200, `unexpected status ${response.status}`);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://parapothexam.web.app');
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});

test('the deployed admin-panel origin is allowed by CORS', async () => {
  const response = await fetch(`${baseUrl}/api/v1/admin/access/quotas`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://parapoth-studio.web.app',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });

  assert.equal(response.headers.get('access-control-allow-origin'), 'https://parapoth-studio.web.app');
});

test('an unknown origin is still rejected', async () => {
  const response = await fetch(`${baseUrl}/api/v1/me/access`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' },
  });

  assert.equal(response.status, 403);
});
