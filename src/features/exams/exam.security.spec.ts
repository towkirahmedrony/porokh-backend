import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * Regression coverage for:
 *   H-02 duplicate submission / repeated XP awarding
 *   H-03 client-trusted legacy /history writes
 *   H-04 unauthorized exam-paper creation and publication
 */

type Row = Record<string, any>;

const state = {
  questions: [] as Row[],
  examPapers: [] as Row[],
  examPaperQuestions: [] as Row[],
  attempts: [] as Row[],
  history: [] as Row[],
  profiles: [] as Row[],
  groupBattles: [] as Row[],
  insertedRows: {} as Record<string, Row[]>,
  xpAwards: [] as Row[],
  insertsRejected: [] as Row[],
  failNextHistoryInsert: false,
  failNextXp: false,
};

let seq = 0;

const same = (a: any, b: any) => String(a) === String(b);

const matches = (row: Row, filters: Record<string, any>, ranges: Row[]) => {
  for (const [column, value] of Object.entries(filters)) {
    if (value === null) {
      if (row[column] !== null && row[column] !== undefined) return false;
      continue;
    }
    if (Array.isArray(value)) {
      if (!value.map(String).includes(String(row[column]))) return false;
      continue;
    }
    if (!same(row[column], value)) return false;
  }

  for (const range of ranges) {
    const actual = Date.parse(String(row[range.column]));
    const boundary = Date.parse(String(range.value));

    if (!Number.isFinite(actual) || !(actual > boundary)) return false;
  }

  return true;
};

const tableRows = (table: string): Row[] => {
  if (table === 'exam_papers') return state.examPapers;
  if (table === 'exam_paper_questions') return state.examPaperQuestions;
  if (table === 'questions') return state.questions;
  if (table === 'exam_progress') return state.attempts;
  if (table === 'exam_history') return state.history;
  if (table === 'profiles') return state.profiles;
  if (table === 'group_battles') return state.groupBattles;
  return [];
};

