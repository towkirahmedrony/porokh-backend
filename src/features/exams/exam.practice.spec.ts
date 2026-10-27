import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

type Row = Record<string, any>;

const state = {
  attempts: [] as Row[],
  history: [] as Row[],
  historySets: {} as Record<string, Row[]>,
  wrongSets: {} as Record<string, Row[]>,
  poolCount: 0,
  mistakeCounts: [] as Row[],
  picked: [] as string[],
  quotaAllowed: true,
  quotaConsumptions: [] as Row[],
  refunds: [] as Row[],
  appConfig: { practice_duration_min: 15 } as Row,
  inserts: [] as Row[],
  updates: [] as Row[],
  questions: [] as Row[],
  timeLimits: {} as Record<string, number | null>,
  failNextInsert: false,
  rpcErrors: {} as Record<string, Row>,
  historyRpcErrors: {} as Record<string, Row>,
};

const matches = (row: Row, filters: Row, nullFilters: string[]) => {
  for (const [column, value] of Object.entries(filters)) {
    if (String(row[column]) !== String(value)) return false;
  }
  for (const column of nullFilters) {
    if (row[column] !== null && row[column] !== undefined) return false;
  }
  return true;
};

const tableRows = (table: string): Row[] => {
  if (table === 'exam_progress') return state.attempts;
  if (table === 'exam_history') return state.history;
  if (table === 'questions') return state.questions;
  return [];
};

const createBuilder = (table: string) => {
  const filters: Row = {};
  const nullFilters: string[] = [];
  let inserted: Row[] | null = null;
  let update: Row | null = null;
  let selected: string[] | null = null;

  const resolve = (single: boolean) => {
    if (table === 'app_configs') {
      return {
        data: single ? { value: state.appConfig } : [{ value: state.appConfig }],
        error: null,
      };
    }

    if (update) {
      const rows = tableRows(table).filter((row) => matches(row, filters, nullFilters));
      const updated = rows.map((row) => {
        Object.assign(row, update);
        return row;
      });
      state.updates.push({ ...update, matched: rows.length });
      return { data: single ? updated[0] ?? null : updated, error: null };
    }

    if (inserted) {
      if (state.failNextInsert) {
        state.failNextInsert = false;
        return { data: null, error: { message: 'simulated insert failure' } };
      }

      const rows = inserted.map((row) => {
        const stored = {
          id: row.id ?? `attempt-${state.attempts.length + 1}`,
          ...row,
        };
        state.inserts.push(stored);
        tableRows(table).push(stored);
        return stored;
      });

      return { data: single ? rows[0] : rows, error: null };
    }

    const rows = tableRows(table)
      .filter((row) => matches(row, filters, nullFilters))
      .map(project);
    return { data: single ? rows[0] ?? null : rows, error: null };
  };

  const project = (row: Row) => {
    if (!selected || selected.length === 0) return row;
    return Object.fromEntries(
      selected.filter((column) => column in row).map((column) => [column, row[column]])
    );
  };

  const builder: any = {
    select: (columns?: string) => {
      if (columns && columns.trim() !== '*') {
        selected = columns.split(',').map((column) => column.trim()).filter(Boolean);
      }
      return builder;
    },
    eq: (column: string, value: any) => {
      filters[column] = value;
      return builder;
    },
    is: (column: string, value: any) => {
      if (value === null) nullFilters.push(column);
      return builder;
    },
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    insert: (rows: Row[] | Row) => {
      inserted = Array.isArray(rows) ? rows : [rows];
      return builder;
    },
    update: (values: Row) => {
      update = values;
      return builder;
    },
    maybeSingle: async () => resolve(true),
    single: async () => resolve(true),
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(resolve(false)).then(onFulfilled, onRejected),
  };

  return builder;
};

