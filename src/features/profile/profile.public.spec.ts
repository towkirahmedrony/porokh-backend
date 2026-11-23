import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

type Row = Record<string, any>;

const VIEWER_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

const state: {
  profiles: Row[];
  achievementsMaster: Row[];
  examHistory: Row[];
  queriedTables: string[];
} = {
  profiles: [],
  achievementsMaster: [],
  examHistory: [],
  queriedTables: [],
};

const tableRows = (table: string): Row[] => {
  if (table === 'profiles') return state.profiles;
  if (table === 'achievements_master') return state.achievementsMaster;
  if (table === 'exam_history') return state.examHistory;
  throw new Error(`Unexpected table in public profile flow: ${table}`);
};

const createBuilder = (table: string) => {
  const predicates: Array<(row: Row) => boolean> = [];

  const builder: any = {
    select: () => builder,
    order: () => builder,
    eq: (column: string, value: any) => {
      predicates.push((row) => row[column] === value);
      return builder;
    },
    in: (column: string, values: any[]) => {
      predicates.push((row) => values.includes(row[column]));
      return builder;
    },
    gte: (column: string, value: any) => {
      predicates.push((row) => row[column] >= value);
      return builder;
    },
    resolve: () => tableRows(table).filter((row) => predicates.every((predicate) => predicate(row))),
    single: async () => {
      const rows = builder.resolve();
      return rows.length > 0
        ? { data: rows[0], error: null }
        : { data: null, error: { message: 'Row not found' } };
    },
    maybeSingle: async () => {
      const rows = builder.resolve();
      return { data: rows[0] ?? null, error: null };
    },
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve({ data: builder.resolve(), error: null }).then(onFulfilled, onRejected),
  };

  return builder;
};

