import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * Regression coverage for H-01: authoritative server-side exam timing and
 * attempt lifecycle enforcement. Runs the real ExamAttemptService against an
 * in-process fake Supabase client.
 */

type Row = Record<string, any>;

const state: {
  examPapers: Row[];
  examPaperQuestions: Row[];
  questions: Row[];
  attempts: Row[];
  examHistory: Row[];
  progress: Row[];
  updates: Row[];
} = {
  examPapers: [],
  examPaperQuestions: [],
  questions: [],
  attempts: [],
  examHistory: [],
  progress: [],
  updates: [],
};

let seq = 0;

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
    if (String(row[column]) !== String(value)) return false;
  }

  for (const range of ranges) {
    const actual = Date.parse(String(row[range.column]));
    const boundary = Date.parse(String(range.value));

    if (!Number.isFinite(actual)) return false;
    if (!(actual > boundary)) return false;
  }

  return true;
};

const createBuilder = (table: string) => {
  const filters: Record<string, any> = {};
  const ranges: Row[] = [];
  let inserted: Row[] | null = null;
  let update: Row | null = null;

  const resolve = (mode: 'many' | 'single') => {
    if (table === 'exam_papers') {
      const row = state.examPapers.find((item) => matches(item, filters, ranges));
      return { data: mode === 'single' ? row ?? null : row ? [row] : [], error: null };
    }

    if (table === 'exam_paper_questions') {
      return {
        data: state.examPaperQuestions.filter((item) => matches(item, filters, ranges)),
        error: null,
      };
    }

    if (table === 'questions') {
      return {
        data: state.questions.filter((item) => matches(item, filters, ranges)),
        error: null,
      };
    }

    if (table === 'exam_progress') {
      if (inserted) {
        const candidate = inserted[0];

        // Mirrors the live BEFORE INSERT trigger: a second kind='exam' attempt
        // for a (user, exam) pair that already has a result is rejected with
        // SQLSTATE P0409.
        if (
          candidate?.kind === 'exam' &&
          candidate?.exam_id &&
          state.examHistory.some(
            (history) =>
              String(history.user_id) === String(candidate.user_id) &&
              String(history.exam_id) === String(candidate.exam_id)
          )
        ) {
          return {
            data: null,
            error: { code: 'P0409', message: 'already_attempted' },
          };
        }

        seq += 1;
        const row = {
          id: `attempt-${seq}`,
          answers_draft: {},
          current_question_index: 0,
          submitted_at: null,
          exam_history_id: null,
          last_updated_at: new Date().toISOString(),
          ...inserted[0],
        };
        state.attempts.push(row);
        return { data: mode === 'single' ? row : [row], error: null };
      }

      if (update) {
        const rows = state.attempts.filter((item) => matches(item, filters, ranges));
        state.updates.push({ ...update, matched: rows.length });
        rows.forEach((row) => Object.assign(row, update));
        return { data: rows, error: null };
      }

      const rows = state.attempts.filter((item) => matches(item, filters, ranges));
      return { data: mode === 'single' ? rows[0] ?? null : rows, error: null };
    }

    if (table === 'exam_history') {
      if (inserted) {
        const row = { id: `history-${state.examHistory.length + 1}`, ...inserted[0] };
        state.examHistory.push(row);
        return { data: mode === 'single' ? row : [row], error: null };
      }

      const rows = state.examHistory.filter((item) => matches(item, filters, ranges));
      return { data: mode === 'single' ? rows[0] ?? null : rows, error: null };
    }

    if (table === 'app_configs') {
      return { data: mode === 'single' ? { value: { practice_duration_min: 20 } } : [], error: null };
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
      ranges.push({ column, value });
      return builder;
    },
    gte: () => builder,
    order: () => builder,
    limit: () => builder,
    insert: (rows: Row[]) => {
      inserted = rows;
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

const rpcCalls: string[] = [];

const fakeSupabase = {
  from: (table: string) => createBuilder(table),
  rpc: async (name: string, _args: any) => {
    rpcCalls.push(name);
    if (name === 'consume_quota') {
      return { data: { allowed: true, limit: 3, used: 1, remaining: 2, reset_at: new Date().toISOString() }, error: null };
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

const { ExamAttemptService, ExamAttemptError } = require('./exam.attempt.service');
const { ATTEMPT_STATUS, isAttemptExpired, resolveAttemptDeadline } = require('./exam.timing');

const MINUTE = 60_000;

const baseExam = (overrides: Row = {}) => ({
  id: 'exam-1',
  is_published: true,
  duration_min: 30,
  start_time: null,
  end_time: null,
  default_negative_marks: 0.25,
  total_marks: 2,
  result_publish_time: null,
  ...overrides,
});

beforeEach(() => {
  seq = 0;
  rpcCalls.length = 0;
  state.examPapers = [baseExam()];
  state.examPaperQuestions = [
    { exam_id: 'exam-1', question_id: 'q-1', sequence: 1 },
    { exam_id: 'exam-1', question_id: 'q-2', sequence: 2 },
  ];
  state.questions = [
    { id: 'q-1', is_active: true, status: 'published', deleted_at: null },
    { id: 'q-2', is_active: true, status: 'published', deleted_at: null },
  ];
  state.attempts = [];
  state.examHistory = [];
  state.updates = [];
});

test('the server derives the authoritative deadline from exam configuration', async () => {
  const attempt = await ExamAttemptService.startExamAttempt('user-1', 'exam-1');

  assert.equal(attempt.status, ATTEMPT_STATUS.IN_PROGRESS);
  assert.deepEqual(attempt.question_ids, ['q-1', 'q-2']);

  const startedAt = Date.parse(attempt.started_at);
  const deadlineAt = Date.parse(attempt.deadline_at);

  assert.equal(deadlineAt - startedAt, 30 * MINUTE);
  assert.ok(attempt.seconds_remaining > 29 * 60);
});

test('a client-supplied deadline or start time is never used', () => {
  const clientDeadline = Date.now() + 10 * 60 * MINUTE;
  const exam = { duration_min: 30, end_time: null, started_at: clientDeadline, deadline_at: clientDeadline };

  const deadline = resolveAttemptDeadline(exam as any, Date.parse('2026-10-19T10:00:00.000Z'));

  assert.equal(deadline, Date.parse('2026-10-19T10:30:00.000Z'));
});

test('the exam window end caps the attempt deadline', () => {
  const startedAt = Date.parse('2026-10-19T10:00:00.000Z');
  const windowEnd = new Date(startedAt + 10 * MINUTE).toISOString();

  const deadline = resolveAttemptDeadline(
    { duration_min: 120, end_time: windowEnd },
    startedAt
  );

  assert.equal(deadline, startedAt + 10 * MINUTE);
});

test('repeated start requests resume the same attempt without resetting the deadline', async () => {
  const first = await ExamAttemptService.startExamAttempt('user-1', 'exam-1');
  const second = await ExamAttemptService.startExamAttempt('user-1', 'exam-1');

  assert.equal(second.id, first.id);
  assert.equal(second.started_at, first.started_at);
  assert.equal(second.deadline_at, first.deadline_at);
  assert.equal(state.attempts.length, 1);
});

test('saving draft answers repeatedly never extends the deadline', async () => {
  const attempt = await ExamAttemptService.startExamAttempt('user-1', 'exam-1');

  await ExamAttemptService.saveDraftAnswers('user-1', attempt.id, { 'q-1': 'opt-a' }, 1);
  const updated = await ExamAttemptService.saveDraftAnswers(
    'user-1',
    attempt.id,
    { 'q-1': 'opt-b' },
    0
  );

  assert.equal(updated.deadline_at, attempt.deadline_at);
  assert.equal(updated.started_at, attempt.started_at);
  assert.equal(updated.answers_draft['q-1'], 'opt-b');
});

test('position-only draft saves preserve the latest answers', async () => {
  const attempt = await ExamAttemptService.startExamAttempt('user-1', 'exam-1');

  await ExamAttemptService.saveDraftAnswers('user-1', attempt.id, { 'q-1': 'opt-a' }, 1);
  const moved = await ExamAttemptService.saveDraftAnswers(
    'user-1',
    attempt.id,
    undefined,
    1
  );

  assert.equal(moved.answers_draft['q-1'], 'opt-a');
  assert.equal(moved.current_question_index, 1);
});

test('answers cannot be saved once the authoritative deadline has passed', async () => {
  const attempt = await ExamAttemptService.startExamAttempt('user-1', 'exam-1');

  state.attempts[0].deadline_at = new Date(Date.now() - 1000).toISOString();

  await assert.rejects(
    ExamAttemptService.saveDraftAnswers('user-1', attempt.id, { 'q-1': 'opt-a' }),
    (error: any) => error instanceof ExamAttemptError && error.status === 409
  );

  assert.equal(state.attempts[0].status, ATTEMPT_STATUS.EXPIRED);
  assert.equal(state.attempts[0].answers_draft['q-1'], undefined);
});

test('an expired attempt cannot be claimed for submission and is never graded', async () => {
  const attempt = await ExamAttemptService.startExamAttempt('user-1', 'exam-1');

  // Comfortably beyond the submission grace window, so this is a real expiry.
  state.attempts[0].deadline_at = new Date(Date.now() - 10 * MINUTE).toISOString();

  const claim = await ExamAttemptService.claimAttemptForSubmission(
    'user-1',
    attempt.id,
    'history-x'
  );

  assert.equal(claim.claimed, false);
  assert.equal(state.attempts[0].status, ATTEMPT_STATUS.EXPIRED);
});

test('a finalized attempt cannot be modified or re-claimed', async () => {
  const attempt = await ExamAttemptService.startExamAttempt('user-1', 'exam-1');

  const claim = await ExamAttemptService.claimAttemptForSubmission(
    'user-1',
    attempt.id,
    'history-1'
  );
  assert.equal(claim.claimed, true);

  await ExamAttemptService.finalizeAttempt(attempt.id, 'history-1', 25);
  assert.equal(state.attempts[0].status, ATTEMPT_STATUS.FINALIZED);

  await assert.rejects(
    ExamAttemptService.saveDraftAnswers('user-1', attempt.id, { 'q-1': 'x' }),
    (error: any) => error instanceof ExamAttemptError && error.status === 409
  );

  const secondClaim = await ExamAttemptService.claimAttemptForSubmission(
    'user-1',
    attempt.id,
    'history-2'
  );
  assert.equal(secondClaim.claimed, false);
  assert.equal(state.attempts[0].exam_history_id, 'history-1');
});

test('concurrent submissions produce exactly one winner', async () => {
  const attempt = await ExamAttemptService.startExamAttempt('user-1', 'exam-1');

  const [first, second] = await Promise.all([
    ExamAttemptService.claimAttemptForSubmission('user-1', attempt.id, 'history-a'),
    ExamAttemptService.claimAttemptForSubmission('user-1', attempt.id, 'history-b'),
  ]);

  const winners = [first, second].filter((claim) => claim.claimed);

  assert.equal(winners.length, 1);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].status, ATTEMPT_STATUS.SUBMITTED);
});

test('a completed exam cannot be started again and consumes no quota', async () => {
  const first = await ExamAttemptService.startExamAttempt('user-1', 'exam-1');

  await ExamAttemptService.claimAttemptForSubmission('user-1', first.id, 'history-1');
  await ExamAttemptService.finalizeAttempt(first.id, 'history-1', 30);

  // A result now exists for (user-1, exam-1).
  state.examHistory.push({
    id: 'history-1',
    user_id: 'user-1',
    exam_id: 'exam-1',
    status: 'passed',
    score: 10,
    attempt_id: first.id,
  });

  const quotaCallsBefore = rpcCalls.filter((name) => name === 'consume_quota').length;

  await assert.rejects(
    ExamAttemptService.startExamAttempt('user-1', 'exam-1'),
    (error: any) =>
      error instanceof ExamAttemptError &&
      error.status === 409 &&
      error.errorCode === 'ALREADY_ATTEMPTED' &&
      error.details?.exam_history_id === 'history-1'
  );

  // No second attempt row, and no free-start credit was consumed.
  assert.equal(state.attempts.length, 1);
  assert.equal(
    rpcCalls.filter((name) => name === 'consume_quota').length,
    quotaCallsBefore
  );
  assert.equal(state.attempts[0].status, ATTEMPT_STATUS.FINALIZED);
});

test('submission five seconds after the deadline is accepted (grace period)', async () => {
  const attempt = await ExamAttemptService.startExamAttempt('user-1', 'exam-1');

  state.attempts[0].deadline_at = new Date(Date.now() - 5_000).toISOString();

  const claim = await ExamAttemptService.claimAttemptForSubmission(
    'user-1',
    attempt.id,
    'history-late'
  );

  assert.equal(claim.claimed, true);
  assert.equal(state.attempts[0].status, ATTEMPT_STATUS.SUBMITTED);
});

test('submission after the grace period is rejected with a clean 409', async () => {
  const attempt = await ExamAttemptService.startExamAttempt('user-1', 'exam-1');

  state.attempts[0].deadline_at = new Date(Date.now() - 60_000).toISOString();

  const claim = await ExamAttemptService.claimAttemptForSubmission(
    'user-1',
    attempt.id,
    'history-too-late'
  );

  assert.equal(claim.claimed, false);
  assert.equal(state.attempts[0].status, ATTEMPT_STATUS.EXPIRED);
});

test('the deadline is inclusive: the exact deadline is allowed, later is expired', () => {
  const deadline = '2026-10-19T10:30:00.000Z';
  const atDeadline = Date.parse(deadline);

  assert.equal(isAttemptExpired(deadline, atDeadline), false);
  assert.equal(isAttemptExpired(deadline, atDeadline + 1), true);
  assert.equal(isAttemptExpired(deadline, atDeadline - 1), false);
});

test('a missing deadline fails closed', () => {
  assert.equal(isAttemptExpired(null), true);
  assert.equal(isAttemptExpired('not-a-date'), true);
});

test('starting an unpublished exam is rejected', async () => {
  state.examPapers = [baseExam({ is_published: false })];

  await assert.rejects(
    ExamAttemptService.startExamAttempt('user-1', 'exam-1'),
    (error: any) => error instanceof ExamAttemptError && error.status === 403
  );

  assert.equal(state.attempts.length, 0);
});

test('an exam without an authoritative duration cannot start', async () => {
  state.examPapers = [baseExam({ duration_min: null, end_time: null })];

  await assert.rejects(
    ExamAttemptService.startExamAttempt('user-1', 'exam-1'),
    /authoritative duration/
  );

  assert.equal(state.attempts.length, 0);
});

test('an exam outside its published window cannot start', async () => {
  const future = new Date(Date.now() + 60 * MINUTE).toISOString();
  state.examPapers = [baseExam({ start_time: future })];

  await assert.rejects(
    ExamAttemptService.startExamAttempt('user-1', 'exam-1'),
    /has not started/
  );
});

test('attempt questions are never served for an expired attempt', async () => {
  const attempt = await ExamAttemptService.startExamAttempt('user-1', 'exam-1');

  state.attempts[0].deadline_at = new Date(Date.now() - 1000).toISOString();

  const stateAfter = await ExamAttemptService.getAttemptState('user-1', attempt.id);

  assert.equal(stateAfter.status, ATTEMPT_STATUS.EXPIRED);
  assert.equal(stateAfter.seconds_remaining, 0);
});

test('an untimed quiz practice attempt stays resumable, editable and submittable', async () => {
  const now = Date.now();
  state.attempts.push({
    id: 'quiz-attempt',
    user_id: 'user-1',
    exam_id: null,
    kind: 'practice',
    status: ATTEMPT_STATUS.IN_PROGRESS,
    started_at: new Date(now - 60_000).toISOString(),
    deadline_at: null,
    submitted_at: null,
    answers_draft: {},
    current_question_index: 0,
    time_remaining: null,
    last_updated_at: new Date(now).toISOString(),
    exam_history_id: null,
    question_ids: ['q-1'],
    practice_mode: 'wrong_global',
    source_history_id: null,
  });

  const resumed = await ExamAttemptService.getAttemptState('user-1', 'quiz-attempt');
  assert.equal(resumed.status, ATTEMPT_STATUS.IN_PROGRESS);
  assert.equal(resumed.deadline_at, null);
  assert.equal(resumed.seconds_remaining, null);

  const saved = await ExamAttemptService.saveDraftAnswers(
    'user-1',
    'quiz-attempt',
    { 'q-1': 'opt-a' },
    1
  );
  assert.equal(saved.answers_draft['q-1'], 'opt-a');
  assert.equal(saved.current_question_index, 1);

  const claim = await ExamAttemptService.claimAttemptForSubmission(
    'user-1',
    'quiz-attempt',
    'history-quiz'
  );
  assert.equal(claim.claimed, true);
  assert.equal(state.attempts[0].status, ATTEMPT_STATUS.SUBMITTED);
});