const createBuilder = (table: string) => {
  const filters: Record<string, any> = {};
  const ranges: Row[] = [];
  let inserted: Row[] | null = null;
  let update: Row | null = null;
  let countMode = false;
  let headMode = false;

  const resolve = (mode: 'many' | 'single') => {
    if (table === 'app_configs') {
      return {
        data: mode === 'single' ? { value: { per_correct_answer: 5 } } : [],
        error: null,
      };
    }

    if (inserted) {
      if (table === 'exam_history' && state.failNextHistoryInsert) {
        state.failNextHistoryInsert = false;
        return { data: null, error: { message: 'simulated history insert failure' } };
      }

      const rows = inserted.map((row) => {
        seq += 1;

        if (table === 'exam_history') {
          if (row.attempt_id && state.history.some((item) => item.attempt_id === row.attempt_id)) {
            const duplicate = { message: 'duplicate attempt_id', code: '23505' };
            state.insertsRejected.push(row);
            return { error: duplicate };
          }

          const stored = {
            id: row.id ?? `history-${seq}`,
            created_at: new Date().toISOString(),
            ...row,
          };
          state.history.push(stored);
          state.insertedRows.exam_history = state.insertedRows.exam_history || [];
          state.insertedRows.exam_history.push(stored);
          return { row: stored };
        }

        const stored = { id: `${table}-${seq}`, ...row };
        tableRows(table).push(stored);
        state.insertedRows[table] = state.insertedRows[table] || [];
        state.insertedRows[table].push(stored);
        return { row: stored };
      });

      const error = rows.find((entry) => entry.error)?.error ?? null;

      if (error) return { data: null, error };

      const stored = rows.map((entry) => entry.row);

      return { data: mode === 'single' ? stored[0] : stored, error: null };
    }

    if (update) {
      const rows = tableRows(table).filter((row) => matches(row, filters, ranges));
      rows.forEach((row) => Object.assign(row, update));
      return { data: mode === 'single' ? rows[0] ?? null : rows, error: null };
    }

    if (table === 'exam_paper_questions' && headMode) {
      const rows = tableRows(table).filter((row) => matches(row, filters, ranges));

      return { data: null, count: rows.length, error: null };
    }

    const rows = tableRows(table).filter((row) => matches(row, filters, ranges));

    if (countMode) return { data: null, count: rows.length, error: null };

    return { data: mode === 'single' ? rows[0] ?? null : rows, error: null };
  };

  const builder: any = {
    select: (_columns?: string, options?: Row) => {
      countMode = Boolean(options?.count);
      headMode = Boolean(options?.head);
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
    gt: (column: string, value: any) => {
      ranges.push({ column, value });
      return builder;
    },
    gte: () => builder,
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
    delete: () => builder,
    maybeSingle: async () => resolve('single'),
    single: async () => resolve('single'),
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(resolve('many')).then(onFulfilled, onRejected),
  };

  return builder;
};

const fakeSupabase = {
  from: (table: string) => createBuilder(table),
  rpc: async (name: string, args: Row) => {
    if (name === 'update_user_progress') {
      if (state.failNextXp) {
        state.failNextXp = false;
        return { data: null, error: { message: 'simulated xp failure' } };
      }

      state.xpAwards.push({ ...args });
    }

    return { data: null, error: null };
  },
};

const require = createRequire(__filename);
const supabaseConfigPath = require.resolve('../../config/supabase');

require.cache[supabaseConfigPath] = {
  id: supabaseConfigPath,
  filename: supabaseConfigPath,
  loaded: true,
  exports: { supabase: fakeSupabase },
} as any;

// Other feature modules pulled in transitively (streak, profile) import these
// clients at load time; provide transport-level fakes so no real client is
// constructed without credentials.
const firebaseStub = { messaging: () => ({ send: async () => 'message-id' }) };
const firebaseConfigPath = require.resolve('../../config/firebaseAdmin');
require.cache[firebaseConfigPath] = {
  id: firebaseConfigPath,
  filename: firebaseConfigPath,
  loaded: true,
  exports: { messaging: firebaseStub.messaging() },
} as any;

for (const modulePath of ['../../config/supabaseAdmin', '../../config/supabaseAuth']) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: { supabaseAdmin: fakeSupabase, supabaseAuth: fakeSupabase, supabase: fakeSupabase },
  } as any;
}

const { ExamUserService } = require('./exams.user.service');
const { ExamAdminService } = require('./exams.admin.service');

const uuid = (suffix: string) => `9b2f0c2d-0000-4000-8000-00000000000${suffix}`;

const questions: Row[] = [
  {
    id: uuid('1'),
    type: 'MCQ',
    difficulty_level: 'easy',
    is_active: true,
    status: 'published',
    deleted_at: null,
    body: { text_bn: 'প্রশ্ন এক', text_en: 'Question one', image_url: null },
    options: [
      { id: uuid('a'), text_bn: 'ক', text_en: 'A', isCorrect: false },
      { id: uuid('b'), text_bn: 'খ', text_en: 'B', isCorrect: true },
    ],
    explanation: 'ব্যাখ্যা',
  },
];

let attemptSeq = 0;

const seedAttempt = (overrides: Row = {}) => {
  attemptSeq += 1;
  const row = {
    id: `attempt-${attemptSeq}`,
    user_id: 'user-1',
    exam_id: 'exam-1',
    kind: 'exam',
    status: 'in_progress',
    started_at: new Date(Date.now() - 30_000).toISOString(),
    deadline_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    question_ids: [uuid('1')],
    answers_draft: {},
    current_question_index: 0,
    last_updated_at: new Date().toISOString(),
    submitted_at: null,
    exam_history_id: null,
    ...overrides,
  };

  state.attempts.push(row);
  return row;
};

