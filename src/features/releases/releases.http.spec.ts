import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

/**
 * HTTP-level contract tests for the APK distribution API.
 *
 * A real Express app is started on an ephemeral port and driven over HTTP; only
 * Supabase (database and Storage) is faked. The tests cover the public
 * availability contract, the authorization boundary on every admin operation,
 * upload validation, replacement safety and deletion.
 */

type Row = Record<string, any>;

// Modules that build their own client at import time (for example the phone
// verification router) need the names to exist. Every Supabase module this
// spec actually exercises is stubbed below.
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const ADMIN_SESSION_ID = '00000000-0000-4000-8000-000000000001';
const toToken = (payload: Row): string =>
  `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test`;
const ADMIN_TOKEN = toToken({
  session_id: ADMIN_SESSION_ID,
  iat: Math.floor(Date.now() / 1000),
});
const STUDENT_TOKEN = toToken({ iat: Math.floor(Date.now() / 1000) });

const state: {
  release: Row | null;
  roles: Row[];
  profiles: Row[];
  adminSessions: Row[];
  hasPermission: boolean;
  objects: Map<string, Buffer>;
  uploadFails: boolean;
  removeFails: boolean;
  reportedSize: number | null;
} = {
  release: null,
  roles: [],
  profiles: [],
  adminSessions: [],
  hasPermission: true,
  objects: new Map(),
  uploadFails: false,
  removeFails: false,
  reportedSize: null,
};

const filtersMatch = (row: Row, filters: Row[]) =>
  filters.every(({ column, value }) => String(row[column]) === String(value));

const createBuilder = (table: string) => {
  const filters: Row[] = [];
  let operation: 'select' | 'upsert' | 'delete' = 'select';

  const resolve = (): { data: any; error: any } => {
    if (table === 'apk_release') {
      if (operation === 'upsert') return { data: state.release, error: null };
      if (operation === 'delete') {
        state.release = null;
        return { data: [], error: null };
      }
      return { data: state.release, error: null };
    }

    const rowsFor = (): Row[] => {
      if (table === 'user_roles') return state.roles;
      if (table === 'profiles') return state.profiles;
      if (table === 'admin_auth_sessions') return state.adminSessions;
      return [];
    };

    const rows = rowsFor().filter((row) => filtersMatch(row, filters));
    return { data: rows, error: null };
  };

  const builder: any = {
    select: () => builder,
    eq: (column: string, value: any) => {
      filters.push({ column, value });
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    upsert: (row: Row) => {
      operation = 'upsert';
      state.release = { ...row };
      return builder;
    },
    delete: () => {
      operation = 'delete';
      return builder;
    },
    maybeSingle: async () => {
      const result = resolve();
      const row = Array.isArray(result.data) ? result.data[0] ?? null : result.data ?? null;
      return { data: row, error: result.error };
    },
    single: async () => {
      const result = resolve();
      const row = Array.isArray(result.data) ? result.data[0] ?? null : result.data ?? null;
      return { data: row, error: result.error };
    },
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected),
  };

  return builder;
};

const storageClient = {
  upload: async (path: string, body: Buffer | Uint8Array) => {
    if (state.uploadFails) return { data: null, error: { message: 'storage unavailable' } };
    state.objects.set(path, Buffer.from(body));
    return { data: { path }, error: null };
  },
  list: async () => {
    const object = state.objects.get('releases/latest/Porokh.apk');
    if (!object) return { data: [], error: null };
    return {
      data: [
        {
          name: 'Porokh.apk',
          metadata: { size: state.reportedSize ?? object.length },
        },
      ],
      error: null,
    };
  },
  remove: async (paths: string[]) => {
    if (state.removeFails) return { data: null, error: { message: 'storage unavailable' } };
    paths.forEach((path) => state.objects.delete(path));
    return { data: [], error: null };
  },
};

const permissionClient = {
  rpc: async (name: string) =>
    name === 'has_permission'
      ? { data: state.hasPermission, error: null }
      : { data: null, error: null },
};

const fakeSupabase = {
  from: (table: string) => createBuilder(table),
  storage: { from: () => storageClient },
  auth: {
    getUser: async (token: string) => {
      if (token === ADMIN_TOKEN) return { data: { user: { id: 'admin-1' } }, error: null };
      if (token === STUDENT_TOKEN) return { data: { user: { id: 'user-1' } }, error: null };
      return { data: { user: null }, error: { message: 'invalid token' } };
    },
  },
  rpc: async () => ({ data: null, error: null }),
};

