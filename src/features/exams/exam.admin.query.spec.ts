import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * Admin exam catalog and overview: query parsing, status derivation and the
 * paginated read. Runs the real service against an in-process fake Supabase
 * client (no network, no database).
 */

type Row = Record<string, any>;

const state: {
  examPapers: Row[];
  examPaperQuestions: Row[];
  examHistory: Row[];
  examProgress: Row[];
  orExpressions: string[];
} = {
  examPapers: [],
  examPaperQuestions: [],
  examHistory: [],
  examProgress: [],
  orExpressions: [],
};

const TABLE_KEYS: Record<string, keyof typeof state> = {
  exam_papers: 'examPapers',
  exam_paper_questions: 'examPaperQuestions',
  exam_history: 'examHistory',
  exam_progress: 'examProgress',
};

const createBuilder = (table: string) => {
  const key = TABLE_KEYS[table];

  if (!key) throw new Error(`unexpected table "${table}"`);

  const filters: ((row: Row) => boolean)[] = [];
  let wantCount = false;
  let headOnly = false;
  let orderings: { column: string; ascending: boolean }[] = [];
  let rowLimit: number | null = null;
  let range: [number, number] | null = null;

  const rows = (): Row[] => (state[key] as unknown as Row[]) ?? [];

  const matching = () => rows().filter((row) => filters.every((filter) => filter(row)));

  const execute = () => {
    let result = matching();

    for (const { column, ascending } of orderings.slice().reverse()) {
      result = result.slice().sort((a, b) => {
        const av = a[column] ?? '';
        const bv = b[column] ?? '';
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
      });
    }

    const total = result.length;

    if (range) result = result.slice(range[0], range[1] + 1);
    if (rowLimit !== null) result = result.slice(0, rowLimit);

    return {
      data: headOnly ? null : result,
      error: null,
      count: wantCount || headOnly ? total : undefined,
    };
  };

  const builder: any = {
    select: (_columns?: string, options?: { count?: string; head?: boolean }) => {
      wantCount = options?.count === 'exact';
      headOnly = options?.head === true;
      return builder;
    },
    eq: (column: string, value: any) => {
      filters.push((row) => String(row[column]) === String(value));
      return builder;
    },
    in: (column: string, values: any[]) => {
      filters.push((row) => values.map(String).includes(String(row[column])));
      return builder;
    },
    gt: (column: string, value: any) => {
      filters.push((row) => row[column] != null && String(row[column]) > String(value));
      return builder;
    },
    lt: (column: string, value: any) => {
      filters.push((row) => row[column] != null && String(row[column]) < String(value));
      return builder;
    },
    gte: (column: string, value: any) => {
      filters.push((row) => row[column] != null && String(row[column]) >= String(value));
      return builder;
    },
    or: (expression: string) => {
      // The fake cannot evaluate PostgREST logic trees; record it so the test
      // can assert the expression the service would send.
      state.orExpressions.push(expression);
      return builder;
    },
    order: (column: string, options?: { ascending?: boolean }) => {
      orderings.push({ column, ascending: options?.ascending !== false });
      return builder;
    },
    limit: (value: number) => {
      rowLimit = value;
      return builder;
    },
    range: (from: number, to: number) => {
      range = [from, to];
      return builder;
    },
    maybeSingle: async () => {
      const result = execute();
      return { data: (result.data ?? [])[0] ?? null, error: null };
    },
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(execute()).then(onFulfilled, onRejected),
  };

  return builder;
};

const fakeSupabase = {
  from: (table: string) => createBuilder(table),
  rpc: async () => ({ data: null, error: null }),
};

const nodeRequire = createRequire(__filename);
const supabaseConfigPath = nodeRequire.resolve('../../config/supabase');

nodeRequire.cache[supabaseConfigPath] = {
  id: supabaseConfigPath,
  filename: supabaseConfigPath,
  loaded: true,
  exports: { supabase: fakeSupabase },
} as any;

const { ExamAdminService } = nodeRequire('./exams.admin.service');
const {
  DEFAULT_EXAM_PAGE_SIZE,
  MAX_EXAM_PAGE_SIZE,
  deriveExamStatus,
  parseExamAdminQuery,
} = nodeRequire('./exams.admin.query');

const paper = (overrides: Row = {}): Row => ({
  id: 'paper-1',
  title: 'Model Test 1',
  title_en: null,
  category: 'model_test',
  track: 'hsc',
  subject_id: 'subject-1',
  is_published: true,
  is_premium: false,
  duration_min: 30,
  total_marks: 10,
  pass_mark: 4,
  start_time: null,
  end_time: null,
  result_publish_time: null,
  admission_unit_id: null,
  meta_data: {},
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-01T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  state.examPapers = [];
  state.examPaperQuestions = [];
  state.examHistory = [];
  state.examProgress = [];
  state.orExpressions = [];
});