beforeEach(() => {
  seq = 0;
  attemptSeq = 0;
  state.questions = questions.map((question) => ({ ...question }));
  state.examPapers = [
    {
      id: 'exam-1',
      title: 'Published exam',
      is_published: true,
      duration_min: 30,
      total_marks: 1,
      pass_mark: 0.5,
      default_negative_marks: 0.25,
      result_publish_time: '2020-01-01T00:00:00.000Z',
    },
    {
      id: 'exam-future',
      title: 'Results not yet published',
      is_published: true,
      duration_min: 30,
      total_marks: 1,
      default_negative_marks: 0.25,
      result_publish_time: '2099-01-01T00:00:00.000Z',
    },
    {
      id: 'exam-draft',
      title: 'Draft exam',
      is_published: false,
      duration_min: 30,
      total_marks: 1,
      default_negative_marks: 0.25,
      result_publish_time: null,
    },
    {
      id: 'exam-no-questions',
      title: 'Incomplete exam',
      is_published: false,
      duration_min: 30,
      total_marks: 1,
      default_negative_marks: 0.25,
      result_publish_time: null,
    },
    {
      id: 'exam-no-duration',
      title: 'No duration',
      is_published: false,
      duration_min: null,
      total_marks: 1,
      default_negative_marks: 0.25,
      result_publish_time: null,
    },
  ];
  state.examPaperQuestions = [
    { exam_id: 'exam-1', question_id: uuid('1'), sequence: 1 },
    { exam_id: 'exam-future', question_id: uuid('1'), sequence: 1 },
  ];
  state.attempts = [];
  state.history = [];
  state.profiles = [
    { id: 'user-1', current_group_id: 'group-1', full_name: 'Student' },
    // The opponent must exist: battle creation validates both participants.
    { id: 'user-2', current_group_id: 'group-1', full_name: 'Opponent' },
  ];
  state.groupBattles = [];
  state.insertedRows = {};
  state.xpAwards = [];
  state.insertsRejected = [];
  state.failNextHistoryInsert = false;
  state.failNextXp = false;
});

const submit = async (attemptId: string, overrides: Row = {}) =>
  ExamUserService.submitExamResult({
    exam_id: 'exam-1',
    attempt_id: attemptId,
    user_id: 'user-1',
    answers: { [uuid('1')]: uuid('b') },
    question_ids: [uuid('1')],
    ...overrides,
  });

test('B4: an untracked submission with more than 100 question ids is rejected', async () => {
  const questionIds = Array.from({ length: 101 }, (_, index) => uuid(String(index + 200)));

  await assert.rejects(
    ExamUserService.submitExamResult({
      user_id: 'user-1',
      answers: {},
      question_ids: questionIds,
    }),
    (error: any) => error.status === 400 && /at most 100/.test(error.message)
  );

  assert.equal(state.history.length, 0);
});

test('B4: an untracked submission cannot grade exam-paper questions', async () => {
  await assert.rejects(
    ExamUserService.submitExamResult({
      user_id: 'user-1',
      answers: { [uuid('1')]: uuid('a') },
      question_ids: [uuid('1')],
    }),
    (error: any) => error.status === 403
  );

  // No result and therefore no answer-key disclosure for the blocked question.
  assert.equal(state.history.length, 0);
});

test('B5: a practice attempt never earns XP', async () => {
  state.attempts.push({
    id: 'practice-1',
    user_id: 'user-1',
    exam_id: null,
    kind: 'practice',
    status: 'in_progress',
    started_at: new Date(Date.now() - 60_000).toISOString(),
    deadline_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    question_ids: [uuid('1')],
    answers_draft: {},
    current_question_index: 0,
    submitted_at: null,
    exam_history_id: null,
  });

  const result = await ExamUserService.submitExamResult({
    attempt_id: 'practice-1',
    user_id: 'user-1',
    answers: { [uuid('1')]: uuid('b') },
    question_ids: [uuid('1')],
  });

  assert.equal(result.earned_xp, 0);
  assert.equal(state.xpAwards.length, 0);
});