const rpc = async (name: string, args: Row) => {
  const forced = state.rpcErrors[name];
  if (forced) return { data: null, error: forced };

  if (name === 'consume_quota') {
    state.quotaConsumptions.push({ ...args });
    return {
      data: state.quotaAllowed
        ? { allowed: true, metered: true, unlimited: false, limit: 3, used: 1 }
        : { allowed: false, metered: true, unlimited: false, limit: 3, used: 3 },
      error: null,
    };
  }

  if (name === 'refund_quota') {
    state.refunds.push({ ...args });
    return { data: null, error: null };
  }

  if (name === 'get_history_question_set') {
    const forcedHistory = state.historyRpcErrors[args.p_history_id];
    if (forcedHistory) return { data: null, error: forcedHistory };
    return { data: state.historySets[args.p_history_id] ?? [], error: null };
  }

  if (name === 'get_history_wrong_questions') {
    const forcedHistory = state.historyRpcErrors[args.p_history_id];
    if (forcedHistory) return { data: null, error: forcedHistory };
    return { data: state.wrongSets[args.p_history_id] ?? [], error: null };
  }

  if (name === 'count_mistake_pool') {
    return { data: state.poolCount, error: null };
  }

  if (name === 'get_user_mistake_counts') {
    return { data: state.mistakeCounts, error: null };
  }

  if (name === 'get_history_time_limit') {
    return { data: state.timeLimits[args.p_history_id] ?? null, error: null };
  }

  if (name === 'pick_mistake_questions') {
    const count = Number(args.p_count);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      return { data: null, error: { code: '22023', message: 'invalid_count' } };
    }
    return {
      data: state.picked.slice(0, count).map((question_id) => ({ question_id })),
      error: null,
    };
  }

  return { data: null, error: null };
};

const fakeSupabase = {
  from: (table: string) => createBuilder(table),
  rpc,
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
  ExamPracticeService,
  PRACTICE_MODES,
} = require('./exam.practice.service');
const { getUserExamHistory } = require('../history/history.service');

const q = (suffix: string) => `9b2f0c2d-0000-4000-8000-00000000000${suffix}`;

const seedAttempt = (overrides: Row = {}) => {
  const attempt = {
    id: `attempt-${state.attempts.length + 1}`,
    user_id: 'user-1',
    exam_id: null,
    kind: 'practice',
    status: 'in_progress',
    started_at: new Date(Date.now() - 30_000).toISOString(),
    deadline_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    submitted_at: null,
    answers_draft: {},
    current_question_index: 0,
    time_remaining: 900,
    last_updated_at: new Date().toISOString(),
    exam_history_id: null,
    question_ids: [q('1')],
    practice_mode: null,
    source_history_id: null,
    ...overrides,
  };

  state.attempts.push(attempt);
  return attempt;
};

beforeEach(() => {
  state.attempts = [];
  state.history = [];
  state.historySets = {};
  state.wrongSets = {};
  state.poolCount = 0;
  state.mistakeCounts = [];
  state.picked = [];
  state.quotaAllowed = true;
  state.quotaConsumptions = [];
  state.refunds = [];
  state.appConfig = { practice_duration_min: 15 };
  state.inserts = [];
  state.updates = [];
  state.questions = [];
  state.timeLimits = {};
  state.failNextInsert = false;
  state.rpcErrors = {};
  state.historyRpcErrors = {};
});

test('retake previews unavailable questions before consuming quota or creating an attempt', async () => {
  state.history = [{ id: 'history-1', user_id: 'user-1' }];
  state.historySets['history-1'] = [
    { pos: 1, question_id: q('1'), available: true },
    { pos: 2, question_id: q('2'), available: false },
  ];

  const result = await ExamPracticeService.startRetake('user-1', 'history-1');

  assert.equal(result.started, false);
  assert.equal(result.reason, 'confirm_partial');
  assert.equal(result.available_count, 1);
  assert.equal(result.unavailable_count, 1);
  assert.equal(state.attempts.length, 0);
  assert.equal(state.quotaConsumptions.length, 0);
});

test('confirmed retake starts a practice attempt with only the available questions in original order', async () => {
  state.history = [{ id: 'history-1', user_id: 'user-1' }];
  state.historySets['history-1'] = [
    { pos: 1, question_id: q('1'), available: true },
    { pos: 2, question_id: q('2'), available: false },
    { pos: 3, question_id: q('3'), available: true },
  ];

  const result = await ExamPracticeService.startRetake('user-1', 'history-1', true);

  assert.equal(result.started, true);
  assert.equal(result.attempt.question_ids.length, 2);
  assert.deepEqual(result.attempt.question_ids, [q('1'), q('3')]);
  assert.equal(result.attempt.practice_mode, PRACTICE_MODES.RETAKE);
  assert.equal(result.attempt.source_history_id, 'history-1');

  const inserted = state.inserts[0];
  assert.equal(inserted.kind, 'practice');
  assert.equal(inserted.exam_id, null);
  assert.equal(inserted.practice_mode, 'retake');
  assert.equal(inserted.source_history_id, 'history-1');
  assert.equal(inserted.status, 'in_progress');
  assert.equal(state.quotaConsumptions.length, 1);
  assert.equal(state.quotaConsumptions[0].p_feature, 'exam_start');
  assert.equal(state.quotaConsumptions[0].p_reference_id, inserted.id);
});