/* ------------------------------------------------------------------ */
/* Query parsing                                                       */
/* ------------------------------------------------------------------ */

test('exam list query defaults are bounded and unfiltered', () => {
  const query = parseExamAdminQuery({});

  assert.equal(query.page, 1);
  assert.equal(query.page_size, DEFAULT_EXAM_PAGE_SIZE);
  assert.equal(query.status, 'all');
  assert.equal(query.category, '');
  assert.equal(query.track, '');
  assert.equal(query.sort, 'created_at');
  assert.equal(query.direction, 'desc');
  assert.equal(query.q, '');
});

test('exam list query rejects unknown values instead of widening the result', () => {
  assert.throws(() => parseExamAdminQuery({ status: 'archived' }), /status/);
  assert.throws(() => parseExamAdminQuery({ sort: 'total_marks' }), /sort/);
  assert.throws(() => parseExamAdminQuery({ direction: 'sideways' }), /direction/);
  assert.throws(() => parseExamAdminQuery({ page: '0' }), /page/);
  assert.throws(() => parseExamAdminQuery({ page_size: String(MAX_EXAM_PAGE_SIZE + 1) }), /page_size/);
});

test('exam search rejects PostgREST filter syntax and escapes wildcards', () => {
  assert.throws(() => parseExamAdminQuery({ q: 'a,b' }), /unsupported/);
  assert.equal(parseExamAdminQuery({ q: '50%' }).q, '50\\%');
});

/* ------------------------------------------------------------------ */
/* Status derivation                                                   */
/* ------------------------------------------------------------------ */

test('a draft is never reported as scheduled or live', () => {
  assert.equal(
    deriveExamStatus(
      { is_published: false, start_time: '2026-01-01T00:00:00.000Z', end_time: null },
      Date.parse('2030-01-01T00:00:00.000Z')
    ),
    'draft'
  );
});

test('published papers map onto the window the student engine enforces', () => {
  const now = Date.parse('2026-11-11T12:00:00.000Z');

  assert.equal(deriveExamStatus({ is_published: true }, now), 'open');
  assert.equal(
    deriveExamStatus({ is_published: true, start_time: '2026-11-11T13:00:00.000Z' }, now),
    'scheduled'
  );
  assert.equal(
    deriveExamStatus({ is_published: true, start_time: '2026-11-11T11:00:00.000Z' }, now),
    'live'
  );
  assert.equal(
    deriveExamStatus(
      {
        is_published: true,
        start_time: '2026-11-11T11:00:00.000Z',
        end_time: '2026-11-11T13:00:00.000Z',
      },
      now
    ),
    'live'
  );
  assert.equal(
    deriveExamStatus(
      {
        is_published: true,
        start_time: '2026-11-11T09:00:00.000Z',
        end_time: '2026-11-11T10:00:00.000Z',
      },
      now
    ),
    'completed'
  );
  // An end bound alone closes the paper exactly like a full window would.
  assert.equal(
    deriveExamStatus({ is_published: true, end_time: '2026-11-11T10:00:00.000Z' }, now),
    'completed'
  );
});

/* ------------------------------------------------------------------ */
/* Paginated catalog                                                   */
/* ------------------------------------------------------------------ */

test('the catalog pages in Postgres and enriches only the returned page', async () => {
  state.examPapers = Array.from({ length: 5 }, (_, index) =>
    paper({
      id: `paper-${index + 1}`,
      title: `Paper ${index + 1}`,
      created_at: `2026-11-0${index + 1}T00:00:00.000Z`,
    })
  );
  state.examPaperQuestions = [
    { exam_id: 'paper-1' },
    { exam_id: 'paper-1' },
    { exam_id: 'paper-2' },
    { exam_id: 'paper-5' },
  ];
  state.examHistory = [{ exam_id: 'paper-1' }, { exam_id: 'paper-2' }];
  state.examProgress = [
    { exam_id: 'paper-1', status: 'in_progress' },
    { exam_id: 'paper-1', status: 'submitted' },
  ];

  const result = await ExamAdminService.getAllExams(parseExamAdminQuery({ page: '2', page_size: '2' }));

  assert.equal(result.total, 5);
  assert.equal(result.total_pages, 3);
  assert.deepEqual(
    result.items.map((item: Row) => item.id),
    ['paper-3', 'paper-2']
  );

  const second = result.items.find((item: Row) => item.id === 'paper-2');

  assert.equal(second.question_count, 1);
  assert.equal(second.participant_count, 1);
  assert.equal(second.active_attempt_count, 0);
  assert.equal(second.status, 'open');
});