test('practice submissions store the practice mode and source without awarding XP', async () => {
  const attempt = seedAttempt({
    exam_id: null,
    kind: 'practice',
    practice_mode: 'retake',
    source_history_id: 'source-history-1',
  });

  const result = await ExamUserService.submitExamResult({
    attempt_id: attempt.id,
    user_id: 'user-1',
    answers: { [uuid('1')]: uuid('b') },
    question_ids: [uuid('1')],
  });

  assert.equal(result.practice_mode, 'retake');
  assert.equal(result.source_history_id, 'source-history-1');
  assert.equal(result.earned_xp, 0);
  assert.equal(state.xpAwards.length, 0);

  const stored = state.history[0];
  assert.equal(stored.practice_mode, 'retake');
  assert.equal(stored.source_history_id, 'source-history-1');
  assert.equal(stored.exam_id, null);
});

test('H-02: a legitimate attempt awards the server-calculated XP exactly once', async () => {
  const attempt = seedAttempt();

  const result = await submit(attempt.id);

  assert.equal(result.correct_count, 1);
  assert.equal(result.earned_xp, 125);
  assert.equal(result.duplicate, false);
  assert.equal(state.xpAwards.length, 1);
  assert.equal(state.xpAwards[0].p_xp, 125);
  assert.equal(state.xpAwards[0].p_user_id, 'user-1');
  assert.equal(state.xpAwards[0].p_coins, 0);
  assert.equal(state.history.length, 1);
});

test('H-02: client-supplied XP and score values are ignored', async () => {
  const attempt = seedAttempt();

  const result = await submit(attempt.id, {
    earned_xp: 999999,
    xp: 999999,
    score: 999,
    total_marks: 999,
    correct_count: 1,
    details_json: { correct_answers_revealed: true },
  });

  assert.equal(result.earned_xp, 125);
  assert.equal(result.score, 1);
  assert.equal(result.total_marks, 1);
  assert.equal(state.xpAwards.length, 1);
  assert.equal(state.xpAwards[0].p_xp, 125);
  assert.equal(state.insertedRows.exam_history[0].score, 1);
});

test('H-02: repeating the same submission awards no additional XP', async () => {
  const attempt = seedAttempt();

  const first = await submit(attempt.id);
  const second = await submit(attempt.id);

  assert.equal(second.duplicate, true);
  assert.equal(second.earned_xp, 0);
  assert.equal(second.id, first.id);
  assert.equal(state.xpAwards.length, 1);
  assert.equal(state.history.length, 1);
});

test('H-02: a retry after a simulated response timeout cannot double-award XP', async () => {
  const attempt = seedAttempt();

  await submit(attempt.id);
  await submit(attempt.id);
  await submit(attempt.id);

  assert.equal(state.history.length, 1);
  assert.equal(state.xpAwards.length, 1);
});

test('H-02: concurrent duplicate submissions award XP once and write one result', async () => {
  const attempt = seedAttempt();

  const settled = await Promise.allSettled([
    submit(attempt.id),
    submit(attempt.id),
    submit(attempt.id),
  ]);

  const fulfilled = settled
    .filter((entry): entry is PromiseFulfilledResult<Row> => entry.status === 'fulfilled')
    .map((entry) => entry.value);

  // A single request wins; losers may either receive a duplicate response or a
  // consistent "already submitted" conflict. None of them may write a reward.
  assert.ok(fulfilled.length >= 1);
  assert.equal(fulfilled.filter((result) => result.duplicate === false).length, 1);
  assert.equal(state.history.length, 1);
  assert.equal(state.xpAwards.length, 1);
});

test('H-02: a finalized attempt can never be rewarded a second time', async () => {
  const attempt = seedAttempt();

  await submit(attempt.id);
  assert.equal(state.attempts[0].status, 'finalized');
  assert.equal(state.attempts[0].awarded_xp, 125);

  const repeat = await submit(attempt.id);

  assert.equal(repeat.duplicate, true);
  assert.equal(state.xpAwards.length, 1);
});