test('retake with no available questions returns an empty result and creates nothing', async () => {
  state.history = [{ id: 'history-1', user_id: 'user-1' }];
  state.historySets['history-1'] = [
    { pos: 1, question_id: q('1'), available: false },
  ];

  const result = await ExamPracticeService.startRetake('user-1', 'history-1', true);

  assert.equal(result.started, false);
  assert.equal(result.reason, 'empty');
  assert.equal(result.available_count, 0);
  assert.equal(state.attempts.length, 0);
  assert.equal(state.quotaConsumptions.length, 0);
});

test('wrong-from-history starts with only wrong questions that are still practiceable', async () => {
  state.history = [{ id: 'history-1', user_id: 'user-1' }];
  state.wrongSets['history-1'] = [
    { question_id: q('1'), available: true },
    { question_id: q('2'), available: false },
  ];

  const result = await ExamPracticeService.startWrongFromHistory('user-1', 'history-1');

  assert.equal(result.started, true);
  assert.equal(result.available_count, 1);
  assert.equal(result.unavailable_count, 1);
  assert.deepEqual(result.attempt.question_ids, [q('1')]);
  assert.equal(result.attempt.practice_mode, 'wrong_from_history');
  assert.equal(result.attempt.source_history_id, 'history-1');
  assert.equal(state.quotaConsumptions[0].p_feature, 'exam_start');
});

test('wrong-from-history with a perfect score returns an empty result', async () => {
  state.history = [{ id: 'history-1', user_id: 'user-1' }];
  state.wrongSets['history-1'] = [];

  const result = await ExamPracticeService.startWrongFromHistory('user-1', 'history-1');

  assert.equal(result.started, false);
  assert.equal(result.reason, 'empty');
  assert.equal(state.attempts.length, 0);
});

test('global mistake practice previews a reduced set instead of silently shrinking it', async () => {
  state.poolCount = 4;

  const result = await ExamPracticeService.startMistakePractice('user-1', 10);

  assert.equal(result.started, false);
  assert.equal(result.reason, 'confirm_reduced');
  assert.equal(result.requested_count, 10);
  assert.equal(result.available_count, 4);
  assert.equal(state.quotaConsumptions.length, 0);
});

test('confirmed global mistake practice uses the available pool and the mistake quota', async () => {
  state.poolCount = 4;
  state.picked = [q('1'), q('2'), q('3'), q('4')];

  const result = await ExamPracticeService.startMistakePractice('user-1', 10, true);

  assert.equal(result.started, true);
  assert.equal(result.attempt.question_ids.length, 4);
  assert.equal(result.attempt.practice_mode, 'wrong_global');
  assert.equal(result.attempt.source_history_id, null);
  assert.equal(state.quotaConsumptions[0].p_feature, 'mistake_practice');
});

test('global mistake practice with an empty pool returns an empty result', async () => {
  state.poolCount = 0;

  const result = await ExamPracticeService.startMistakePractice('user-1', 5);

  assert.equal(result.started, false);
  assert.equal(result.reason, 'empty');
  assert.equal(state.attempts.length, 0);
});

test('global mistake practice rejects invalid counts before touching the quota', async () => {
  for (const count of [0, 101, 2.5, Number.NaN]) {
    await assert.rejects(
      ExamPracticeService.startMistakePractice('user-1', count),
      (error: any) => error.status === 400
    );
  }

  assert.equal(state.quotaConsumptions.length, 0);
});

test('a foreign or missing history id is reported as not found without consuming quota', async () => {
  state.rpcErrors['get_history_question_set'] = {
    code: 'P0002',
    message: 'history_not_found',
  };

  await assert.rejects(
    ExamPracticeService.startRetake('user-1', 'someone-elses-history', true),
    (error: any) => error.status === 404
  );

  assert.equal(state.quotaConsumptions.length, 0);
  assert.equal(state.attempts.length, 0);
});