const nodeRequire = createRequire(__filename);

const stub = (request: string, exports: Row) => {
  const resolved = nodeRequire.resolve(request);
  nodeRequire.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  } as any;
};

stub('../../config/supabase', { supabase: fakeSupabase });
stub('../../config/supabaseAdmin', { supabaseAdmin: fakeSupabase });
stub('../../config/supabaseAuth', { supabaseAuth: fakeSupabase });
stub('../../config/userSupabase', { createUserSupabaseClient: () => permissionClient });

const app = nodeRequire('../../app').default;

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

const buildApk = (): Buffer => {
  const name = Buffer.from('AndroidManifest.xml');
  const dex = Buffer.from('classes.dex');
  const data = Buffer.from('x');

  const local = (entry: Buffer) => {
    const header = Buffer.alloc(30 + entry.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(entry.length, 26);
    entry.copy(header, 30);
    return Buffer.concat([header, data]);
  };

  const central = (entry: Buffer, offset: number) => {
    const header = Buffer.alloc(46 + entry.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(entry.length, 28);
    header.writeUInt32LE(offset, 42);
    entry.copy(header, 46);
    return header;
  };

  const manifestLocal = local(name);
  const dexLocal = local(dex);
  const directory = Buffer.concat([
    central(name, 0),
    central(dex, manifestLocal.length),
  ]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(2, 8);
  eocd.writeUInt16LE(2, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(manifestLocal.length + dexLocal.length, 16);

  return Buffer.concat([manifestLocal, dexLocal, directory, eocd]);
};

const seedRelease = (overrides: Row = {}) => {
  state.release = {
    id: 1,
    version_name: '1.0.4',
    version_code: 10004,
    original_filename: 'Porokh-1.0.4.apk',
    file_size: 1234,
    sha256: 'a'.repeat(64),
    released_at: '2026-11-20T00:00:00.000Z',
    updated_at: '2026-11-20T00:00:00.000Z',
    published_by: null,
    ...overrides,
  };
  state.objects.set('releases/latest/Porokh.apk', Buffer.from('previous'));
};

const uploadQuery = '?version_name=1.0.5&version_code=10005&filename=Porokh.apk';

const postApk = (body: Buffer | string, token: string = ADMIN_TOKEN, query = uploadQuery) =>
  fetch(`${baseUrl}/api/v1/admin/releases/apk${query}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/vnd.android.package-archive',
    },
    body: typeof body === 'string' ? body : new Uint8Array(body),
  });

const get = (path: string, token?: string) =>
  fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

beforeEach(() => {
  state.release = null;
  state.objects.clear();
  state.uploadFails = false;
  state.removeFails = false;
  state.reportedSize = null;
  state.hasPermission = true;
  state.roles = [
    { user_id: 'admin-1', role: 'admin', is_active: true },
    { user_id: 'user-1', role: 'student', is_active: true },
  ];
  state.profiles = [
    { id: 'admin-1', account_status: 'active', sessions_revoked_at: null },
    { id: 'user-1', account_status: 'active', sessions_revoked_at: null },
  ];
  state.adminSessions = [
    {
      id: 'session-record-1',
      user_id: 'admin-1',
      auth_session_id: ADMIN_SESSION_ID,
      revoked_at: null,
    },
  ];
});

test('the public endpoint reports no release with 404 when nothing is published', async () => {
  const response = await get('/api/v1/releases/latest');
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.success, false);
  assert.deepEqual(body.data, { available: false });
});

test('the public endpoint returns the published release and its stable URL', async () => {
  seedRelease();

  const response = await get('/api/v1/releases/latest');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.available, true);
  assert.equal(body.data.versionName, '1.0.4');
  assert.equal(body.data.versionCode, 10004);
  assert.equal(body.data.fileSize, 1234);
  assert.equal(body.data.sha256, 'a'.repeat(64));
  assert.ok(
    body.data.downloadUrl.endsWith(
      '/storage/v1/object/public/porokh-apk/releases/latest/Porokh.apk'
    ),
    body.data.downloadUrl
  );
});

test('admin endpoints reject requests without a token', async () => {
  for (const [method, path] of [
    ['GET', '/api/v1/admin/releases/apk'],
    ['POST', '/api/v1/admin/releases/apk'],
    ['DELETE', '/api/v1/admin/releases/apk'],
  ] as const) {
    const response = await fetch(`${baseUrl}${path}`, { method });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test('admin endpoints reject a student and never write', async () => {
  const list = await get('/api/v1/admin/releases/apk', STUDENT_TOKEN);
  assert.equal(list.status, 403);

  const upload = await postApk(buildApk(), STUDENT_TOKEN);
  assert.equal(upload.status, 403);
  assert.equal(state.objects.size, 0, 'a rejected upload must not reach storage');
  assert.equal(state.release, null);

  const remove = await fetch(`${baseUrl}/api/v1/admin/releases/apk`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${STUDENT_TOKEN}` },
  });
  assert.equal(remove.status, 403);
});