const fakeSupabase = {
  from: (table: string) => {
    state.queriedTables.push(table);
    return createBuilder(table);
  },
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
stubModule('../../config/supabaseAdmin', { supabaseAdmin: fakeSupabase });

const { ProfileService } = require('./profile.service');
const { getPublicProfile } = require('./profile.controller');

beforeEach(() => {
  state.profiles = [
    {
      id: TARGET_ID,
      username: 'target',
      full_name: 'Target User',
      total_xp: 120,
      current_streak: 4,
      achievements: ['badge-1'],
      language_preference: 'bn',
    },
    {
      id: VIEWER_ID,
      username: 'viewer',
      full_name: 'Viewer User',
      total_xp: 90,
      current_streak: 2,
      achievements: [],
      language_preference: 'bn',
    },
  ];
  state.achievementsMaster = [
    { id: 'badge-1', title: 'প্রথম পরীক্ষা', title_en: 'First Exam', icon_url: 'https://cdn.example.com/1.png', xp_reward: 10 },
    { id: 'badge-2', title: 'স্ট্রিক', title_en: 'Streak', icon_url: null, xp_reward: 20 },
  ];
  state.examHistory = [
    { user_id: TARGET_ID, created_at: new Date().toISOString(), correct_count: 7, wrong_count: 3 },
    { user_id: VIEWER_ID, created_at: new Date().toISOString(), correct_count: 5, wrong_count: 5 },
  ];
  state.queriedTables = [];
});

test('public profile badges come from profiles.achievements, never a user_badges table', async () => {
  const badges = await ProfileService.getUserBadges(TARGET_ID);

  assert.equal(state.queriedTables.includes('user_badges'), false);
  assert.deepEqual(badges, [
    { id: 'badge-1', title: 'প্রথম পরীক্ষা', icon_url: 'https://cdn.example.com/1.png', is_earned: true },
    { id: 'badge-2', title: 'স্ট্রিক', icon_url: null, is_earned: false },
  ]);
});

test('badge titles localize to English for English-preference profiles', async () => {
  state.profiles[0].language_preference = 'en';
  const badges = await ProfileService.getUserBadges(TARGET_ID);
  assert.equal(badges[0].title, 'First Exam');
});

test('exam stats compute accuracy from answered questions only', async () => {
  state.examHistory = [
    { user_id: TARGET_ID, created_at: new Date().toISOString(), correct_count: 7, wrong_count: 3, skipped_count: 5 },
    { user_id: TARGET_ID, created_at: new Date().toISOString(), correct_count: 0, wrong_count: 0, skipped_count: 2 },
  ];
  const stats = await ProfileService.getExamStats(TARGET_ID);
  assert.deepEqual(stats, { total_exams: 2, accuracy: 70 });
});

test('exam stats are zero for a user without exams', async () => {
  const stats = await ProfileService.getExamStats(VIEWER_ID);
  assert.deepEqual(stats, { total_exams: 1, accuracy: 50 });
  const empty = await ProfileService.getExamStats('33333333-3333-4333-8333-333333333333');
  assert.deepEqual(empty, { total_exams: 0, accuracy: 0 });
});

test('versus comparison returns both players stats for a logged-in viewer', async () => {
  const target = state.profiles[0];
  const versus = await ProfileService.getVersusComparison(target, VIEWER_ID);

  assert.deepEqual(versus, {
    my_stats: { total_xp: 90, current_streak: 2, total_exams: 1, accuracy: 50 },
    their_stats: { total_xp: 120, current_streak: 4, total_exams: 1, accuracy: 70 },
  });
});

test('versus comparison zeroes my stats for anonymous viewers and mirrors them for self views', async () => {
  const target = state.profiles[0];

  const anonymous = await ProfileService.getVersusComparison(target);
  assert.deepEqual(anonymous.my_stats, { total_xp: 0, accuracy: 0, current_streak: 0, total_exams: 0 });

  const self = await ProfileService.getVersusComparison(target, TARGET_ID);
  assert.deepEqual(self.my_stats, self.their_stats);
});

test('activity returns seven Dhaka-day points shaped for the comparison chart', async () => {
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  state.examHistory.push({ user_id: TARGET_ID, created_at: eightDaysAgo, correct_count: 1, wrong_count: 0 });

  const activity = await ProfileService.getActivityStats(TARGET_ID, VIEWER_ID);

  assert.equal(activity.length, 7);
  for (const point of activity) {
    assert.deepEqual(Object.keys(point).sort(), ['day', 'them', 'you']);
  }
  const today = activity[activity.length - 1];
  assert.equal(today.them, 1);
  assert.equal(today.you, 1);
  assert.equal(activity.reduce((sum, point) => sum + point.them, 0), 1);
});

test('self activity mirrors the target counts into you', async () => {
  const activity = await ProfileService.getActivityStats(TARGET_ID, TARGET_ID);
  const today = activity[activity.length - 1];
  assert.equal(today.you, today.them);
  assert.equal(today.them, 1);
});

const callController = (identifier: string, viewerHeader?: string) =>
  new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
    const req: any = {
      params: { identifier },
      headers: viewerHeader ? { 'x-user-id': viewerHeader } : {},
    };
    const res: any = {
      statusCode: 0,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: any) {
        resolve({ statusCode: this.statusCode, body });
        return this;
      },
    };
    getPublicProfile(req, res, (err: unknown) => reject(err));
  });

test('public profile endpoint returns badges, activity and versus stats together', async () => {
  const { statusCode, body } = await callController('target', VIEWER_ID);

  assert.equal(statusCode, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.id, TARGET_ID);
  assert.equal(body.data.badges.length, 2);
  assert.equal(body.data.activity.length, 7);
  assert.equal(body.data.versusStats.my_stats.total_xp, 90);
  assert.equal(body.data.versusStats.their_stats.total_xp, 120);
});

test('a malformed x-user-id header is ignored instead of breaking the profile', async () => {
  const { statusCode, body } = await callController('target', 'not-a-uuid');

  assert.equal(statusCode, 200);
  assert.deepEqual(body.data.versusStats.my_stats, { total_xp: 0, accuracy: 0, current_streak: 0, total_exams: 0 });
});