test('premium-only source content is refused before creating an attempt', async () => {
  state.rpcErrors['get_history_question_set'] = {
    code: 'P0403',
    message: 'premium_required',
  };

  await assert.rejects(
    ExamPracticeService.startRetake('user-1', 'premium-history', true),
    (error: any) =>
      error.status === 403 &&
      error.code === 'PREMIUM_REQUIRED'
  );

  assert.equal(state.quotaConsumptions.length, 0);
  assert.equal(state.attempts.length, 0);
});

test('an in-progress retake is resumed instead of creating a second attempt', async () => {
  const existing = seedAttempt({
    id: 'practice-existing',
    practice_mode: 'retake',
    source_history_id: 'history-1',
  });
  state.history = [{ id: 'history-1', user_id: 'user-1' }];
  state.historySets['history-1'] = [
    { pos: 1, question_id: q('1'), available: true },
  ];

  const result = await ExamPracticeService.startRetake('user-1', 'history-1', true);

  assert.equal(result.started, true);
  assert.equal(result.resumed, true);
  assert.equal(result.attempt.id, existing.id);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.inserts.length, 0);
  assert.equal(state.quotaConsumptions[0].p_reference_id, existing.id);
});

test('concurrent duplicate retake clicks share a single attempt', async () => {
  state.history = [{ id: 'history-1', user_id: 'user-1' }];
  state.historySets['history-1'] = [
    { pos: 1, question_id: q('1'), available: true },
  ];

  const [first, second] = await Promise.all([
    ExamPracticeService.startRetake('user-1', 'history-1', true),
    ExamPracticeService.startRetake('user-1', 'history-1', true),
  ]);

  assert.equal(first.attempt.id, second.attempt.id);
  assert.equal(state.inserts.length, 1);
});

test('the mistake pool exposes the unique available question count', async () => {
  state.poolCount = 23;

  assert.deepEqual(await ExamPracticeService.getMistakePool('user-1'), {
    available_count: 23,
  });
});

test('history summaries take the practice count from the shared mistake definition', async () => {
  state.history = [
    {
      id: 'history-1',
      user_id: 'user-1',
      exam_id: null,
      score: 3,
      total_marks: 5,
      correct_count: 2,
      wrong_count: 2,
      skipped_count: 1,
      status: 'completed',
      practice_mode: null,
      source_history_id: null,
      created_at: '2026-10-02T00:00:00.000Z',
      details_json: { details: [], questions: [], answers: {} },
    },
  ];
  // Wrong OR skipped, minus dismissals: two wrong and one skipped response,
  // one of them dismissed -> 2.
  state.mistakeCounts = [{ exam_history_id: 'history-1', mistake_count: 2 }];

  const rows = await getUserExamHistory('user-1');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].retake_available_count, 5);
  assert.equal(rows[0].wrong_available_count, 2);
  assert.equal('details_json' in rows[0], false);
});

test('history summaries treat missing counters as zero instead of calling availability RPCs', async () => {
  state.history = [{ id: 'history-1', user_id: 'user-1' }];

  const rows = await getUserExamHistory('user-1');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].retake_available_count, 0);
  assert.equal(rows[0].wrong_available_count, 0);
});

test('retake uses the historical time limit instead of a fixed practice duration', async () => {
  state.history = [{ id: 'history-1', user_id: 'user-1' }];
  state.historySets['history-1'] = [
    { pos: 1, question_id: q('1'), available: true },
    { pos: 2, question_id: q('2'), available: true },
  ];
  state.timeLimits['history-1'] = 90 * 60;

  const result = await ExamPracticeService.startRetake('user-1', 'history-1', true);
  const inserted = state.inserts[0];
  const durationMs = Date.parse(inserted.deadline_at) - Date.parse(inserted.started_at);

  assert.equal(result.started, true);
  assert.equal(durationMs, 90 * 60_000);
  assert.equal(inserted.time_remaining, 90 * 60);
});

