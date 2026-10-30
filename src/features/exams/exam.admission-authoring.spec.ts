import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * Phase 3 admission authoring: university/unit ownership, exam modes, canonical
 * metadata and mode-aware question compatibility. Runs the real controller,
 * service and router against an in-process fake Supabase client.
 */

type Row = Record<string, any>;

const state: {
  examPapers: Row[];
  examPaperQuestions: Row[];
  questions: Row[];
  subjects: Row[];
  admissionUnits: Row[];
  institutions: Row[];
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
  admissionUnits: [],
  institutions: [],
  userRoles: [],
  examProgress: [],
  examHistory: [],
  ops: [],
  inserts: [],
  failOn: null,
};

let seq = 0;

const TABLE_KEYS: Record<string, keyof typeof state> = {
  exam_papers: 'examPapers',
  exam_paper_questions: 'examPaperQuestions',
  questions: 'questions',
  subjects: 'subjects',
  admission_units: 'admissionUnits',
  institutions: 'institutions',
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
  id: supabaseConfigPath,
  filename: supabaseConfigPath,
  loaded: true,
  exports: { supabase: fakeSupabase },
} as any;

const adminController = require('./exams.admin.controller');
const { ExamAdminService } = require('./exams.admin.service');
const { ExamAdminRoutes } = require('./exams.admin.routes');
const { rbacGuard } = require('../../middlewares/rbacGuard');
const { parseExamCreatePayload } = require('./exam.authoring');

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