test('an admin without the settings permission is rejected', async () => {
  state.hasPermission = false;

  const response = await postApk(buildApk());
  assert.equal(response.status, 403);
  assert.equal(state.objects.size, 0);
});

test('a missing or invalid APK is rejected with 400', async () => {
  const notAnApk = await postApk('<!doctype html><title>error</title>');
  assert.equal(notAnApk.status, 400);
  assert.match((await notAnApk.json()).message, /not an Android APK/);
  assert.equal(state.objects.size, 0);

  const missing = await fetch(`${baseUrl}/api/v1/admin/releases/apk`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/vnd.android.package-archive',
    },
  });
  assert.equal(missing.status, 400);
});

test('bad version metadata is rejected before anything is stored', async () => {
  const response = await postApk(
    buildApk(),
    ADMIN_TOKEN,
    '?version_name=latest&version_code=1&filename=Porokh.apk'
  );

  assert.equal(response.status, 400);
  assert.equal(state.objects.size, 0);
  assert.equal(state.release, null);
});

test('an admin upload publishes the APK and the public endpoint serves it', async () => {
  const file = buildApk();

  const response = await postApk(file);
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.data.versionName, '1.0.5');
  assert.equal(body.data.versionCode, 10005);
  assert.equal(body.data.fileSize, file.length);
  assert.equal(body.data.sha256.length, 64);
  assert.equal(state.objects.get('releases/latest/Porokh.apk')?.length, file.length);

  const latest = await get('/api/v1/releases/latest');
  assert.equal(latest.status, 200);
  assert.equal((await latest.json()).data.versionName, '1.0.5');
});

test('a replacement points the same canonical object at the new build', async () => {
  seedRelease();
  const file = buildApk();

  const response = await postApk(file);
  assert.equal(response.status, 201);

  assert.equal(state.objects.size, 1);
  assert.equal(state.objects.get('releases/latest/Porokh.apk')?.length, file.length);
  assert.equal(state.release?.version_name, '1.0.5');
});

test('a failed upload leaves the previous release intact and public', async () => {
  seedRelease();
  state.uploadFails = true;

  const response = await postApk(buildApk());
  assert.equal(response.status, 502);
  assert.match((await response.json()).message, /could not be uploaded/);

  assert.equal(state.release?.version_name, '1.0.4');
  assert.equal(state.objects.get('releases/latest/Porokh.apk')?.toString(), 'previous');
});

test('a stored object whose size does not match is treated as a failed publish', async () => {
  seedRelease();
  state.reportedSize = 7;

  const response = await postApk(buildApk());
  assert.equal(response.status, 502);
  assert.equal(state.release?.version_name, '1.0.4');
});

test('deleting removes the object and stops publishing the release', async () => {
  seedRelease();

  const response = await fetch(`${baseUrl}/api/v1/admin/releases/apk`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.deleted, true);
  assert.equal(state.release, null);
  assert.equal(state.objects.size, 0);

  const latest = await get('/api/v1/releases/latest');
  assert.equal(latest.status, 404);
});

test('a storage deletion failure keeps the release published', async () => {
  seedRelease();
  state.removeFails = true;

  const response = await fetch(`${baseUrl}/api/v1/admin/releases/apk`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });

  assert.equal(response.status, 502);
  assert.equal(state.release?.version_name, '1.0.4');
});

test('the admin view reports an unpublished release without failing', async () => {
  const response = await get('/api/v1/admin/releases/apk', ADMIN_TOKEN);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, { available: false });
});

test('the admin view and the public release stay on the same canonical path', async () => {
  seedRelease();

  const admin = await get('/api/v1/admin/releases/apk', ADMIN_TOKEN);
  const publicRelease = await get('/api/v1/releases/latest');
  const adminBody = await admin.json();
  const publicBody = await publicRelease.json();

  assert.equal(adminBody.data.storagePath, 'releases/latest/Porokh.apk');
  assert.equal(adminBody.data.downloadUrl, publicBody.data.downloadUrl);
});
