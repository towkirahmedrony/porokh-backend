import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * Admin exam authoring: validation, authorization and the create/update
 * lifecycle. Runs the real controller, service and router against an
 * in-process fake Supabase client (no network, no database).
 */

type Row = Record<string, any>;

const state: {
  examPapers: Row[];
  examPaperQuestions: Row[];
  questions: Row[];
  subjects: Row[];
  userRoles: Row[];
  examProgress: Row[];
  examHistory: Row[];
  ops: string[];
  inserts: { table: string; rows: Row[] }[];
  failOn: { table: string; op: string } | null;
} = {
  examPapers: [],
  examPaperQuestions: [],
  questions: [],
  subjects: [],
  userRoles: [],
  examProgress: [],
  examHistory: [],
  ops: [],
  inserts: [],
  failOn: null,
};

let seq = 0;

/** Database table name -> in-memory collection on `state`. */
const TABLE_KEYS: Record<string, keyof typeof state> = {
  exam_papers: 'examPapers',
  exam_paper_questions: 'examPaperQuestions',
  questions: 'questions',
  subjects: 'subjects',
  user_roles: 'userRoles',
  exam_progress: 'examProgress',
  exam_history: 'examHistory',
};

const createBuilder = (table: string) => {
  const filters: { column: string; value: any; kind: 'eq' | 'in' | 'is' }[] = [];
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  let payload: any = null;
  let rowLimit: number | null = null;
  let wantCount = false;
  let headOnly = false;
  let order: { column: string; ascending: boolean } | null = null;

  const tableRows = (): Row[] => {
    const key = TABLE_KEYS[table];

    if (!key || !Array.isArray((state as any)[key])) {
      throw new Error(`fake supabase has no collection for table "${table}"`);
    }

    return (state as any)[key] as Row[];
  };

  const matches = (row: Row) =>
    filters.every((filter) => {
      if (filter.kind === 'eq') return String(row[filter.column]) === String(filter.value);
      if (filter.kind === 'in') {
        return (filter.value as any[]).map(String).includes(String(row[filter.column]));
      }
      return (row[filter.column] ?? null) === null;
    });

  // One-shot failure injection: the compensation path itself must be able to
  // succeed afterwards, which is exactly what a real transient error allows.
  const fail = () => {
    if (!state.failOn || state.failOn.table !== table || state.failOn.op !== op) return null;

    state.failOn = null;

    return { data: null, error: { message: `forced ${op} failure on ${table}` } };
  };

  const execute = (mode: 'many' | 'single') => {
    state.ops.push(`${table}:${op}`);

    const forced = fail();
    if (forced) return forced;

    if (op === 'insert') {
      const rows = (Array.isArray(payload) ? payload : [payload]).map((row: Row) => ({
        id: row.id ?? `${table}-${++seq}`,
        ...row,
      }));

      // Snapshot the inserted values so later updates cannot rewrite history.
      state.inserts.push({ table, rows: rows.map((row) => ({ ...row })) });
      tableRows().push(...rows);

      return { data: mode === 'single' ? rows[0] ?? null : rows, error: null };
    }

    if (op === 'update') {
      const updated = tableRows()
        .filter(matches)
        .map((row) => Object.assign(row, payload));

      return { data: mode === 'single' ? updated[0] ?? null : updated, error: null };
    }

    if (op === 'delete') {
      const target = tableRows();
      const kept = target.filter((row) => !matches(row));
      const removed = target.length - kept.length;
      target.length = 0;
      target.push(...kept);

      return { data: null, error: null, count: removed };
    }

    let rows = tableRows().filter(matches);

    if (order) {
      const { column, ascending } = order;
      rows = rows.slice().sort((a, b) => {
        const av = String(a[column] ?? '');
        const bv = String(b[column] ?? '');
        return ascending ? (av < bv ? -1 : av > bv ? 1 : 0) : av > bv ? -1 : av < bv ? 1 : 0;
      });
    }

    if (rowLimit !== null) rows = rows.slice(0, rowLimit);

    if (headOnly) return { data: null, error: null, count: rows.length };

    return {
      data: mode === 'single' ? rows[0] ?? null : rows,
      error: null,
      count: wantCount ? rows.length : undefined,
    };
  };

  const builder: any = {
    select: (_columns?: string, options?: { count?: string; head?: boolean }) => {
      wantCount = options?.count === 'exact';
      headOnly = options?.head === true;
      return builder;
    },
    insert: (rows: any) => {
      op = 'insert';
      payload = rows;
      return builder;
    },
    update: (patch: any) => {
      op = 'update';
      payload = patch;
      return builder;
    },
    delete: () => {
      op = 'delete';
      return builder;
    },
    eq: (column: string, value: any) => {
      filters.push({ column, value, kind: 'eq' });
      return builder;
    },
    in: (column: string, value: any[]) => {
      filters.push({ column, value, kind: 'in' });
      return builder;
    },
    is: (column: string, value: any) => {
      filters.push({ column, value, kind: 'is' });
      return builder;
    },
    order: (column: string, options?: { ascending?: boolean }) => {
      order = { column, ascending: options?.ascending !== false };
      return builder;
    },
    limit: (value: number) => {
      rowLimit = value;
      return builder;
    },
    maybeSingle: async () => {
      const result = execute('single');
      return { data: result.data ?? null, error: result.error ?? null };
    },
    single: async () => {
      const result = execute('single');
      return { data: result.data ?? null, error: result.error ?? null };
    },
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(execute('many')).then(onFulfilled, onRejected),
  };

  return builder;
};

