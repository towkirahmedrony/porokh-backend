import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

type Row = Record<string, any>;

const state: {
  stageAnswers: Row[];
  lastUpdate: Row | null;
  lastUpdateId: string | null;
  updateCalls: number;
} = {
  stageAnswers: [],
  lastUpdate: null,
  lastUpdateId: null,
  updateCalls: 0,
};

const loadModule = createRequire(__filename);

const stubModule = (relativePath: string, exports: unknown) => {
  const resolved = loadModule.resolve(relativePath);
  (loadModule as any).cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  } as any;
};

const fakeSupabase = {
  from: () => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: { message: 'not used' } }),
    };
    return builder;
  },
};

const fakeSupabaseAdmin = {
  from: (table: string) => ({
    update: (payload: Row) => {
      state.lastUpdate = payload;
      state.updateCalls += 1;
      return {
        eq: async (column: string, value: string) => {
          if (column === 'id') state.lastUpdateId = value;
          return { data: null, error: table === 'profiles' ? null : { message: 'unexpected table' } };
        },
      };
    },
  }),
};

const fakeUserClient = {
  rpc: async (name: string) => {
    if (name !== 'get_my_stage') return { data: null, error: { message: 'unexpected rpc' } };
    const next = state.stageAnswers.shift();
    if (!next) return { data: null, error: { message: 'no stage answer queued' } };
    return { data: next, error: null };
  },
};

stubModule('../../config/supabase', { supabase: fakeSupabase });
stubModule('../../config/supabaseAdmin', { supabaseAdmin: fakeSupabaseAdmin });
stubModule('../../config/userSupabase', {
  createUserSupabaseClient: () => fakeUserClient,
});

const { ProfileService } = loadModule('./profile.service');
const {
  parseHscBatch,
  parseStageResponse,
  parseStudyGoal,
  ProfileValidationError,
} = loadModule('./profile.validation');

const stagePayload = (overrides: Row = {}): Row => ({
  stage: 'studying',
  batch_year: '2027',
  goal: null,
  needs_goal_gate: false,
  exam_ended: false,
  ...overrides,
});

beforeEach(() => {
  state.stageAnswers = [];
  state.lastUpdate = null;
  state.lastUpdateId = null;
  state.updateCalls = 0;
});

test('only the four known goals parse, and hsc is refused after the exam', () => {
  assert.equal(parseStudyGoal('medical'), 'medical');
  assert.equal(parseStudyGoal('  VARSITY '), 'varsity');
  assert.throws(() => parseStudyGoal('MBBS'), ProfileValidationError);
  assert.throws(() => parseStudyGoal(undefined), ProfileValidationError);
  assert.throws(
    () => parseStudyGoal('hsc', { allowHsc: false }),
    ProfileValidationError
  );
});

test('a batch year is four digits starting with 20', () => {
  assert.equal(parseHscBatch('2027'), '2027');
  assert.throws(() => parseHscBatch('27'), ProfileValidationError);
  assert.throws(() => parseHscBatch('2026-27'), ProfileValidationError);
  assert.throws(() => parseHscBatch('abcd'), ProfileValidationError);
  // 2019 is a well-formed year, so the format check accepts it. Whether the
  // batch exists at all is a separate check against hsc_batches.
  assert.equal(parseHscBatch('2019'), '2019');
});

test('a stage payload must carry the exact five fields', () => {
  assert.deepEqual(parseStageResponse(stagePayload()), {
    stage: 'studying',
    batch_year: '2027',
    goal: null,
    needs_goal_gate: false,
    exam_ended: false,
  });

  assert.throws(() => parseStageResponse(stagePayload({ stage: 'graduate' })), ProfileValidationError);
  assert.throws(() => parseStageResponse(stagePayload({ needs_goal_gate: 'no' })), ProfileValidationError);
  assert.throws(() => parseStageResponse(stagePayload({ goal: 'doctor' })), ProfileValidationError);
  assert.throws(() => parseStageResponse(null), ProfileValidationError);
});

test('a stage read without a session is rejected before any RPC call', async () => {
  await assert.rejects(ProfileService.getMyStage(undefined), /Session unavailable/);
});

test('choosing a goal stamps the confirmation and returns the refreshed stage', async () => {
  state.stageAnswers = [
    stagePayload({ stage: 'post_hsc', needs_goal_gate: true, exam_ended: true }),
    stagePayload({ stage: 'admission_prep', goal: 'medical', needs_goal_gate: false, exam_ended: true }),
  ];

  const result = await ProfileService.setGoal('user-1', 'token-1', 'medical');

  assert.equal(state.lastUpdateId, 'user-1');
  assert.equal(state.lastUpdate?.study_goal, 'medical');
  assert.ok(typeof state.lastUpdate?.goal_confirmed_at === 'string');
  assert.equal(result.stage, 'admission_prep');
  assert.equal(result.needs_goal_gate, false);
});

test('hsc cannot be chosen once the server says the exam ended', async () => {
  state.stageAnswers = [stagePayload({ stage: 'post_hsc', needs_goal_gate: true, exam_ended: true })];

  await assert.rejects(
    ProfileService.setGoal('user-1', 'token-1', 'hsc'),
    ProfileValidationError
  );

  assert.equal(state.updateCalls, 0);
});