test('H-02: a failed result write awards no XP and leaves the attempt retryable', async () => {
  const attempt = seedAttempt();
  state.failNextHistoryInsert = true;

  await assert.rejects(submit(attempt.id), /simulated history insert failure/);

  assert.equal(state.xpAwards.length, 0);
  assert.equal(state.history.length, 0);
  assert.equal(state.attempts[0].status, 'in_progress');
  assert.equal(state.attempts[0].exam_history_id, null);

  const retry = await submit(attempt.id);

  assert.equal(retry.duplicate, false);
  assert.equal(retry.earned_xp, 125);
  assert.equal(state.history.length, 1);
  assert.equal(state.xpAwards.length, 1);
  assert.equal(state.attempts[0].awarded_xp, 125);
});

test('H-02: an XP write failure is reported honestly and never re-awarded', async () => {
  const attempt = seedAttempt();
  state.failNextXp = true;

  const first = await submit(attempt.id);

  assert.equal(first.earned_xp, 0);
  assert.equal(state.xpAwards.length, 0);
  assert.equal(state.history.length, 1);
  assert.equal(state.attempts[0].status, 'finalized');
  assert.equal(state.attempts[0].awarded_xp, 0);

  const retry = await submit(attempt.id);

  assert.equal(retry.duplicate, true);
  assert.equal(retry.earned_xp, 0);
  assert.equal(state.xpAwards.length, 0);
  assert.equal(state.history.length, 1);
});

test('H-02: a legitimate new attempt receives its own reward', async () => {
  const first = seedAttempt();
  await submit(first.id);

  const second = seedAttempt();
  const secondResult = await submit(second.id);

  assert.equal(secondResult.duplicate, false);
  assert.equal(state.xpAwards.length, 2);
  assert.equal(state.history.length, 2);
});

test('H-02: submitting an attempt owned by another user is rejected', async () => {
  const attempt = seedAttempt();

  await assert.rejects(
    submit(attempt.id, { user_id: 'user-2' }),
    /Attempt not found/
  );

  assert.equal(state.xpAwards.length, 0);
  assert.equal(state.history.length, 0);
});

test('H-02: the submit controller always uses the authenticated user id', async () => {
  const { submitExam } = require('./exams.user.controller');
  const original = ExamUserService.submitExamResult;
  const seen: Row[] = [];

  ExamUserService.submitExamResult = async (payload: Row) => {
    seen.push(payload);
    return { duplicate: true };
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const req: any = { body: { user_id: 'victim-user', answers: {} }, user: { id: 'user-1' } };
      const res: any = {
        status: () => res,
        json: () => resolve(),
      };

      submitExam(req, res, (error: any) => (error ? reject(error) : resolve()));
    });
  } finally {
    ExamUserService.submitExamResult = original;
  }

  assert.equal(seen.length, 1);
  assert.equal(seen[0].user_id, 'user-1');
});

test('H-03: the legacy history endpoint refuses client-calculated results', async () => {
  await assert.rejects(
    ExamUserService.submitHistory('user-1', {
      exam_id: 'exam-1',
      score: 100,
      total_marks: 100,
      correct_count: 50,
      wrong_count: 0,
      skipped_count: 0,
      time_taken: 5,
      details_json: {},
    } as any),
    (error: any) => error.status === 410
  );

  assert.equal(state.insertedRows.exam_history, undefined);
  assert.equal(state.history.length, 0);
  assert.equal(state.xpAwards.length, 0);
});

test('H-03: client-supplied correctness flags and details never become the stored result', async () => {
  const attempt = seedAttempt({ exam_id: 'exam-future' });

  const result = await ExamUserService.submitExamResult({
    exam_id: 'exam-future',
    attempt_id: attempt.id,
    user_id: 'user-1',
    answers: { [uuid('1')]: uuid('a') },
    question_ids: [uuid('1')],
    details_json: {
      correct_answers_revealed: true,
      details: [{ question_id: uuid('1'), is_correct: true, marks_awarded: 100 }],
      score: 100,
    },
    score: 100,
    correct_count: 1,
  });

  const stored = state.history[0];

  assert.equal(stored.score, 0);
  assert.equal(stored.correct_count, 0);
  assert.equal(stored.wrong_count, 1);
  assert.equal(stored.details_json.correct_answers_revealed, false);
  assert.equal(stored.details_json.details[0].is_correct, false);
  assert.equal(stored.details_json.details[0].marks_awarded, -0.25);
  assert.equal('isCorrect' in (stored.details_json.questions[0].options[1] ?? {}), false);
  assert.equal(result.details_json.correct_answers_revealed, false);
});

