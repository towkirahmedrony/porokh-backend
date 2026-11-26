import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

type Row = Record<string, any>;

const state: {
  batches: Row[];
  profiles: Row[];
  audits: Row[];
} = {
  batches: [],
  profiles: [],
  audits: [],
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

const batchBuilder = () => {
  let mode: 'select' | 'update' = 'select';
  let pendingPatch: Row | null = null;
  let filterYear: string | null = null;
  let sortedDesc = false;

  const resolveRows = () => {
    if (mode === 'update') {
      const index = state.batches.findIndex((row) => row.batch_year === filterYear);
      if (index >= 0) {
        state.batches[index] = { ...state.batches[index], ...(pendingPatch ?? {}) };
      }
      return { data: null, error: null };
    }

    const rows = filterYear
      ? state.batches.filter((row) => row.batch_year === filterYear)
      : [...state.batches];
    if (sortedDesc) rows.sort((a, b) => b.batch_year.localeCompare(a.batch_year));
    return { data: rows, error: null };
  };

  const builder: any = {
    select: () => builder,
    insert: (row: Row) => {
      if (state.batches.some((existing) => existing.batch_year === row.batch_year)) {
        return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
      }
      state.batches.push({ ...row, updated_at: '2026-11-26T00:00:00.000Z' });
      return Promise.resolve({ data: null, error: null });
    },
    update: (patch: Row) => {
      mode = 'update';
      pendingPatch = patch;
      return builder;
    },
    eq: (column: string, value: string) => {
      if (column === 'batch_year') filterYear = value;
      return builder;
    },
    not: () => builder,
    order: (_column: string, options?: { ascending?: boolean }) => {
      sortedDesc = options?.ascending === false;
      return builder;
    },
    maybeSingle: async () => {
      const { data } = resolveRows();
      return { data: Array.isArray(data) ? data[0] ?? null : null, error: null };
    },
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(resolveRows()).then(onFulfilled, onRejected),
  };

  return builder;
};

const profileBuilder = () => {
  const builder: any = {
    select: () => builder,
    not: () => builder,
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve({ data: state.profiles, error: null }).then(onFulfilled, onRejected),
  };
  return builder;
};

const fakeSupabaseAdmin = {
  from: (table: string) => (table === 'hsc_batches' ? batchBuilder() : profileBuilder()),
};

stubModule('../../config/supabaseAdmin', { supabaseAdmin: fakeSupabaseAdmin });
stubModule('../../lib/utils/adminAudit', {
  recordAdminAudit: async (
    actorId: string,
    action: string,
    resourceType: string,
    resourceId?: string,
    details: Row = {}
  ) => {
    state.audits.push({ actorId, action, resourceType, resourceId, details });
  },
});

const {
  createBatch,
  isExamEnded,
  listBatches,
  updateBatch,
} = loadModule('./hscBatches.admin.service');
const {
  parseBatchNotes,
  parseBatchYear,
  parseCreateBatchBody,
  parseExamEndDate,
  parseUpdateBatchBody,
} = loadModule('./hscBatches.validation');
const { HscBatchesError } = loadModule('./hscBatches.types');

beforeEach(() => {
  state.batches = [
    { batch_year: '2027', exam_end_date: null, notes: null, updated_at: '2026-11-01T00:00:00.000Z', updated_by: null },
    { batch_year: '2026', exam_end_date: '2026-10-01', notes: 'শেষ', updated_at: '2026-11-01T00:00:00.000Z', updated_by: null },
  ];
  state.profiles = [
    { hsc_batch: '2025', study_goal: null, goal_confirmed_at: null },
    { hsc_batch: '2026', study_goal: null, goal_confirmed_at: null },
    { hsc_batch: '2026', study_goal: 'hsc', goal_confirmed_at: null },
    { hsc_batch: '2026', study_goal: 'varsity', goal_confirmed_at: null },
    { hsc_batch: '2026', study_goal: 'medical', goal_confirmed_at: '2026-11-01T00:00:00.000Z' },
    { hsc_batch: '2027', study_goal: 'engineering', goal_confirmed_at: '2026-11-02T00:00:00.000Z' },
    { hsc_batch: '2027', study_goal: null, goal_confirmed_at: null },
  ];
  state.audits = [];
});

test('a batch year and an exam date are validated, not trusted', () => {
  assert.equal(parseBatchYear('2027'), '2027');
  assert.throws(() => parseBatchYear('2026-27'), HscBatchesError);
  assert.throws(() => parseBatchYear('26'), HscBatchesError);
  assert.throws(() => parseBatchYear(2027), HscBatchesError);

  assert.equal(parseExamEndDate('2026-10-01'), '2026-10-01');
  assert.equal(parseExamEndDate(null), null);
  assert.equal(parseExamEndDate('   '), null);
  assert.throws(() => parseExamEndDate('2026-02-30'), HscBatchesError);
  assert.throws(() => parseExamEndDate('01/10/2026'), HscBatchesError);

  assert.equal(parseBatchNotes(' নোট '), 'নোট');
  assert.throws(() => parseBatchNotes('x'.repeat(501)), HscBatchesError);
});

test('a create body needs a year and a patch only touches the fields it sends', () => {
  assert.deepEqual(parseCreateBatchBody({ batch_year: '2028' }), {
    batch_year: '2028',
    exam_end_date: null,
    notes: null,
  });

  assert.deepEqual(parseUpdateBatchBody({ exam_end_date: '2026-11-30' }), {
    exam_end_date: '2026-11-30',
  });

  assert.throws(() => parseUpdateBatchBody({}), HscBatchesError);
});

test('the exam is over from the day after its last day, in Dhaka', () => {
  assert.equal(isExamEnded('2026-10-01', '2026-10-01'), false);
  assert.equal(isExamEnded('2026-10-01', '2026-10-02'), true);
  assert.equal(isExamEnded(null, '2030-01-01'), false);
});

test('listing reports students, and only unsettled goals count as pending', async () => {
  const batches = await listBatches();
  const byYear = Object.fromEntries(batches.map((batch: Row) => [batch.batch_year, batch]));

  assert.equal(byYear['2026'].student_count, 4);
  assert.equal(byYear['2026'].pending_goal_count, 3);
  assert.equal(byYear['2026'].exam_ended, true);
  assert.equal(byYear['2027'].student_count, 2);
  assert.equal(byYear['2027'].pending_goal_count, 1);
  assert.equal(byYear['2027'].exam_ended, false);
  assert.deepEqual(batches.map((batch: Row) => batch.batch_year), ['2027', '2026']);
});

test('creating an existing batch is a conflict, not a silent no-op', async () => {
  await assert.rejects(
    createBatch('admin-1', { batch_year: '2027', exam_end_date: null, notes: null }),
    (error: any) => error instanceof HscBatchesError && error.status === 409
  );
  assert.equal(state.audits.length, 0);
});

test('moving a date into the past counts the students whose stage changes and audits it', async () => {
  const result = await updateBatch('admin-1', '2027', { exam_end_date: '2026-01-01' });

  assert.equal(result.exam_ended, true);
  // One 2027 student has no goal yet, so that is the one whose stage moves.
  assert.equal(result.affected_students, 1);
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].action, 'hsc_batch.update');
  assert.equal(state.audits[0].resourceType, 'hsc_batches');
  assert.equal(state.audits[0].resourceId, '2027');
  assert.equal(
    state.audits[0].details.after.exam_end_date,
    '2026-01-01'
  );
});

test('a patch for a batch that does not exist is a 404', async () => {
  await assert.rejects(
    updateBatch('admin-1', '2031', { notes: 'x' }),
    (error: any) => error instanceof HscBatchesError && error.status === 404
  );
});