const fakeSupabase = {
  from: (table: string) => createBuilder(table),
  rpc: async () => ({ data: null, error: null }),
  auth: {
    getUser: async (token: string) => {
      const user = state.userRoles.find((row) => row.token === token);

      return user
        ? { data: { user: { id: user.user_id } }, error: null }
        : { data: { user: null }, error: { message: 'invalid token' } };
    },
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

const adminController = require('./exams.admin.controller');
const { ExamAdminService } = require('./exams.admin.service');
const { ExamAdminRoutes } = require('./exams.admin.routes');
const { rbacGuard } = require('../../middlewares/rbacGuard');
const authoring = require('./exam.authoring');

const { parseExamCreatePayload, parseExamUpdatePayload, ExamAuthoringError } = authoring;

const createRes = () => {
  const res: any = { statusCode: 0, body: null };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  return res;
};

/**
 * Runs a handler and resolves once it has either responded or forwarded an
 * error. `catchAsync` returns before its inner promise settles, so this waits
 * for the observable outcome instead of a microtask tick.
 */
const invoke = (handler: any, req: Row) =>
  new Promise<any>((resolve) => {
    const res = createRes();
    let settled = false;

    const finish = (error?: any) => {
      if (settled) return;

      settled = true;

      // Mirror the global error handler so a rejected request is observable.
      if (error) {
        res.statusCode = typeof error.status === 'number' ? error.status : 500;
        res.body = { success: false, message: error.message, data: null, code: error.code };
      }

      resolve(res);
    };

    res.json = (body: any) => {
      res.body = body;
      finish();
      return res;
    };

    handler(req, res, (error: any) => finish(error));
  });

const validPayload = (overrides: Row = {}) => ({
  title: 'Model Test 1',
  subject_id: 'subject-1',
  category: 'model_test',
  track: 'hsc',
  duration_min: 30,
  start_time: '2026-11-01T04:00:00.000Z',
  end_time: '2026-11-01T06:00:00.000Z',
  result_publish_time: '2026-11-01T07:00:00.000Z',
  is_premium: false,
  is_published: true,
  question_ids: ['q-1', 'q-2'],
  ...overrides,
});

beforeEach(() => {
  seq = 0;
  state.examPapers = [];
  state.examPaperQuestions = [];
  state.subjects = [
    { id: 'subject-1', name_bn: 'পদার্থ', name_en: 'Physics', is_premium: false, is_active: true, sequence: 1 },
    { id: 'subject-2', name_bn: 'রসায়ন', name_en: 'Chemistry', is_premium: true, is_active: true, sequence: 2 },
    { id: 'subject-3', name_bn: 'পুরাতন', name_en: 'Retired', is_premium: false, is_active: false, sequence: 3 },
  ];
  state.userRoles = [
    { user_id: 'admin-1', role: 'admin', is_active: true, created_at: '2026-01-01', token: 'admin-token' },
    { user_id: 'student-1', role: 'student', is_active: true, created_at: '2026-01-01', token: 'student-token' },
  ];
  state.ops = [];
  state.inserts = [];
  state.failOn = null;
  state.examProgress = [];
  state.examHistory = [];
  state.questions = [
    { id: 'q-1', status: 'published', is_active: true, deleted_at: null, subject_id: 'subject-1', body: { text_bn: 'প্রশ্ন ১' }, difficulty_level: 'easy', type: 'MCQ' },
    { id: 'q-2', status: 'published', is_active: true, deleted_at: null, subject_id: 'subject-1', body: { text_bn: 'প্রশ্ন ২' }, difficulty_level: 'medium', type: 'MCQ' },
    { id: 'q-draft', status: 'pending', is_active: true, deleted_at: null, subject_id: 'subject-1', body: { text_bn: 'খসড়া' }, difficulty_level: 'easy', type: 'MCQ' },
  ];
});

/* ------------------------------------------------------------------ */
/* Authorization                                                       */
/* ------------------------------------------------------------------ */

test('exam authoring routes sit behind authentication and an admin role guard', () => {
  const stack = ExamAdminRoutes.stack ?? [];

  assert.equal(stack[0]?.name, 'requireAuth');
  assert.equal(stack[0]?.handle?.length, 3);

  const second = stack[1];
  assert.ok(!second?.route, 'the role guard must be router-level, not route-level');
  assert.equal(second?.handle?.length, 3);

  const routes = stack
    .filter((layer: any) => layer.route)
    .map((layer: any) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);

  assert.ok(routes.includes('POST /'), 'exam creation route is missing');
  assert.ok(routes.includes('PATCH /:id'), 'exam update route is missing');
  assert.ok(routes.includes('GET /eligible-questions'), 'eligible-question route is missing');

  // Static route must be registered before `/:id` so it is never read as an id.
  const paths = stack.filter((layer: any) => layer.route).map((layer: any) => layer.route.path);
  assert.ok(
    paths.indexOf('/eligible-questions') < paths.indexOf('/:id'),
    'GET /eligible-questions must be registered before GET /:id'
  );
});

test('a student role is rejected by the admin guard before any exam write', async () => {
  const guard = rbacGuard(['admin']);
  const res = createRes();
  let nextCalled = false;

  await guard({ user: { id: 'student-1' } } as any, res as any, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(state.ops.filter((entry) => entry.includes('insert')).length, 0);
});

test('an unauthenticated request never reaches the exam authoring handler', async () => {
  const guard = rbacGuard(['admin']);
  const res = createRes();
  let nextCalled = false;

  await guard({} as any, res as any, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

/* ------------------------------------------------------------------ */
/* Payload validation                                                  */
/* ------------------------------------------------------------------ */

test('invalid time ranges and durations are rejected before any write', async () => {
  const cases: Row[] = [
    { end_time: '2026-11-01T03:00:00.000Z' }, // before start
    { end_time: '2026-11-01T04:00:00.000Z' }, // equal to start
    { duration_min: 0 },
    { duration_min: -5 },
    { duration_min: 30.5 },
    { start_time: 'not-a-date' },
    { result_publish_time: '2026-10-31T04:00:00.000Z' }, // before start
  ];

  for (const overrides of cases) {
    await assert.rejects(
      () => ExamAdminService.createExam(validPayload(overrides), 'admin-1'),
      (error: any) => error.status === 400
    );
  }

  assert.equal(state.ops.length, 0);
});

test('missing required fields and unsupported server-managed fields are rejected', async () => {
  const missing = validPayload();
  delete (missing as Row).question_ids;

  assert.throws(() => parseExamCreatePayload(missing), (error: any) => error.status === 400);

  // `total_marks` and `is_published`-adjacent columns are server-managed: an
  // attempt to send them must fail loudly instead of being silently ignored.
  assert.throws(
    () => parseExamCreatePayload(validPayload({ total_marks: 999 })),
    (error: any) => error.status === 400 && /total_marks/.test(error.message)
  );

  assert.throws(
    () => parseExamCreatePayload(validPayload({ id: 'attacker-chosen-id' })),
    (error: any) => error.status === 400
  );

  assert.throws(
    () => parseExamCreatePayload(validPayload({ category: 'group_battle' })),
    (error: any) => error.status === 400
  );
});

test('model tests require a supported track and other categories reject one', () => {
  const withoutTrack = validPayload();
  delete (withoutTrack as Row).track;

  assert.throws(
    () => parseExamCreatePayload(withoutTrack),
    (error: any) => error.status === 400 && /track is required/.test(error.message)
  );

  assert.throws(
    () => parseExamCreatePayload(validPayload({ track: 'olympiad' })),
    (error: any) => error.status === 400 && /track must be one of/.test(error.message)
  );

  assert.throws(
    () => parseExamCreatePayload(validPayload({ category: 'board_exam' })),
    (error: any) => error.status === 400 && /track must be empty/.test(error.message)
  );

  const board = parseExamCreatePayload(
    validPayload({ category: 'board_exam', track: null })
  );
  assert.equal(board.track, null);

  const admission = parseExamCreatePayload(
    validPayload({
      category: 'admission',
      track: null,
      subject_id: null,
      exam_mode: 'past_exam',
      admission_session: '2025-26',
      admission_unit_id: 'unit-1',
    })
  );
  assert.equal(admission.track, null);
});

test('a null subject is allowed only for model tests', async () => {
  const full = parseExamCreatePayload(
    validPayload({ subject_id: null, category: 'model_test', track: 'hsc' })
  );

  assert.equal(full.subject_id, null);

  assert.throws(
    () => parseExamCreatePayload(validPayload({ subject_id: null, category: 'board_exam', track: null })),
    (error: any) => error.status === 400 && /subject_id is required/.test(error.message)
  );

  assert.throws(
    () =>
      parseExamCreatePayload(
        validPayload({
          subject_id: null,
          category: 'admission',
          track: null,
          exam_mode: 'subject_practice',
          admission_unit_id: 'unit-1',
        })
      ),
    (error: any) => error.status === 400 && /subject_id is required/.test(error.message)
  );

  // A full paper never touches the subject table and is created normally.
  const result = await ExamAdminService.createExam(
    validPayload({ subject_id: null, category: 'model_test', track: 'hsc' }),
    'admin-1'
  );

  assert.equal(result.question_count, 2);
  assert.equal(state.examPapers[0].subject_id, null);
  assert.equal(state.examPapers[0].total_marks, 2);
  assert.ok(!state.ops.includes('subjects:select'), 'full papers do not resolve a subject');
});

test('changing a full model test to board exam without a subject is rejected', async () => {
  await ExamAdminService.createExam(
    validPayload({ subject_id: null, category: 'model_test', track: 'hsc', is_published: false }),
    'admin-1'
  );

  const examId = state.examPapers[0].id;

  await assert.rejects(
    () =>
      ExamAdminService.updateExam(
        examId,
        { category: 'board_exam', track: null, subject_id: null },
        'admin-1'
      ),
    (error: any) => error.status === 400 && /subject_id is required/.test(error.message)
  );

  assert.equal(state.examPapers[0].category, 'model_test');
});

test('duplicate question ids are rejected', () => {
  assert.throws(
    () => parseExamCreatePayload(validPayload({ question_ids: ['q-1', 'q-1'] })),
    (error: any) => error.status === 400 && /duplicate/i.test(error.message)
  );
});

test('update payloads reject protected fields and empty bodies', () => {
  assert.throws(() => parseExamUpdatePayload({}), (error: any) => error.status === 400);
  assert.throws(
    () => parseExamUpdatePayload({ total_marks: 5 }),
    (error: any) => error.status === 400
  );

  const patch = parseExamUpdatePayload({ title: '  Renamed  ', is_premium: true });

  assert.equal(patch.title, 'Renamed');
  assert.equal(patch.is_premium, true);
});

/* ------------------------------------------------------------------ */
/* Question eligibility                                                */
/* ------------------------------------------------------------------ */

test('unknown or ineligible questions are rejected and nothing is created', async () => {
  await assert.rejects(
    () => ExamAdminService.createExam(validPayload({ question_ids: ['q-1', 'does-not-exist'] }), 'admin-1'),
    (error: any) =>
      error.status === 400 &&
      Array.isArray(error.details?.missing_question_ids) &&
      error.details.missing_question_ids.includes('does-not-exist')
  );

  await assert.rejects(
    () => ExamAdminService.createExam(validPayload({ question_ids: ['q-1', 'q-draft'] }), 'admin-1'),
    (error: any) =>
      error.status === 400 && error.details?.ineligible_question_ids.includes('q-draft')
  );

  assert.equal(state.examPapers.length, 0);
  assert.equal(state.examPaperQuestions.length, 0);
});

test('an unknown subject is rejected', async () => {
  await assert.rejects(
    () => ExamAdminService.createExam(validPayload({ subject_id: 'nope' }), 'admin-1'),
    (error: any) => error.status === 400 && /Subject/.test(error.message)
  );

  assert.equal(state.examPapers.length, 0);
});

/* ------------------------------------------------------------------ */
/* Creation                                                            */
/* ------------------------------------------------------------------ */

test('a valid request creates the paper, links questions and publishes last', async () => {
  const result = await ExamAdminService.createExam(validPayload(), 'admin-1');

  assert.equal(state.examPapers.length, 1);
  assert.equal(state.examPaperQuestions.length, 2);
  assert.equal(result.is_published, true);
  assert.equal(result.question_count, 2);

  const paper = state.examPapers[0];

  // Derived server-side from the verified question set, never from the client.
  assert.equal(paper.total_marks, 2);
  assert.equal(paper.is_published, true);
  assert.equal(paper.title, 'Model Test 1');
  assert.equal(paper.track, 'hsc');
  assert.ok(paper.id, 'the server assigns the paper id');

  const insertedPaper = state.inserts.find((entry) => entry.table === 'exam_papers')?.rows[0];
  assert.equal(insertedPaper?.is_published, false, 'the paper must be inserted unpublished');

  // Ordering: paper insert -> question links -> publish flag.
  assert.deepEqual(state.ops, [
    'subjects:select',
    'questions:select',
    'exam_papers:insert',
    'exam_paper_questions:insert',
    'exam_papers:update',
  ]);

  assert.deepEqual(
    state.examPaperQuestions.map((row) => row.sequence),
    [1, 2]
  );
});

test('start and end time are optional for an always-open paper', async () => {
  const payload = validPayload();
  delete (payload as Row).start_time;
  delete (payload as Row).end_time;

  const result = await ExamAdminService.createExam(payload, 'admin-1');

  assert.equal(result.is_published, true);
  assert.equal(state.examPapers[0].start_time, null);
  assert.equal(state.examPapers[0].end_time, null);

  state.ops = [];
  await ExamAdminService.updateExam(
    state.examPapers[0].id,
    { start_time: '2026-11-01T04:00:00.000Z', end_time: '2026-11-01T06:00:00.000Z' },
    'admin-1'
  );

  const scheduled = state.examPapers[0];
  assert.equal(scheduled.start_time, '2026-11-01T04:00:00.000Z');
  assert.equal(scheduled.end_time, '2026-11-01T06:00:00.000Z');

  await ExamAdminService.updateExam(
    state.examPapers[0].id,
    { start_time: null, end_time: null },
    'admin-1'
  );

  assert.equal(state.examPapers[0].start_time, null);
  assert.equal(state.examPapers[0].end_time, null);
});

test('a draft request leaves is_published false and still links questions', async () => {
  const result = await ExamAdminService.createExam(validPayload({ is_published: false }), 'admin-1');

  assert.equal(result.is_published, false);
  assert.equal(state.examPapers[0].is_published, false);
  assert.equal(state.examPaperQuestions.length, 2);
  assert.ok(!state.ops.includes('exam_papers:update'), 'draft creation must not publish');
});

test('an association failure rolls the paper back and never publishes it', async () => {
  state.failOn = { table: 'exam_paper_questions', op: 'insert' };

  await assert.rejects(
    () => ExamAdminService.createExam(validPayload(), 'admin-1'),
    (error: any) => error.status === 500
  );

  assert.equal(state.examPapers.length, 0, 'the half-built paper must be deleted');
  assert.equal(state.examPaperQuestions.length, 0);
  assert.ok(!state.ops.includes('exam_papers:update'), 'publishing must not be attempted');
  assert.ok(state.ops.includes('exam_papers:delete'), 'cleanup delete must run');
});

/* ------------------------------------------------------------------ */
/* Update                                                              */
/* ------------------------------------------------------------------ */

test('updating metadata does not touch the question set or duplicate the paper', async () => {
  await ExamAdminService.createExam(validPayload({ is_published: false }), 'admin-1');
  state.ops = [];

  const examId = state.examPapers[0].id;
  const updated = await ExamAdminService.updateExam(examId, { title: 'Renamed', is_premium: true }, 'admin-1');

  assert.equal(updated.title, 'Renamed');
  assert.equal(updated.is_premium, true);
  assert.equal(state.examPapers.length, 1);
  assert.equal(state.examPaperQuestions.length, 2);
  assert.ok(!state.ops.includes('exam_paper_questions:delete'), 'metadata-only update keeps questions');
});

test('an update reports has_attempts without blocking the edit', async () => {
  await ExamAdminService.createExam(validPayload({ is_published: false }), 'admin-1');

  const examId = state.examPapers[0].id;

  state.examProgress = [
    { id: 'attempt-1', exam_id: examId, user_id: 'student-1', status: 'submitted' },
  ];

  const updated = await ExamAdminService.updateExam(
    examId,
    { title: 'Renamed after attempts', question_ids: ['q-1'] },
    'admin-1'
  );

  assert.equal(updated.has_attempts, true);
  assert.equal(updated.title, 'Renamed after attempts');
  assert.equal(updated.question_count, 1);
  assert.equal(state.examPaperQuestions.length, 1);
});

test('publishing an exam without questions is refused', async () => {
  state.examPapers = [
    { id: 'exam-empty', title: 'Empty', category: 'board_exam', track: null, subject_id: 'subject-1', duration_min: 30, is_published: false, total_marks: 0 },
  ];

  await assert.rejects(
    () => ExamAdminService.updateExam('exam-empty', { is_published: true }, 'admin-1'),
    (error: any) =>
      error.status === 400 &&
      error.code === 'EXAM_HAS_NO_QUESTIONS' &&
      /questions/i.test(error.message)
  );

  assert.equal(state.examPapers[0].is_published, false);
});

test('publishing an exam without a valid duration is refused', async () => {
  state.examPapers = [
    { id: 'exam-no-duration', title: 'No duration', category: 'board_exam', track: null, subject_id: 'subject-1', duration_min: 0, is_published: false, total_marks: 1 },
  ];
  state.examPaperQuestions = [{ exam_id: 'exam-no-duration', question_id: 'q-1', sequence: 1 }];

  await assert.rejects(
    () => ExamAdminService.updateExam('exam-no-duration', { is_published: true }, 'admin-1'),
    (error: any) => error.status === 400 && /duration/i.test(error.message)
  );
});

test('an update cannot produce an invalid window from stored values', async () => {
  await ExamAdminService.createExam(validPayload({ is_published: false }), 'admin-1');

  const examId = state.examPapers[0].id;

  await assert.rejects(
    () => ExamAdminService.updateExam(examId, { end_time: '2026-10-01T00:00:00.000Z' }, 'admin-1'),
    (error: any) => error.status === 400 && /end_time/i.test(error.message)
  );

  assert.equal(state.examPapers[0].end_time, '2026-11-01T06:00:00.000Z');
});

test('a failed question replacement keeps the previous question set', async () => {
  await ExamAdminService.createExam(validPayload({ is_published: true }), 'admin-1');

  const examId = state.examPapers[0].id;
  state.failOn = { table: 'exam_paper_questions', op: 'insert' };

  await assert.rejects(
    () => ExamAdminService.updateExam(examId, { question_ids: ['q-2'] }, 'admin-1'),
    (error: any) => error.status === 500
  );

  assert.deepEqual(
    state.examPaperQuestions.map((row) => row.question_id),
    ['q-1', 'q-2'],
    'the previous associations must be restored'
  );
});

test('an update to a missing exam returns 404', async () => {
  await assert.rejects(
    () => ExamAdminService.updateExam('missing-id', { title: 'x' }, 'admin-1'),
    (error: any) => error.status === 404
  );
});

/* ------------------------------------------------------------------ */
/* Wizard reference data                                               */
/* ------------------------------------------------------------------ */

test('authoring options expose only active subjects and the accepted categories', async () => {
  const options = await ExamAdminService.listAuthoringOptions();

  assert.deepEqual(
    options.subjects.map((subject: Row) => subject.id),
    ['subject-1', 'subject-2']
  );
  assert.deepEqual(options.categories, ['model_test', 'board_exam', 'admission']);
  assert.deepEqual(options.tracks, ['hsc', 'medical', 'engineering', 'varsity']);
});

test('eligible questions are limited to the subject and to published, active rows', async () => {
  state.questions = [
    { id: 'q-1', status: 'published', is_active: true, deleted_at: null, subject_id: 'subject-1' },
    { id: 'q-2', status: 'published', is_active: true, deleted_at: null, subject_id: 'subject-1' },
    { id: 'q-draft', status: 'pending', is_active: true, deleted_at: null, subject_id: 'subject-1' },
    { id: 'q-other', status: 'published', is_active: true, deleted_at: null, subject_id: 'subject-2' },
  ];

  const rows = await ExamAdminService.listEligibleQuestions({ subjectId: 'subject-1' });

  assert.deepEqual(rows.map((row: Row) => row.id).sort(), ['q-1', 'q-2']);
});

test('eligible questions may span all subjects for a full paper', async () => {
  state.questions = [
    { id: 'q-1', status: 'published', is_active: true, deleted_at: null, subject_id: 'subject-1' },
    { id: 'q-2', status: 'published', is_active: true, deleted_at: null, subject_id: 'subject-1' },
    { id: 'q-draft', status: 'pending', is_active: true, deleted_at: null, subject_id: 'subject-1' },
    { id: 'q-other', status: 'published', is_active: true, deleted_at: null, subject_id: 'subject-2' },
  ];

  const rows = await ExamAdminService.listEligibleQuestions({});

  assert.deepEqual(rows.map((row: Row) => row.id).sort(), ['q-1', 'q-2', 'q-other']);
  assert.deepEqual(
    rows.map((row: Row) => row.subject_id).sort(),
    ['subject-1', 'subject-1', 'subject-2']
  );
});

/* ------------------------------------------------------------------ */
/* Controller contract                                                 */
/* ------------------------------------------------------------------ */

test('the create handler returns a 201 envelope the admin UI can consume', async () => {
  const res = await invoke(adminController.createExam, {
    user: { id: 'admin-1' },
    params: {},
    query: {},
    body: validPayload(),
  });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.question_count, 2);
  assert.equal(typeof res.body.data.id, 'string');
});

test('a validation failure surfaces the 400 message and code to the UI', async () => {
  const res = await invoke(adminController.createExam, {
    user: { id: 'admin-1' },
    params: {},
    query: {},
    body: validPayload({ duration_min: 0 }),
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'VALIDATION_FAILED');
  assert.match(res.body.message, /duration_min/i);
  assert.equal(state.examPapers.length, 0);
});

test('the authoring error type keeps the status/code contract used by the UI', () => {
  const error = new ExamAuthoringError('nope');

  assert.equal(error.status, 400);
  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.equal(error.name, 'ExamAuthoringError');
});
