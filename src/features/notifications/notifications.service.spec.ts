import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

type Row = Record<string, any>;

const state: {
  profiles: Row[];
  notifications: Row[];
  nextId: number;
} = {
  profiles: [],
  notifications: [],
  nextId: 1,
};

const createBuilder = (table: string) => {
  const filters: Array<[string, unknown]> = [];
  let action: 'select' | 'upsert' | 'update' = 'select';
  let payload: Row[] | Row | null = null;

  const matches = (row: Row) =>
    filters.every(([column, value]) =>
      Array.isArray(value) ? value.includes(row[column]) : row[column] === value
    );

  const resolve = () => {
    if (table === 'profiles') {
      return { data: state.profiles.filter(matches), error: null };
    }

    if (table === 'notifications' && action === 'upsert') {
      const rows = (payload as Row[]) ?? [];
      const stored: Row[] = [];

      for (const row of rows) {
        const duplicate =
          row.dedupe_key &&
          state.notifications.some((item) => item.dedupe_key === row.dedupe_key);
        if (duplicate) continue;

        const created = { id: `n${state.nextId++}`, ...row };
        state.notifications.push(created);
        stored.push(created);
      }

      return { data: stored, error: null };
    }

    if (table === 'notifications' && action === 'update') {
      for (const row of state.notifications.filter(matches)) {
        Object.assign(row, payload);
      }
      return { data: null, error: null };
    }

    return { data: [], error: null };
  };

  const builder: any = {
    select: () => builder,
    insert: (rows: Row[]) => {
      payload = rows;
      return builder;
    },
    upsert: (rows: Row[]) => {
      action = 'upsert';
      payload = rows;
      return builder;
    },
    update: (row: Row) => {
      action = 'update';
      payload = row;
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      filters.push([column, values]);
      return builder;
    },
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    },
    maybeSingle: () => builder,
    single: () => builder,
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected),
  };

  return builder;
};

const fakeSupabase = { from: (table: string) => createBuilder(table) };

const require = createRequire(__filename);
const supabaseConfigPath = require.resolve('../../config/supabaseAdmin');
require.cache[supabaseConfigPath] = {
  id: supabaseConfigPath,
  filename: supabaseConfigPath,
  loaded: true,
  exports: { supabaseAdmin: fakeSupabase },
} as any;

const { normalizePreferences, levelForXp, notify } =
  require('./notifications.service') as typeof import('./notifications.service');

const USER_ID = 'user-1';

beforeEach(() => {
  state.profiles = [
    {
      id: USER_ID,
      language_preference: 'en',
      settings: {},
    },
  ];
  state.notifications = [];
  state.nextId = 1;
});

test('notification preferences default to every type and channel enabled', () => {
  const preferences = normalizePreferences(undefined);

  assert.equal(preferences.in_app, true);
  assert.equal(preferences.push, true);
  assert.deepEqual(preferences.types, {
    exam: true,
    reward: true,
    streak: true,
    social: true,
    billing: true,
    security: true,
  });
});

test('billing and security cannot be disabled, other types can', () => {
  const preferences = normalizePreferences({
    in_app: false,
    push: false,
    types: { exam: false, billing: false, security: false, unknown: false },
  });

  assert.equal(preferences.in_app, false);
  assert.equal(preferences.push, false);
  assert.equal(preferences.types.exam, false);
  assert.equal(preferences.types.billing, true);
  assert.equal(preferences.types.security, true);
  assert.equal('unknown' in preferences.types, false);
});

test('malformed preference payloads fall back to safe defaults', () => {
  const preferences = normalizePreferences({
    in_app: 'no',
    push: 1,
    types: ['exam'],
  });

  assert.equal(preferences.in_app, true);
  assert.equal(preferences.push, true);
  assert.equal(preferences.types.exam, true);
});

test('level lookup picks the highest threshold reached', () => {
  const levels = [
    { id: 1, name_bn: 'শুরু', name_en: 'Start', min_xp: 0, max_xp: 99 },
    { id: 2, name_bn: 'সক্রিয়', name_en: 'Active', min_xp: 100, max_xp: 499 },
    { id: 3, name_bn: 'উন্নত', name_en: 'Advanced', min_xp: 500, max_xp: null },
  ];

  assert.equal(levelForXp(levels, 0)?.id, 1);
  assert.equal(levelForXp(levels, 99)?.id, 1);
  assert.equal(levelForXp(levels, 100)?.id, 2);
  assert.equal(levelForXp(levels, 10_000)?.id, 3);
  assert.equal(levelForXp([], 50), null);
});

test('notify skips a type the user disabled', async () => {
  state.profiles[0].settings = {
    notification_preferences: { types: { exam: false } },
  };

  const result = await notify({
    userIds: USER_ID,
    type: 'exam',
    eventCode: 'exam_live_10m',
    title: { bn: 'পরীক্ষা', en: 'Exam' },
    body: { bn: 'শীঘ্রই', en: 'Soon' },
  });

  assert.equal(result.inserted, 0);
  assert.equal(result.skipped, 1);
  assert.equal(state.notifications.length, 0);
});

test('mandatory security notifications ignore disabled preferences', async () => {
  state.profiles[0].settings = {
    notification_preferences: {
      in_app: false,
      types: { security: false },
    },
  };

  const result = await notify({
    userIds: USER_ID,
    type: 'security',
    eventCode: 'new_device_login',
    title: { bn: 'নতুন ডিভাইস', en: 'New device' },
    body: { bn: 'লগইন', en: 'Login' },
  });

  assert.equal(result.inserted, 1);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].type, 'security');
  assert.equal(state.notifications[0].status, 'sent');
  assert.equal(state.notifications[0].event_code, 'new_device_login');
});

test('notify is idempotent for a repeated dedupe key', async () => {
  const input = {
    userIds: USER_ID,
    type: 'exam' as const,
    eventCode: 'exam_result',
    title: { bn: 'ফলাফল', en: 'Result' },
    body: { bn: 'প্রকাশিত', en: 'Published' },
    dedupeKey: `exam_result:exam-1:${USER_ID}`,
  };

  const first = await notify(input);
  const second = await notify(input);

  assert.equal(first.inserted, 1);
  assert.equal(second.inserted, 0);
  assert.equal(state.notifications.length, 1);
});