test('the draft filter asks the database for unpublished papers only', async () => {
  state.examPapers = [
    paper({ id: 'draft-1', is_published: false }),
    paper({ id: 'live-1', is_published: true }),
  ];

  const result = await ExamAdminService.getAllExams(parseExamAdminQuery({ status: 'draft' }));

  assert.deepEqual(
    result.items.map((item: Row) => item.id),
    ['draft-1']
  );
  assert.equal(result.items[0].status, 'draft');
});

test('search filters titles and ids through one escaped or-expression', async () => {
  state.examPapers = [paper({ id: 'paper-1' })];

  await ExamAdminService.getAllExams(parseExamAdminQuery({ q: '50%' }));

  assert.deepEqual(state.orExpressions, [
    'title.ilike.%50\\%%,title_en.ilike.%50\\%%,id.ilike.%50\\%%',
  ]);
});

test('live filtering uses the same status rule the rows report', async () => {
  const now = Date.now();

  state.examPapers = [
    paper({
      id: 'live-1',
      start_time: new Date(now - 60_000).toISOString(),
      end_time: new Date(now + 60_000).toISOString(),
    }),
    paper({ id: 'open-1' }),
    paper({ id: 'scheduled-1', start_time: new Date(now + 60_000).toISOString() }),
  ];

  const result = await ExamAdminService.getAllExams(parseExamAdminQuery({ status: 'live' }));

  assert.deepEqual(
    result.items.map((item: Row) => item.id),
    ['live-1']
  );
  assert.equal(result.total, 1);
});

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

test('the overview counts each lifecycle state and flags papers that cannot publish', async () => {
  const now = Date.now();

  state.examPapers = [
    paper({ id: 'draft-empty', title: 'Empty draft', is_published: false }),
    paper({ id: 'draft-ready', title: 'Ready draft', is_published: false }),
    paper({
      id: 'live-1',
      title: 'Live paper',
      start_time: new Date(now - 60_000).toISOString(),
      end_time: new Date(now + 60 * 60_000).toISOString(),
    }),
    paper({ id: 'open-1', title: 'Always open' }),
    paper({
      id: 'done-1',
      title: 'Finished',
      start_time: new Date(now - 120_000).toISOString(),
      end_time: new Date(now - 60_000).toISOString(),
    }),
    paper({ id: 'scheduled-1', title: 'Later', start_time: new Date(now + 30_000).toISOString() }),
  ];
  state.examPaperQuestions = [
    { exam_id: 'draft-ready' },
    { exam_id: 'live-1' },
    { exam_id: 'live-1' },
    { exam_id: 'open-1' },
    { exam_id: 'done-1' },
    { exam_id: 'scheduled-1' },
  ];
  state.examProgress = [
    { exam_id: 'live-1', status: 'in_progress' },
    { exam_id: 'live-1', status: 'in_progress' },
  ];
  state.examHistory = [
    {
      id: 'result-1',
      exam_id: 'live-1',
      score: 8,
      total_marks: 10,
      time_taken: 300,
      status: 'clean',
      submitted_at: '2026-11-11T10:00:00.000Z',
      profiles: { full_name: 'Rahim' },
    },
  ];

  const overview = await ExamAdminService.getOverview();

  assert.deepEqual(overview.counts, {
    total: 6,
    draft: 2,
    scheduled: 1,
    live: 1,
    completed: 1,
    open: 1,
  });
  assert.equal(overview.active_attempts, 2);
  assert.equal(overview.live[0].id, 'live-1');
  assert.equal(overview.live[0].active_attempts, 2);
  assert.equal(overview.upcoming[0].id, 'scheduled-1');
  assert.equal(overview.recent_results[0].exam_title, 'Live paper');
  assert.equal(overview.recent_results[0].user_name, 'Rahim');

  const codes = overview.alerts.map((alert: Row) => alert.code);
  assert.ok(codes.includes('DRAFT_WITHOUT_QUESTIONS'));
  assert.ok(codes.includes('STARTS_WITHIN_HOUR'));
  assert.ok(!codes.includes('PUBLISHED_WITHOUT_QUESTIONS'));
  assert.deepEqual(
    overview.needs_attention.map((item: Row) => item.id),
    ['draft-empty']
  );
});