const invoke = (handler: any, req: Row) =>
  new Promise<any>((resolve) => {
    const res = createRes();
    let settled = false;

    const finish = (error?: any) => {
      if (settled) return;

      settled = true;

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

const admissionPayload = (overrides: Row = {}) => ({
  title: 'ঢাবি ভর্তি পরীক্ষা ২০২৫',
  subject_id: null,
  category: 'admission',
  track: null,
  exam_mode: 'past_exam',
  admission_session: '2025-26',
  admission_unit_id: 'unit-1',
  admission_university_id: 'uni-1',
  duration_min: 60,
  is_premium: false,
  is_published: true,
  question_ids: ['q-1', 'q-3'],
  ...overrides,
});

beforeEach(() => {
  seq = 0;
  state.examPapers = [];
  state.examPaperQuestions = [];
  state.subjects = [
    { id: 'subject-1', name_bn: 'পদার্থ', name_en: 'Physics', is_premium: false, is_active: true, sequence: 1 },
    { id: 'subject-2', name_bn: 'রসায়ন', name_en: 'Chemistry', is_premium: false, is_active: true, sequence: 2 },
  ];
  state.admissionUnits = [
    { id: 'unit-1', institution_id: 'uni-1', name_bn: 'ক ইউনিট', code: 'A', is_active: true },
    { id: 'unit-2', institution_id: 'uni-2', name_bn: 'খ ইউনিট', code: 'B', is_active: true },
    { id: 'unit-college', institution_id: 'college-1', name_bn: 'কলেজ ইউনিট', code: 'C', is_active: true },
  ];
  state.institutions = [
    { id: 'uni-1', name_bn: 'ঢাকা বিশ্ববিদ্যালয়', type: 'university', is_active: true },
    { id: 'uni-2', name_bn: 'রাজশাহী বিশ্ববিদ্যালয়', type: 'university', is_active: true },
    { id: 'college-1', name_bn: 'একটি কলেজ', type: 'college', is_active: true },
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
    { id: 'q-3', status: 'published', is_active: true, deleted_at: null, subject_id: 'subject-2', body: { text_bn: 'প্রশ্ন ৩' }, difficulty_level: 'easy', type: 'MCQ' },
    { id: 'q-draft', status: 'pending', is_active: true, deleted_at: null, subject_id: 'subject-1', body: { text_bn: 'খসড়া' }, difficulty_level: 'easy', type: 'MCQ' },
  ];
});

test('past exam accepts a complete multi-subject paper and stores canonical metadata', async () => {
  const result = await ExamAdminService.createExam(admissionPayload(), 'admin-1');

  assert.equal(result.question_count, 2);
  assert.equal(state.examPapers[0].admission_unit_id, 'unit-1');
  assert.equal(state.examPapers[0].subject_id, null);
  assert.equal('admission_university_id' in state.examPapers[0], false);
  assert.deepEqual(state.examPapers[0].meta_data, {
    exam_mode: 'past_exam',
    admission_session: '2025-26',
  });
  assert.deepEqual(
    state.examPaperQuestions.map((row) => row.question_id),
    ['q-1', 'q-3']
  );
});

test('exam details derive the university from the stored admission unit', async () => {
  const created = await ExamAdminService.createExam(admissionPayload(), 'admin-1');
  const details = await ExamAdminService.getExamDetails(created.id);

  assert.equal(details.admission_unit_id, 'unit-1');
  assert.equal(details.admission_university_id, 'uni-1');
  assert.equal(details.meta_data.exam_mode, 'past_exam');
  assert.equal(details.meta_data.admission_session, '2025-26');
});

test('missing unit, mode and past-exam session are rejected', async () => {
  await assert.rejects(
    () => ExamAdminService.createExam(admissionPayload({ admission_unit_id: null }), 'admin-1'),
    (error: any) => error.status === 400 && error.code === 'ADMISSION_UNIT_REQUIRED'
  );

  await assert.rejects(
    () => ExamAdminService.createExam(admissionPayload({ exam_mode: null }), 'admin-1'),
    (error: any) => error.status === 400 && error.code === 'ADMISSION_MODE_REQUIRED'
  );

  await assert.rejects(
    () => ExamAdminService.createExam(admissionPayload({ admission_session: null }), 'admin-1'),
    (error: any) => error.status === 400 && error.code === 'ADMISSION_SESSION_REQUIRED'
  );

  assert.equal(state.examPapers.length, 0);
});

test('a unit from another university is rejected', async () => {
  await assert.rejects(
    () => ExamAdminService.createExam(admissionPayload({ admission_unit_id: 'unit-2' }), 'admin-1'),
    (error: any) => error.status === 400 && error.code === 'ADMISSION_UNIT_MISMATCH'
  );

  assert.equal(state.examPapers.length, 0);
});

test('a unit attached to a non-university institution is rejected', async () => {
  await assert.rejects(
    () =>
      ExamAdminService.createExam(
        admissionPayload({ admission_unit_id: 'unit-college', admission_university_id: 'college-1' }),
        'admin-1'
      ),
    (error: any) => error.status === 400 && error.code === 'ADMISSION_UNIT_INVALID_UNIVERSITY'
  );
});

test('subject practice requires a subject and rejects cross-subject questions', async () => {
  await assert.rejects(
    () =>
      ExamAdminService.createExam(
        admissionPayload({ exam_mode: 'subject_practice', subject_id: null }),
        'admin-1'
      ),
    (error: any) => error.status === 400 && error.code === 'ADMISSION_SUBJECT_REQUIRED'
  );

  await assert.rejects(
    () =>
      ExamAdminService.createExam(
        admissionPayload({
          exam_mode: 'subject_practice',
          subject_id: 'subject-1',
          question_ids: ['q-1', 'q-3'],
        }),
        'admin-1'
      ),
    (error: any) =>
      error.status === 400 &&
      error.details?.incompatible_subject_question_ids?.includes('q-3')
  );

  const result = await ExamAdminService.createExam(
    admissionPayload({
      exam_mode: 'subject_practice',
      subject_id: 'subject-1',
      question_ids: ['q-1', 'q-2'],
      admission_session: null,
    }),
    'admin-1'
  );

  assert.equal(result.question_count, 2);
  assert.equal(state.examPapers[0].subject_id, 'subject-1');
  assert.equal(state.examPapers[0].meta_data.exam_mode, 'subject_practice');
  assert.equal('admission_session' in state.examPapers[0].meta_data, false);
});

test('model test accepts multiple subjects and configurable per-question marks', async () => {
  const result = await ExamAdminService.createExam(
    admissionPayload({
      exam_mode: 'model_test',
      subject_id: null,
      admission_session: null,
      question_ids: ['q-1', 'q-3'],
      question_marks: { 'q-1': 2, 'q-3': 3 },
    }),
    'admin-1'
  );

  assert.equal(result.question_count, 2);
  assert.equal(state.examPapers[0].total_marks, 5);
  assert.deepEqual(
    state.examPaperQuestions.map((row) => row.marks),
    [2, 3]
  );
  assert.equal(state.examPapers[0].meta_data.exam_mode, 'model_test');
});

test('question marks must belong to the submitted question list', () => {
  assert.throws(
    () =>
      parseExamCreatePayload(
        admissionPayload({ question_marks: { 'q-2': 2 } })
      ),
    (error: any) => error.status === 400 && /question_marks/.test(error.message)
  );
});

test('non-admission HSC model tests keep their existing validation and marks', async () => {
  const result = await ExamAdminService.createExam(
    {
      title: 'HSC Physics',
      subject_id: 'subject-1',
      category: 'model_test',
      track: 'hsc',
      duration_min: 30,
      is_published: true,
      question_ids: ['q-1', 'q-2'],
    },
    'admin-1'
  );

  assert.equal(result.question_count, 2);
  assert.equal(state.examPapers[0].track, 'hsc');
  assert.equal(state.examPapers[0].admission_unit_id, null);
  assert.equal(state.examPapers[0].meta_data, undefined);
  assert.deepEqual(
    state.examPaperQuestions.map((row) => row.marks),
    [1, 1]
  );
});

test('non-admission papers reject admission fields', async () => {
  await assert.rejects(
    () =>
      ExamAdminService.createExam(
        {
          title: 'HSC Physics',
          subject_id: 'subject-1',
          category: 'board_exam',
          track: null,
          admission_unit_id: 'unit-1',
          duration_min: 30,
          question_ids: ['q-1'],
        },
        'admin-1'
      ),
    (error: any) => error.status === 400 && /Admission fields/.test(error.message)
  );
});

test('legacy admission papers without a unit can still be edited by title', async () => {
  state.examPapers = [
    {
      id: 'legacy-admission',
      title: 'Legacy admission',
      category: 'admission',
      track: null,
      subject_id: null,
      admission_unit_id: null,
      meta_data: { legacy_key: 'kept' },
      duration_min: 60,
      is_published: false,
      total_marks: 1,
    },
  ];
  state.examPaperQuestions = [
    { exam_id: 'legacy-admission', question_id: 'q-1', sequence: 1, marks: 1 },
  ];

  const updated = await ExamAdminService.updateExam(
    'legacy-admission',
    { title: 'Legacy admission renamed' },
    'admin-1'
  );

  assert.equal(updated.title, 'Legacy admission renamed');
  assert.deepEqual(state.examPapers[0].meta_data, { legacy_key: 'kept' });
  assert.equal(state.examPapers[0].admission_unit_id, null);
});

test('editing admission metadata merges canonical keys without dropping legacy keys', async () => {
  state.examPapers = [
    {
      id: 'legacy-admission',
      title: 'Legacy admission',
      category: 'admission',
      track: null,
      subject_id: null,
      admission_unit_id: 'unit-1',
      meta_data: { legacy_key: 'kept', year: 2024 },
      duration_min: 60,
      is_published: false,
      total_marks: 1,
    },
  ];
  state.examPaperQuestions = [
    { exam_id: 'legacy-admission', question_id: 'q-1', sequence: 1, marks: 1 },
  ];

  await ExamAdminService.updateExam(
    'legacy-admission',
    {
      exam_mode: 'past_exam',
      admission_session: '2025-26',
      admission_university_id: 'uni-1',
    },
    'admin-1'
  );

  assert.deepEqual(state.examPapers[0].meta_data, {
    legacy_key: 'kept',
    year: 2024,
    exam_mode: 'past_exam',
    admission_session: '2025-26',
  });
});

test('an update cannot move an admission paper to another university unit', async () => {
  await ExamAdminService.createExam(admissionPayload({ is_published: false }), 'admin-1');

  await assert.rejects(
    () =>
      ExamAdminService.updateExam(
        state.examPapers[0].id,
        { admission_unit_id: 'unit-2', admission_university_id: 'uni-1' },
        'admin-1'
      ),
    (error: any) => error.status === 400 && error.code === 'ADMISSION_UNIT_MISMATCH'
  );

  assert.equal(state.examPapers[0].admission_unit_id, 'unit-1');
});

test('model tests reject a question set above the existing 200-question limit', () => {
  const ids = Array.from({ length: 201 }, (_, index) => `q-${index}`);

  assert.throws(
    () => parseExamCreatePayload(admissionPayload({ question_ids: ids })),
    (error: any) => error.status === 400 && /200/.test(error.message)
  );
});

test('students cannot reach admission authoring handlers', async () => {
  const guard = rbacGuard(['admin']);
  const res = createRes();
  let nextCalled = false;

  await guard({ user: { id: 'student-1' } } as any, res as any, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(state.examPapers.length, 0);
});

test('the controller returns a 201 envelope for an admission paper', async () => {
  const res = await invoke(adminController.createExam, {
    user: { id: 'admin-1' },
    params: {},
    query: {},
    body: admissionPayload(),
  });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.admission_unit_id, 'unit-1');
  assert.equal(res.body.data.meta_data.exam_mode, 'past_exam');
});

test('the authoring route list still exposes create, update and eligible questions', () => {
  const routes = (ExamAdminRoutes.stack ?? [])
    .filter((layer: any) => layer.route)
    .map((layer: any) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);

  assert.ok(routes.includes('POST /'));
  assert.ok(routes.includes('PATCH /:id'));
  assert.ok(routes.includes('GET /eligible-questions'));
});