test('retake falls back to the configured default only when the history has no time limit', async () => {
  state.history = [{ id: 'history-1', user_id: 'user-1' }];
  state.historySets['history-1'] = [
    { pos: 1, question_id: q('1'), available: true },
  ];

  await ExamPracticeService.startRetake('user-1', 'history-1', true);

  const inserted = state.inserts[0];
  const durationMs = Date.parse(inserted.deadline_at) - Date.parse(inserted.started_at);

  assert.equal(durationMs, 15 * 60_000);
});

test('wrong+skipped practice starts untimed with no deadline', async () => {
  state.history = [{ id: 'history-1', user_id: 'user-1' }];
  state.wrongSets['history-1'] = [
    { question_id: q('1'), available: true },
    { question_id: q('2'), available: true },
  ];

  const result = await ExamPracticeService.startWrongFromHistory('user-1', 'history-1');
  const inserted = state.inserts[0];

  assert.equal(result.started, true);
  assert.equal(inserted.deadline_at, null);
  assert.equal(inserted.time_remaining, null);
  assert.equal(result.attempt.deadline_at, null);
});

test('global wrong+skipped practice starts untimed with no deadline', async () => {
  state.poolCount = 2;
  state.picked = [q('1'), q('2')];

  const result = await ExamPracticeService.startMistakePractice('user-1', 2);
  const inserted = state.inserts[0];

  assert.equal(result.started, true);
  assert.equal(inserted.deadline_at, null);
  assert.equal(inserted.time_remaining, null);
});

test('answering a quiz question reveals the key and explanation for the owner only', async () => {
  const questionId = q('1');
  const attempt = seedAttempt({
    id: 'quiz-1',
    practice_mode: 'wrong_global',
    deadline_at: null,
    question_ids: [questionId],
  });
  state.questions = [
    {
      id: questionId,
      is_active: true,
      status: 'published',
      deleted_at: null,
      options: [
        { id: 'opt-a', text_bn: 'ক', text_en: 'A', is_correct: false },
        { id: 'opt-b', text_bn: 'খ', text_en: 'B', is_correct: true },
      ],
      explanation: { bn: 'ব্যাখ্যা', en: 'Explanation' },
    },
  ];

  const revealed = await ExamPracticeService.answerPracticeQuestion(
    'user-1',
    attempt.id,
    questionId,
    'opt-b'
  );

  assert.equal(revealed.is_correct, true);
  assert.deepEqual(revealed.correct_option, {
    id: 'opt-b',
    text_bn: 'খ',
    text_en: 'B',
    image_url: null,
  });
  assert.deepEqual(revealed.explanation, { bn: 'ব্যাখ্যা', en: 'Explanation' });
  assert.equal(state.attempts[0].answers_draft[questionId], 'opt-b');
  assert.equal(state.attempts[0].current_question_index, 0);

  await assert.rejects(
    ExamPracticeService.answerPracticeQuestion('user-1', attempt.id, questionId, 'opt-a'),
    (error: any) => error.status === 409
  );
});

test('quiz answering rejects foreign attempts, normal attempts, unknown questions and invalid options', async () => {
  const questionId = q('1');
  const quiz = seedAttempt({
    id: 'quiz-1',
    practice_mode: 'wrong_global',
    deadline_at: null,
    question_ids: [questionId],
  });
  const retake = seedAttempt({
    id: 'retake-1',
    practice_mode: 'retake',
    question_ids: [questionId],
  });
  state.questions = [
    {
      id: questionId,
      is_active: true,
      status: 'published',
      deleted_at: null,
      options: [{ id: 'opt-a', text_bn: 'ক', text_en: 'A', is_correct: true }],
      explanation: null,
    },
  ];

  await assert.rejects(
    ExamPracticeService.answerPracticeQuestion('user-2', quiz.id, questionId, 'opt-a'),
    (error: any) => error.status === 404
  );
  await assert.rejects(
    ExamPracticeService.answerPracticeQuestion('user-1', retake.id, questionId, 'opt-a'),
    (error: any) => error.status === 409
  );
  await assert.rejects(
    ExamPracticeService.answerPracticeQuestion('user-1', quiz.id, q('9'), 'opt-a'),
    (error: any) => error.status === 400
  );
  await assert.rejects(
    ExamPracticeService.answerPracticeQuestion('user-1', quiz.id, questionId, 'opt-z'),
    (error: any) => error.status === 400
  );
});