test('H-03: historical result retrieval still works for the owner', async () => {
  state.history = [
    {
      id: 'old-1',
      user_id: 'user-1',
      exam_id: 'exam-1',
      score: 1,
      total_marks: 1,
      correct_count: 1,
      wrong_count: 0,
      skipped_count: 0,
      time_taken: 10,
      created_at: '2026-10-01T00:00:00.000Z',
      details_json: { details: [], questions: [], answers: {} },
    },
  ];

  const result = await ExamUserService.getExamResult('user-1', 'old-1');

  assert.equal(result.id, 'old-1');
  assert.equal(result.score, 1);
});

test('H-04: every user-facing exam route requires authentication', () => {
  const { ExamUserRoutes } = require('./exams.user.routes');
  const stack = ExamUserRoutes.stack || [];

  assert.ok(stack.length > 0);

  for (const layer of stack) {
    const handlers = layer.route ? layer.route.stack : [layer];
    const guarded = handlers.some((handler: any) => handler.name === 'requireAuth');

    assert.equal(guarded, true, `unguarded exam route: ${layer.route?.path ?? layer.name}`);
  }
});

test('H-04: a group battle cannot create an exam paper', async () => {
  // Only the exam reference is honoured; every other field (title, marks,
  // duration, publication status) is ignored.
  await ExamUserService.createGroupBattleExam('user-1', 'user-2', {
    exam_id: 'exam-1',
    id: 'attacker-exam',
    title: 'Pwned exam',
    subject_id: 'subject-1',
    total_marks: 100,
    pass_mark: 0,
    duration_min: 10,
    is_published: true,
  });

  assert.equal(state.insertedRows.exam_papers, undefined);
  assert.equal(state.examPapers.some((paper) => paper.id === 'attacker-exam'), false);
  assert.equal(state.groupBattles.length, 1);
  assert.equal(state.groupBattles[0].exam_id, 'exam-1');
});

test('H-04: a group battle cannot reference an unpublished exam', async () => {
  await assert.rejects(
    ExamUserService.createGroupBattleExam('user-1', 'user-2', { exam_id: 'exam-draft' }),
    /Exam is not available/
  );

  assert.equal(state.groupBattles.length, 0);
  assert.equal(state.insertedRows.exam_papers, undefined);
});

test('H-04: battle ownership comes from the authenticated challenger', async () => {
  await ExamUserService.createGroupBattleExam('user-1', 'user-2', { exam_id: 'exam-1' });

  assert.equal(state.groupBattles[0].initiated_by, 'user-1');
  assert.equal(state.groupBattles[0].group_id, 'group-1');
  assert.equal(state.groupBattles[0].status, 'pending');
});

test('H-04: publishing an exam without questions is rejected', async () => {
  await assert.rejects(
    ExamAdminService.togglePublish('exam-no-questions'),
    /without questions/
  );

  const paper = state.examPapers.find((item) => item.id === 'exam-no-questions');
  assert.equal(paper?.is_published, false);
});

test('H-04: publishing an exam without an authoritative duration is rejected', async () => {
  await assert.rejects(
    ExamAdminService.togglePublish('exam-no-duration'),
    /valid duration/
  );

  const paper = state.examPapers.find((item) => item.id === 'exam-no-duration');
  assert.equal(paper?.is_published, false);
});

test('H-04: an administrator can publish a complete exam', async () => {
  state.examPapers.push({
    id: 'exam-ready',
    title: 'Ready',
    is_published: false,
    duration_min: 45,
    total_marks: 100,
    default_negative_marks: 0.25,
    result_publish_time: null,
  });
  state.examPaperQuestions.push({ exam_id: 'exam-ready', question_id: uuid('1'), sequence: 1 });

  const updated = await ExamAdminService.togglePublish('exam-ready');

  assert.equal(updated.is_published, true);
});
