import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * Executes the real ExamUserService against an in-process fake Supabase client.
 * This covers the attempt -> submit -> details_json -> result review contract
 * without touching a live database.
 */

type Row = Record<string, any>;

type FakeState = {
  questions: Row[];
  examPapers: Row[];
  examPaperQuestions: Row[];
  attempts: Row[];
  history: Row[];
  insertedHistory: Row[];
  insertedDetails: Row[];
  insertedRows: Record<string, Row[]>;
  tableCalls: string[];
  rpcQuestions: Row[];
  xpAwards: Row[];
};

const state: FakeState = {
  questions: [],
  examPapers: [],
  examPaperQuestions: [],
  attempts: [],
  history: [],
  insertedHistory: [],
  insertedDetails: [],
  insertedRows: {},
  tableCalls: [],
  rpcQuestions: [],
  xpAwards: [],
};

let attemptSeq = 0;

const recordInsert = (table: string, rows: Row[]) => {
  state.insertedRows[table] = state.insertedRows[table] || [];
  state.insertedRows[table].push(...rows);
};

const sameValue = (actual: any, expected: any) => String(actual) === String(expected);

const createBuilder = (table: string) => {
  const filters: Record<string, any> = {};
  const ranges: { column: string; op: 'gt' | 'gte'; value: any }[] = [];
  let inserted: Row[] | null = null;
  let update: Row | null = null;
  let deleted = false;

  const matches = (row: Row) => {
    for (const [column, value] of Object.entries(filters)) {
      if (value === null) {
        if (row[column] !== null && row[column] !== undefined) return false;
        continue;
      }
      if (Array.isArray(value)) {
        if (!value.some((candidate) => sameValue(row[column], candidate))) return false;
        continue;
      }
      if (!sameValue(row[column], value)) return false;
    }

    for (const range of ranges) {
      const actual = Date.parse(String(row[range.column]));
      const boundary = Date.parse(String(range.value));

      if (!Number.isFinite(actual)) return false;
      if (range.op === 'gt' && !(actual > boundary)) return false;
      if (range.op === 'gte' && !(actual >= boundary)) return false;
    }

    return true;
  };

  const resolveQuery = (mode: 'many' | 'single') => {
    state.tableCalls.push(`${table}:${mode}`);

    if (table === 'exam_papers') {
      const paper = state.examPapers.find((item) => matches({ ...item }) && matchesId(item));
      return { data: mode === 'single' ? paper ?? null : paper ? [paper] : [], error: null };
    }

    if (table === 'exam_paper_questions') {
      const rows = state.examPaperQuestions.filter((item) =>
        sameValue(item.exam_id, filters.exam_id)
      );
      return { data: rows, error: null };
    }

    if (table === 'questions') {
      const ids: string[] = Array.isArray(filters.id) ? filters.id.map(String) : [];
      const rows =
        ids.length > 0
          ? state.questions.filter((item) => ids.includes(String(item.id)))
          : state.questions;
      return { data: rows, error: null };
    }

    if (table === 'exam_progress') {
      if (inserted) {
        attemptSeq += 1;
        const row = {
          id: `attempt-${attemptSeq}`,
          answers_draft: {},
          current_question_index: 0,
          submitted_at: null,
          exam_history_id: null,
          ...inserted[0],
        };
        state.attempts.push(row);
        return { data: mode === 'single' ? row : [row], error: null };
      }

      if (update) {
        const rows = state.attempts.filter(matches);
        rows.forEach((row) => Object.assign(row, update));
        return { data: rows, error: null };
      }

      if (deleted) {
        state.attempts = state.attempts.filter((row) => !matches(row));
        return { data: [], error: null };
      }

      const rows = state.attempts.filter(matches);
      return {
        data: mode === 'single' ? rows[0] ?? null : rows,
        error: null,
      };
    }

    if (table === 'exam_history') {
      if (inserted) {
        const candidate = inserted[0];
        const rowId = candidate.id ?? 'history-1';

        // Mirrors the real primary-key constraint: a repeated insert with the
        // same id fails with 23505 instead of creating a second row.
        if (state.history.some((item) => String(item.id) === String(rowId))) {
          return {
            data: null,
            error: {
              code: '23505',
              message: 'duplicate key value violates unique constraint "exam_history_pkey"',
            },
          };
        }

        const row = { id: rowId, created_at: '2026-10-18T12:00:00.000Z', ...candidate };
        state.insertedHistory.push(row);
        state.history.push(row);
        return { data: mode === 'single' ? row : [row], error: null };
      }

      const rows = state.history.filter((item) => matches(item));
      return { data: mode === 'single' ? rows[0] ?? null : rows, error: null };
    }

    if (table === 'exam_history_details') {
      if (inserted) {
        state.insertedDetails = inserted;
        return { data: inserted, error: null };
      }

      return { data: [], error: null };
    }

    if (table === 'app_configs') {
      return { data: mode === 'single' ? { value: { per_correct_answer: 5 } } : [], error: null };
    }

    return { data: mode === 'single' ? null : [], error: null };
  };

  const builder: any = {
    select: () => builder,
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
      ranges.push({ column, op: 'gt', value });
      return builder;
    },
    gte: (column: string, value: any) => {
      ranges.push({ column, op: 'gte', value });
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    insert: (rows: Row[]) => {
      inserted = rows;
      recordInsert(table, rows);
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
    maybeSingle: async () => resolveQuery('single'),
    single: async () => resolveQuery('single'),
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(resolveQuery('many')).then(onFulfilled, onRejected),
  };

  // `exam_papers` lookups only ever filter by id; keep behaviour explicit.
  function matchesId(row: Row) {
    return filters.id === undefined || sameValue(row.id, filters.id);
  }

  return builder;
};

const fakeSupabase = {
  from: (table: string) => createBuilder(table),
  rpc: async (_name: string, args: Row) => {
    state.xpAwards.push({ ...args });
    return { data: state.rpcQuestions, error: null };
  },
};

const require = createRequire(__filename);
const supabaseConfigPath = require.resolve('../../config/supabase');

// Intercept the service's Supabase dependency before it is loaded.
require.cache[supabaseConfigPath] = {
  id: supabaseConfigPath,
  filename: supabaseConfigPath,
  loaded: true,
  exports: { supabase: fakeSupabase },
} as any;

const { ExamUserService } = require('./exams.user.service');

const uuid = (suffix: string) => `8a1f0c2d-0000-4000-8000-00000000000${suffix}`;

const questions: Row[] = [
  {
    id: uuid('1'),
    type: 'MCQ',
    difficulty_level: 'easy',
    body: { text_bn: 'প্রশ্ন এক', text_en: 'Question one', image_url: null },
    options: [
      { id: uuid('a'), text_bn: 'ক', text_en: 'A', isCorrect: false },
      { id: uuid('b'), text_bn: 'খ', text_en: 'B', isCorrect: true },
    ],
    explanation: { bn: 'ব্যাখ্যা এক', en: 'Explanation one' },
  },
  {
    id: uuid('2'),
    type: 'MCQ',
    difficulty_level: 'easy',
    body: { text_bn: 'প্রশ্ন দুই', text_en: 'Question two', image_url: null },
    options: [
      { id: uuid('c'), text_bn: 'গ', text_en: 'C', is_correct: true },
      { id: uuid('d'), text_bn: 'ঘ', text_en: 'D', is_correct: false },
    ],
    explanation: null,
  },
  {
    id: uuid('3'),
    type: 'MCQ',
    difficulty_level: 'easy',
    body: { text_bn: 'প্রশ্ন তিন', text_en: 'Question three', image_url: null },
    options: [
      { id: uuid('e'), text_bn: 'ঙ', text_en: 'E', isCorrect: true },
      { id: uuid('f'), text_bn: 'চ', text_en: 'F', isCorrect: false },
    ],
    explanation: 'গোপন ব্যাখ্যা',
  },
];

const hasCorrectFlag = (options: Row[]) =>
  options.some((option) => 'isCorrect' in option || 'is_correct' in option);

let attemptCount = 0;

const seedAttempt = (overrides: Row = {}) => {
  attemptCount += 1;
  const id = overrides.id ?? `seed-attempt-${attemptCount}`;
  const row = {
    id,
    user_id: 'user-1',
    exam_id: 'exam-1',
    kind: 'exam',
    status: 'in_progress',
    started_at: new Date(Date.now() - 60_000).toISOString(),
    deadline_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    question_ids: [uuid('1'), uuid('2')],
    answers_draft: {},
    current_question_index: 0,
    time_taken: null,
    last_updated_at: new Date().toISOString(),
    submitted_at: null,
    exam_history_id: null,
    ...overrides,
  };

  state.attempts.push(row);
  return row;
};

beforeEach(() => {
  attemptSeq = 0;
  attemptCount = 0;
  state.questions = questions.map((question) => ({ ...question }));
  state.examPapers = [
    {
      id: 'exam-1',
      default_negative_marks: 0.25,
      total_marks: 2,
      result_publish_time: '2020-01-01T00:00:00.000Z',
      is_published: true,
    },
    {
      id: 'exam-2',
      default_negative_marks: 0.25,
      total_marks: 1,
      result_publish_time: '2099-01-01T00:00:00.000Z',
      is_published: true,
    },
    {
      id: 'exam-3',
      default_negative_marks: 0.25,
      total_marks: 1,
      result_publish_time: null,
      is_published: true,
    },
    {
      id: 'exam-unpublished',
      default_negative_marks: 0.25,
      total_marks: 1,
      result_publish_time: '2020-01-01T00:00:00.000Z',
      is_published: false,
    },
    {
      id: 'exam-empty',
      default_negative_marks: 0.25,
      total_marks: 1,
      result_publish_time: '2020-01-01T00:00:00.000Z',
      is_published: true,
    },
  ];
  state.examPaperQuestions = [
    { id: 'eq-1', exam_id: 'exam-1', question_id: uuid('1'), sequence: 1 },
    { id: 'eq-2', exam_id: 'exam-1', question_id: uuid('2'), sequence: 2 },
    { id: 'eq-3', exam_id: 'exam-2', question_id: uuid('1'), sequence: 1 },
    { id: 'eq-4', exam_id: 'exam-3', question_id: uuid('1'), sequence: 1 },
    { id: 'eq-5', exam_id: 'exam-unpublished', question_id: uuid('1'), sequence: 1 },
  ];
  state.attempts = [];
  state.history = [];
  state.insertedHistory = [];
  state.insertedDetails = [];
  state.insertedRows = {};
  state.tableCalls = [];
  state.rpcQuestions = questions.map((question) => ({ ...question }));
  state.xpAwards = [];
});

test('arena question retrieval never exposes correct flags or explanations', async () => {
  const arena = await ExamUserService.getArenaQuestions('user-1', 10);

  assert.equal(arena.length, 3);
  arena.forEach((question: Row) => {
    assert.equal('explanation' in question, false);
    assert.equal(hasCorrectFlag(question.options), false);
  });
});

test('generateExam sanitizes correct flags and explanations', async () => {
  const generated = await ExamUserService.generateExam('user-1', {
    topics: ['topic-1'],
    limit: 10,
  });

  generated.forEach((question: Row) => {
    assert.equal('explanation' in question, false);
    assert.equal(hasCorrectFlag(question.options), false);
  });
});

test('submit stores a reviewable snapshot and grades UUID options correctly', async () => {
  const attempt = seedAttempt();

  const result = await ExamUserService.submitExamResult({
    exam_id: 'exam-1',
    attempt_id: attempt.id,
    user_id: 'user-1',
    answers: {
      [uuid('1')]: uuid('b'),
      [uuid('2')]: uuid('c'),
    },
    question_ids: [uuid('1'), uuid('2')],
    time_taken: 30,
  });

  assert.equal(result.correct_count, 2);
  assert.equal(result.wrong_count, 0);
  assert.equal(result.score, 2);
  assert.equal(result.attempt_id, attempt.id);

  const detailsJson = result.details_json;
  assert.equal(detailsJson.correct_answers_revealed, true);
  assert.equal(detailsJson.questions.length, 2);

  const firstQuestion = detailsJson.questions[0];
  assert.equal(firstQuestion.body.text_bn, 'প্রশ্ন এক');
  assert.equal(firstQuestion.options.length, 2);
  assert.equal(firstQuestion.options[1].isCorrect, true);
  assert.deepEqual(firstQuestion.explanation, { bn: 'ব্যাখ্যা এক', en: 'Explanation one' });

  assert.equal(detailsJson.details[0].selected_option_text, 'খ');
  assert.equal(detailsJson.details[1].is_correct, true);
  assert.equal(state.insertedDetails.length, 2);
  assert.equal(state.insertedDetails[0].selected_option, uuid('b'));
  assert.equal(state.xpAwards.length, 1);
});

test('wrong answers are graded against the option identity, not numeric coercion', async () => {
  const attempt = seedAttempt();

  const result = await ExamUserService.submitExamResult({
    exam_id: 'exam-1',
    attempt_id: attempt.id,
    user_id: 'user-1',
    answers: { [uuid('1')]: uuid('a') },
    question_ids: [uuid('1')],
    time_taken: 10,
  });

  assert.equal(result.correct_count, 0);
  assert.equal(result.wrong_count, 1);
  assert.equal(result.score, 0);
  assert.equal(result.details_json.details[0].is_correct, false);
});

test('result review is owner-scoped and resolves question text for stored attempts', async () => {
  const attempt = seedAttempt({ question_ids: [uuid('1')] });

  const submitResult = await ExamUserService.submitExamResult({
    exam_id: 'exam-1',
    attempt_id: attempt.id,
    user_id: 'user-1',
    answers: { [uuid('1')]: uuid('b') },
    question_ids: [uuid('1')],
    time_taken: 10,
  });

  const ownResult = await ExamUserService.getExamResult('user-1', submitResult.id);
  assert.ok(ownResult);
  assert.equal(ownResult.details_json.questions.length, 1);
  assert.equal(ownResult.details_json.questions[0].body.text_bn, 'প্রশ্ন এক');
  assert.equal(ownResult.details_json.details[0].selected_option_text, 'খ');
  assert.equal(ownResult.details_json.details[0].correct_option_text, 'খ');

  const foreignResult = await ExamUserService.getExamResult('user-2', submitResult.id);
  assert.equal(foreignResult, null);
});

test('answer disclosure stays hidden before a scheduled result publish time', async () => {
  const attempt = seedAttempt({ exam_id: 'exam-2', question_ids: [uuid('1')] });

  const result = await ExamUserService.submitExamResult({
    exam_id: 'exam-2',
    attempt_id: attempt.id,
    user_id: 'user-1',
    answers: { [uuid('1')]: uuid('b') },
    question_ids: [uuid('1')],
    time_taken: 10,
  });

  assert.equal(result.details_json.correct_answers_revealed, false);
  assert.equal(hasCorrectFlag(result.details_json.questions[0].options), false);
  assert.equal(result.details_json.questions[0].explanation, null);
  assert.equal('correct_option_text' in result.details_json.details[0], false);
});

test('a missing publish time fails closed', async () => {
  const attempt = seedAttempt({ exam_id: 'exam-3', question_ids: [uuid('1')] });

  const result = await ExamUserService.submitExamResult({
    exam_id: 'exam-3',
    attempt_id: attempt.id,
    user_id: 'user-1',
    answers: { [uuid('1')]: uuid('b') },
    question_ids: [uuid('1')],
    time_taken: 10,
  });

  assert.equal(result.details_json.correct_answers_revealed, false);
  assert.equal(hasCorrectFlag(result.details_json.questions[0].options), false);
});

test('a tracked practice attempt reveals answers without an exam id', async () => {
  const attempt = seedAttempt({ exam_id: null, kind: 'practice', question_ids: [uuid('1')] });

  const result = await ExamUserService.submitExamResult({
    attempt_id: attempt.id,
    user_id: 'user-1',
    answers: { [uuid('1')]: uuid('b') },
    question_ids: [uuid('1')],
    time_taken: 10,
  });

  assert.equal(result.exam_id, null);
  assert.equal(result.details_json.correct_answers_revealed, true);
  assert.equal(hasCorrectFlag(result.details_json.questions[0].options), true);
  assert.equal(result.details_json.questions[0].explanation.en, 'Explanation one');
  assert.equal(result.details_json.details[0].correct_option_id, uuid('b'));
});

test('submitting question ids without answers does not reveal answer keys', async () => {
  const attempt = seedAttempt({ question_ids: [uuid('1')] });

  const result = await ExamUserService.submitExamResult({
    exam_id: 'exam-1',
    attempt_id: attempt.id,
    user_id: 'user-1',
    question_ids: [uuid('1')],
    time_taken: 10,
  });

  assert.equal(result.correct_count, 0);
  assert.equal(result.wrong_count, 0);
  assert.equal(result.skipped_count, 1);
  assert.equal(result.details_json.details[0].status, 'skipped');
  assert.equal(result.details_json.correct_answers_revealed, false);
  assert.equal(hasCorrectFlag(result.details_json.questions[0].options), false);
  assert.equal(result.details_json.questions[0].explanation, null);
  assert.equal('correct_option_id' in result.details_json.details[0], false);
  assert.equal('correct_option_text' in result.details_json.details[0], false);
});

test('a tracked practice skipped question still reveals its key after submission', async () => {
  const attempt = seedAttempt({ exam_id: null, kind: 'practice', question_ids: [uuid('1')] });

  const result = await ExamUserService.submitExamResult({
    attempt_id: attempt.id,
    user_id: 'user-1',
    question_ids: [uuid('1')],
    time_taken: 10,
  });

  assert.equal(result.details_json.correct_answers_revealed, true);
  assert.equal(hasCorrectFlag(result.details_json.questions[0].options), true);
  assert.equal(result.details_json.details[0].status, 'skipped');
  assert.equal(result.details_json.details[0].correct_option_id, uuid('b'));
});

test('an unknown exam id is rejected and no result is written', async () => {
  const attempt = seedAttempt({ exam_id: 'exam-does-not-exist', question_ids: [uuid('1')] });

  await assert.rejects(
    ExamUserService.submitExamResult({
      exam_id: 'exam-does-not-exist',
      attempt_id: attempt.id,
      user_id: 'user-1',
      answers: { [uuid('1')]: uuid('b') },
      question_ids: [uuid('1')],
      time_taken: 10,
    }),
    /Exam not found/
  );

  assert.equal(state.insertedRows.exam_history, undefined);
});

test('an unpublished exam is rejected and no result is written', async () => {
  const attempt = seedAttempt({ exam_id: 'exam-unpublished', question_ids: [uuid('1')] });

  await assert.rejects(
    ExamUserService.submitExamResult({
      exam_id: 'exam-unpublished',
      attempt_id: attempt.id,
      user_id: 'user-1',
      question_ids: [uuid('1')],
      time_taken: 10,
    }),
    /Exam is not available/
  );

  assert.equal(state.insertedRows.exam_history, undefined);
});

test('questions from another exam are rejected before any write', async () => {
  const attempt = seedAttempt();

  await assert.rejects(
    ExamUserService.submitExamResult({
      exam_id: 'exam-1',
      attempt_id: attempt.id,
      user_id: 'user-1',
      answers: { [uuid('3')]: uuid('e') },
      question_ids: [uuid('3')],
      time_taken: 10,
    }),
    /does not belong to this attempt/
  );

  assert.equal(state.insertedRows.exam_history, undefined);
});

test('an attempt without an authoritative question set fails closed', async () => {
  const attempt = seedAttempt({ exam_id: 'exam-empty', question_ids: [] });

  await assert.rejects(
    ExamUserService.submitExamResult({
      exam_id: 'exam-empty',
      attempt_id: attempt.id,
      user_id: 'user-1',
      question_ids: [uuid('1')],
      time_taken: 10,
    }),
    /Attempt has no question set/
  );

  assert.equal(state.insertedRows.exam_history, undefined);
});

test('submitting an exam without a started attempt is rejected', async () => {
  await assert.rejects(
    ExamUserService.submitExamResult({
      exam_id: 'exam-1',
      user_id: 'user-1',
      question_ids: [uuid('1')],
      time_taken: 10,
    }),
    /must be started before submitting/
  );

  assert.equal(state.insertedRows.exam_history, undefined);
});

test('legacy stored snapshots cannot leak answer keys before results publish', async () => {
  state.history = [
    {
      id: 'legacy-1',
      user_id: 'user-1',
      exam_id: 'exam-2',
      score: 0,
      total_marks: 1,
      correct_count: 0,
      wrong_count: 1,
      skipped_count: 0,
      time_taken: 10,
      created_at: '2026-10-18T12:00:00.000Z',
      details_json: {
        answers: { [uuid('1')]: uuid('a') },
        details: [
          {
            question_id: uuid('1'),
            selected_option: uuid('a'),
            selected_option_text: 'ক',
            is_correct: false,
            marks_awarded: -0.25,
            status: 'wrong',
            correct_option_id: uuid('b'),
            correct_option_text: 'খ',
            debug: { answer: uuid('b') },
          },
        ],
        questions: [
          {
            id: uuid('1'),
            body: { text_bn: 'প্রশ্ন এক', text_en: 'Question one', image_url: null },
            options: [
              { id: uuid('a'), text_bn: 'ক', isCorrect: false },
              { id: uuid('b'), text_bn: 'খ', isCorrect: true },
            ],
            explanation: 'ব্যাখ্যা এক',
            answer_key: uuid('b'),
          },
        ],
        correct_answers_revealed: true,
      },
    },
  ];

  const result = await ExamUserService.getExamResult('user-1', 'legacy-1');
  assert.ok(result);
  assert.equal(result.details_json.correct_answers_revealed, false);
  assert.equal(hasCorrectFlag(result.details_json.questions[0].options), false);
  assert.equal(result.details_json.questions[0].explanation, null);
  assert.equal('answer_key' in result.details_json.questions[0], false);
  assert.equal('correct_option_id' in result.details_json.details[0], false);
  assert.equal('correct_option_text' in result.details_json.details[0], false);
  assert.equal('debug' in result.details_json.details[0], false);
});

test('review uses the exam question order and resolves option text', async () => {
  const attempt = seedAttempt();

  const submitResult = await ExamUserService.submitExamResult({
    exam_id: 'exam-1',
    attempt_id: attempt.id,
    user_id: 'user-1',
    answers: {
      [uuid('2')]: uuid('c'),
      [uuid('1')]: uuid('b'),
    },
    question_ids: [uuid('2'), uuid('1')],
    time_taken: 15,
  });

  assert.deepEqual(
    submitResult.details_json.questions.map((question: Row) => question.id),
    [uuid('1'), uuid('2')]
  );
});

/**
 * The model-test ("Arena") flow is a practice submission: no exam paper and no
 * server-issued attempt. These cases cover that path, which previously had no
 * coverage and is the path production students actually use.
 */

const practicePayload = (overrides: Row = {}) => ({
  session_id: 'practice-session-1',
  user_id: 'user-1',
  answers: { [uuid('1')]: uuid('b') },
  question_ids: [uuid('1')],
  time_taken: 42,
  ...overrides,
});

test('a practice submission persists without referencing attempt_id', async () => {
  const result = await ExamUserService.submitExamResult(practicePayload());

  assert.equal(result.duplicate, false);
  assert.equal(result.attempt_id, null);
  assert.equal(result.correct_count, 1);
  assert.equal(result.wrong_count, 0);
  assert.equal(result.score, 1);

  const inserted = state.insertedRows.exam_history[0];
  assert.ok(inserted, 'one history row is written');

  // A database that has not applied the attempt-lifecycle migration has no
  // attempt_id column; sending an explicit null there fails every submission.
  assert.equal('attempt_id' in inserted, false);
  assert.equal(inserted.time_taken, 42);
  assert.equal(inserted.score, 1);
});

test('an untracked practice submission reveals its answer key on submit and review', async () => {
  const result = await ExamUserService.submitExamResult(
    practicePayload({ question_ids: [uuid('1'), uuid('2')] })
  );

  assert.equal(result.attempt_id, null);
  assert.equal(result.details_json.correct_answers_revealed, true);
  assert.equal(hasCorrectFlag(result.details_json.questions[0].options), true);
  assert.equal(result.details_json.details[0].correct_option_id, uuid('b'));
  assert.equal(result.details_json.details[0].correct_option_text, 'খ');

  const skippedDetail = result.details_json.details.find(
    (detail: Row) => detail.question_id === uuid('2')
  );
  assert.equal(skippedDetail.status, 'skipped');
  assert.equal(skippedDetail.correct_option_id, uuid('c'));

  const review = await ExamUserService.getExamResult('user-1', result.id);
  assert.equal(review.details_json.correct_answers_revealed, true);
  assert.equal(hasCorrectFlag(review.details_json.questions[1].options), true);
  assert.equal(review.details_json.questions[0].explanation.en, 'Explanation one');
});

test('the reported duration is preserved for practice submissions', async () => {
  await ExamUserService.submitExamResult(practicePayload({ time_taken: 123 }));

  assert.equal(state.insertedRows.exam_history[0].time_taken, 123);
});

test('a repeated practice submission with the same key returns the first result', async () => {
  const first = await ExamUserService.submitExamResult(practicePayload());
  const second = await ExamUserService.submitExamResult(practicePayload());

  assert.equal(second.id, first.id);
  assert.equal(second.duplicate, true);
  assert.equal(second.score, first.score);
  assert.equal(second.earned_xp, 0);

  assert.equal(state.insertedHistory.length, 1, 'only one result row exists');
  assert.equal(state.history.length, 1);

  // The repeat response must still be renderable by the result page.
  assert.equal(second.details_json.questions[0].id, uuid('1'));
  assert.equal(second.details_json.details[0].selected_option_text, 'খ');
});

test('different submission keys create separate results', async () => {
  const first = await ExamUserService.submitExamResult(
    practicePayload({ session_id: 'practice-session-a' })
  );
  const second = await ExamUserService.submitExamResult(
    practicePayload({ session_id: 'practice-session-b' })
  );

  assert.notEqual(second.id, first.id);
  assert.equal(state.insertedHistory.length, 2);
});

test('an unusable session id does not break submission', async () => {
  const result = await ExamUserService.submitExamResult(
    practicePayload({ session_id: 'not a valid key: with spaces' })
  );

  assert.equal(result.correct_count, 1);
  assert.equal(state.insertedHistory.length, 1);
});

test('an attempt-bound submission still records the attempt linkage', async () => {
  const attempt = seedAttempt();

  const result = await ExamUserService.submitExamResult({
    exam_id: 'exam-1',
    attempt_id: attempt.id,
    user_id: 'user-1',
    answers: { [uuid('1')]: uuid('b') },
    question_ids: [uuid('1')],
    time_taken: 10,
  });

  assert.equal(result.attempt_id, attempt.id);
  assert.equal(state.insertedRows.exam_history[0].attempt_id, attempt.id);
});

test("another user's attempt cannot be submitted", async () => {
  const attempt = seedAttempt();

  await assert.rejects(
    ExamUserService.submitExamResult({
      exam_id: 'exam-1',
      attempt_id: attempt.id,
      user_id: 'user-2',
      answers: { [uuid('1')]: uuid('b') },
      question_ids: [uuid('1')],
      time_taken: 10,
    }),
    /Attempt not found/
  );

  assert.equal(state.insertedHistory.length, 0);
});

test('a tracked practice result reveals keys and explanations for its own questions', async () => {
  const attempt = seedAttempt({
    exam_id: null,
    kind: 'practice',
    practice_mode: 'wrong_global',
    question_ids: [uuid('1'), uuid('2')],
  });

  const result = await ExamUserService.submitExamResult({
    attempt_id: attempt.id,
    user_id: 'user-1',
    answers: { [uuid('1')]: uuid('b') },
    question_ids: [uuid('1'), uuid('2')],
    time_taken: 10,
  });

  assert.equal(result.details_json.correct_answers_revealed, true);
  assert.equal(hasCorrectFlag(result.details_json.questions[0].options), true);
  assert.equal(result.details_json.details[0].correct_option_id, uuid('b'));
  assert.equal(result.details_json.details[0].correct_option_text, 'খ');

  const skippedDetail = result.details_json.details.find(
    (detail: Row) => detail.question_id === uuid('2')
  );
  assert.equal(skippedDetail.status, 'skipped');
  assert.equal(skippedDetail.correct_option_id, uuid('c'));

  const review = await ExamUserService.getExamResult('user-1', result.id);
  assert.equal(review.details_json.correct_answers_revealed, true);
  assert.equal(hasCorrectFlag(review.details_json.questions[1].options), true);
  assert.equal(review.details_json.questions[0].explanation.en, 'Explanation one');

  const foreign = await ExamUserService.getExamResult('user-2', result.id);
  assert.equal(foreign, null);
});
