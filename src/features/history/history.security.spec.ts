import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

type Row = Record<string, any>;

type FakeState = {
  exam_history: Row[];
  exam_history_details: Row[];
  questions: Row[];
  subjects: Row[];
  bookmarks: Row[];
  wrong_answers: Row[];
  mistake_dismissals: Row[];
  exam_paper_questions: Row[];
  exam_papers: Row[];
  profiles: Row[];
  missingTables: string[];
  selects: string[];
  // Rows returned by public.user_mistake_questions(); user_id is only used by
  // the fake to scope the call the way the SQL function does.
  mistake_rows: Row[];
  rpcCalls: Array<{ name: string; args: Row }>;
  rpcErrors: Record<string, Row>;
};

const state: FakeState = {
  exam_history: [],
  exam_history_details: [],
  questions: [],
  subjects: [],
  bookmarks: [],
  wrong_answers: [],
  mistake_dismissals: [],
  exam_paper_questions: [],
  exam_papers: [],
  profiles: [],
  missingTables: [],
  selects: [],
  mistake_rows: [],
  rpcCalls: [],
  rpcErrors: {},
};

const resetState = () => {
  state.exam_history = [];
  state.exam_history_details = [];
  state.questions = [];
  state.subjects = [];
  state.bookmarks = [];
  state.wrong_answers = [];
  state.mistake_dismissals = [];
  state.exam_paper_questions = [];
  state.exam_papers = [];
  state.profiles = [];
  state.missingTables = [];
  state.selects = [];
  state.mistake_rows = [];
  state.rpcCalls = [];
  state.rpcErrors = {};
};

const project = (row: Row, columns: string): Row => {
  if (columns.trim() === '*') return row;

  const picked: Row = {};
  columns
    .split(',')
    .map((column) => column.trim())
    .forEach((column) => {
      if (column in row) picked[column] = row[column];
    });

  return picked;
};

const createBuilder = (table: keyof FakeState) => {
  let columns = '*';
  let action: 'select' | 'delete' | 'upsert' | 'update' = 'select';
  let single = false;
  let upsertPayload: Row | null = null;
  const filters: Array<{ type: 'eq' | 'in' | 'or'; column?: string; value: any }> = [];

  const matches = (row: Row): boolean =>
    filters.every((filter) => {
      if (filter.type === 'eq') return String(row[filter.column!]) === String(filter.value);
      if (filter.type === 'in') {
        return (filter.value as unknown[]).some(
          (value) => String(value) === String(row[filter.column!])
        );
      }
      const conditions = String(filter.value).split(',');
      return conditions.some((condition) => {
        const [column, operator, ...rest] = condition.split('.');
        if (operator !== 'eq') return false;
        return String(row[column]) === rest.join('.');
      });
    });

  const builder: any = {
    select: (selected: string = '*') => {
      columns = String(selected);
      state.selects.push(columns);
      return builder;
    },
    eq: (column: string, value: any) => {
      filters.push({ type: 'eq', column, value });
      return builder;
    },
    in: (column: string, value: any[]) => {
      filters.push({ type: 'in', column, value });
      return builder;
    },
    or: (value: string) => {
      filters.push({ type: 'or', value });
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    is: () => builder,
    maybeSingle: () => {
      single = true;
      return builder;
    },
    single: () => {
      single = true;
      return builder;
    },
    delete: () => {
      action = 'delete';
      return builder;
    },
    upsert: (payload: Row) => {
      action = 'upsert';
      upsertPayload = payload;
      return builder;
    },
    update: (payload: Row) => {
      action = 'update';
      upsertPayload = payload;
      return builder;
    },
    then: (onFulfilled: any, onRejected: any) => {
      if (state.missingTables.includes(table)) {
        return Promise.resolve({
          data: null,
          error: { code: 'PGRST205', message: 'Could not find the table in the schema cache' },
        }).then(onFulfilled, onRejected);
      }

      let rows = (state[table] as Row[]).filter(matches);

      if (action === 'update') {
        const mutableState = state as unknown as Record<string, Row[]>;
        mutableState[table] = (state[table] as Row[]).map((row) =>
          matches(row) ? { ...row, ...(upsertPayload ?? {}) } : row
        );
        return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
      }

      if (action === 'delete') {
        const mutableState = state as unknown as Record<string, Row[]>;
        mutableState[table] = (state[table] as Row[]).filter((row) => !matches(row));
        return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
      }

      if (action === 'upsert') {
        const payload = upsertPayload ?? {};
        const existingIndex = (state[table] as Row[]).findIndex(
          (row) =>
            String(row.user_id) === String(payload.user_id) &&
            String(row.question_id) === String(payload.question_id)
        );
        const mutableState = state as unknown as Record<string, Row[]>;
        if (existingIndex >= 0) mutableState[table][existingIndex] = { ...payload };
        else mutableState[table].push({ ...payload });
        return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
      }

      if (table === 'exam_history' && columns.includes('exam_history_details')) {
        rows = rows.map((row) => ({
          ...row,
          exam_history_details: state.exam_history_details.filter(
            (detail) => String(detail.exam_history_id) === String(row.id)
          ),
        }));
      } else if (table === 'exam_history_details' && columns.includes('questions')) {
        rows = rows.map((row) => ({
          ...row,
          questions:
            state.questions.find(
              (question) => String(question.id) === String(row.question_id)
            ) ?? null,
        }));
      } else if (table === 'exam_history') {
        rows = rows.map((row) => project(row, columns));
      }

      const data = single ? (rows[0] ?? null) : rows;
      return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
    },
  };

  return builder;
};

const fakeSupabase = {
  from: (table: string) => createBuilder(table as keyof FakeState),
  rpc: async (name: string, args: Row = {}) => {
    state.rpcCalls.push({ name, args });

    const error = state.rpcErrors[name];
    if (error) return { data: null, error };

    // The fake only reproduces the scoping and the grouping of the SQL
    // functions; the mistake rule itself is covered by the SQL suite in
    // supabase/tests/mistake_source_of_truth.sql.
    const rows = state.mistake_rows.filter(
      (row) => row.user_id === args.p_user_id
    );

    if (name === 'user_mistake_questions') {
      return { data: rows, error: null };
    }

    if (name === 'get_user_mistake_counts') {
      const counts = new Map<string, number>();
      rows.forEach((row) => {
        const key = String(row.exam_history_id);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      });

      return {
        data: Array.from(counts.entries()).map(([exam_history_id, mistake_count]) => ({
          exam_history_id,
          mistake_count,
        })),
        error: null,
      };
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

const historyService = require('./history.service');

const SECRET = {
  isCorrect: true,
  is_correct: true,
  correct: true,
  answer: 'secret-answer',
};

const makeQuestion = (id: string, overrides: Row = {}): Row => ({
  id,
  subject_id: 'subject-1',
  body: { text_bn: `প্রশ্ন ${id}`, text_en: `Question ${id}` },
  options: [
    { id: 'a', text_bn: 'ক', text_en: 'A' },
    { id: 'b', text_bn: 'খ', text_en: 'B', isCorrect: true },
  ],
  explanation: { bn: `ব্যাখ্যা ${id}`, en: `Explanation ${id}` },
  media_library: null,
  ...overrides,
});

test('exam history listing derives subjects and sequence without details_json', async () => {
  resetState();
  state.exam_history = [
    {
      id: 'history-2',
      user_id: 'user-1',
      exam_id: null,
      score: 1,
      total_marks: 2,
      correct_count: 1,
      wrong_count: 1,
      skipped_count: 0,
      time_taken: 10,
      submitted_at: '2026-10-18T12:00:00.000Z',
      created_at: '2026-10-18T12:00:00.000Z',
      status: 'completed',
      details_json: { questions: [{ id: 'q1', options: [SECRET] }] },
    },
    {
      id: 'history-1',
      user_id: 'user-1',
      exam_id: null,
      score: 2,
      total_marks: 3,
      correct_count: 1,
      wrong_count: 1,
      skipped_count: 1,
      time_taken: 20,
      submitted_at: '2026-10-17T12:00:00.000Z',
      created_at: '2026-10-17T12:00:00.000Z',
      status: 'completed',
      details_json: { questions: [{ id: 'q1', options: [SECRET] }] },
    },
  ];
  state.exam_history_details = [
    { id: 'd1', exam_history_id: 'history-1', question_id: 'q1', is_correct: true },
    { id: 'd2', exam_history_id: 'history-1', question_id: 'q2', is_correct: false },
    { id: 'd3', exam_history_id: 'history-2', question_id: 'q3', is_correct: true },
  ];
  state.questions = [
    { id: 'q1', subject_id: 'subject-1' },
    { id: 'q2', subject_id: 'subject-1' },
    { id: 'q3', subject_id: 'subject-2' },
  ];
  state.subjects = [
    { id: 'subject-1', name_bn: 'বাংলা', name_en: 'Bangla' },
    { id: 'subject-2', name_bn: 'গণিত', name_en: 'Math' },
  ];

  // The practice count comes from the shared mistake definition, not from the
  // stored attempt counters.
  state.mistake_rows = [
    makeMistakeRow('q2', { exam_history_id: 'history-1', status: 'wrong' }),
    makeMistakeRow('q1', { exam_history_id: 'history-1', status: 'skipped', selected_option: null }),
  ];

  const rows = await historyService.getUserExamHistory('user-1');
  const first = rows.find((row: Row) => row.id === 'history-1');
  const second = rows.find((row: Row) => row.id === 'history-2');

  assert.equal(rows.length, 2);
  assert.equal('details_json' in first, false);
  assert.equal(first.exam_sequence, 1);
  assert.equal(second.exam_sequence, 2);
  assert.equal(first.subject_name_en, 'Bangla');
  assert.equal(first.question_count, 3);
  assert.equal(first.wrong_available_count, 2);
  assert.equal(second.wrong_available_count, 0);
  assert.equal(second.subject_name_en, 'Math');
  assert.equal(state.selects.some((select: string) => select.includes('details_json')), false);
  assert.equal(JSON.stringify(rows).includes('secret-answer'), false);
});

const makeMistakeRow = (
  questionId: string,
  overrides: Row = {}
): Row => ({
  user_id: 'user-1',
  question_id: questionId,
  detail_id: `detail-${questionId}`,
  exam_history_id: 'history-2',
  exam_id: 'exam-1',
  status: 'wrong',
  selected_option: 'a',
  occurred_at: '2026-10-18T10:00:00.000Z',
  ...overrides,
});

test('the mistakes tab lists wrong AND skipped answers with a label for each', async () => {
  resetState();
  state.mistake_rows = [
    makeMistakeRow('q1', { status: 'wrong', selected_option: 'a' }),
    makeMistakeRow('q2', { status: 'skipped', selected_option: null }),
    makeMistakeRow('q3', {
      status: 'wrong',
      selected_option: 'b',
      occurred_at: '2026-10-18T11:00:00.000Z',
    }),
  ];
  state.questions = ['q1', 'q2', 'q3'].map((id) => makeQuestion(id));

  const rows = await historyService.getUserMistakes('user-1');

  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row: Row) => row.status).sort(),
    ['skipped', 'wrong', 'wrong']
  );

  const skipped = rows.find((row: Row) => row.id === 'q2');
  const wrong = rows.find((row: Row) => row.id === 'q1');
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.selected_option, null);
  assert.equal(wrong.status, 'wrong');
  assert.equal(wrong.selected_option, 'a');
  // Every card is hydrated with its question so the review preview renders.
  rows.forEach((row: Row) => {
    assert.ok(row.questions);
    assert.match(row.questions.body.text_en, /Question /);
  });
});

test('the mistakes tab never reads the legacy wrong_answers table', async () => {
  resetState();
  state.wrong_answers = [];
  state.mistake_rows = [makeMistakeRow('q1')];
  state.questions = [makeQuestion('q1')];

  const rows = await historyService.getUserMistakes('user-1');

  assert.equal(rows.length, 1);
  assert.equal(
    state.selects.some((select: string) => select.includes('wrong_answers')),
    false
  );
});

test('mistake reads are scoped to the verified session user', async () => {
  resetState();
  state.mistake_rows = [
    makeMistakeRow('q1'),
    makeMistakeRow('q2', { user_id: 'user-2' }),
  ];
  state.questions = [makeQuestion('q1'), makeQuestion('q2')];

  const rows = await historyService.getUserMistakes('user-1');
  const rpcCall = state.rpcCalls.find(
    (call) => call.name === 'user_mistake_questions'
  );

  assert.deepEqual(rows.map((row: Row) => row.id), ['q1']);
  assert.equal(rpcCall.args.p_user_id, 'user-1');
});

test('the practice count and the mistakes tab use the same rows', async () => {
  resetState();
  state.exam_history = [
    {
      id: 'history-2',
      user_id: 'user-1',
      exam_id: 'exam-1',
      score: 1,
      total_marks: 30,
      correct_count: 1,
      wrong_count: 3,
      skipped_count: 26,
      status: 'completed',
      submitted_at: '2026-10-18T12:00:00.000Z',
      created_at: '2026-10-18T12:00:00.000Z',
    },
    {
      id: 'history-1',
      user_id: 'user-1',
      exam_id: 'exam-1',
      score: 0,
      total_marks: 30,
      correct_count: 0,
      wrong_count: 1,
      skipped_count: 0,
      status: 'completed',
      submitted_at: '2026-10-17T12:00:00.000Z',
      created_at: '2026-10-17T12:00:00.000Z',
    },
  ];
  state.exam_history_details = [];

  // 3 wrong + 26 skipped = 29 canonical mistakes, one of them dismissed.
  const canonical = Array.from({ length: 28 }, (_, index) =>
    makeMistakeRow(`q${index + 1}`, {
      status: index < 3 ? 'wrong' : 'skipped',
      selected_option: index < 3 ? 'a' : null,
    })
  );
  state.mistake_rows = canonical;
  state.questions = canonical.map((row: Row) => makeQuestion(String(row.question_id)));

  const history = await historyService.getUserExamHistory('user-1');
  const mistakes = await historyService.getUserMistakes('user-1');
  const attemptTwo = history.find((row: Row) => row.id === 'history-2');
  const attemptOne = history.find((row: Row) => row.id === 'history-1');

  assert.equal(attemptTwo.wrong_available_count, 28);
  assert.equal(attemptTwo.wrong_available_count, mistakes.length);
  assert.equal(attemptOne.wrong_available_count, 0);
});

test('a failing mistake query is an error, never an empty mistake list', async () => {
  resetState();
  state.rpcErrors.user_mistake_questions = {
    code: '42P01',
    message: 'relation "public.user_mistake_questions" does not exist',
  };

  await assert.rejects(
    () => historyService.getUserMistakes('user-1'),
    (error: Row) => error.code === '42P01'
  );
});

test('a failing count query degrades to attempt counters instead of breaking history', async () => {
  resetState();
  state.exam_history = [
    {
      id: 'history-2',
      user_id: 'user-1',
      exam_id: 'exam-1',
      score: 1,
      total_marks: 30,
      correct_count: 1,
      wrong_count: 3,
      skipped_count: 26,
      status: 'completed',
      submitted_at: '2026-10-18T12:00:00.000Z',
      created_at: '2026-10-18T12:00:00.000Z',
    },
  ];
  state.rpcErrors.get_user_mistake_counts = {
    code: '42P01',
    message: 'function does not exist',
  };

  const history = await historyService.getUserExamHistory('user-1');

  assert.equal(history[0].wrong_available_count, 29);
});

test('bookmarks hydrate full question content and keep missing questions explicit', async () => {
  resetState();
  state.bookmarks = [
    { id: 'bookmark-1', user_id: 'user-1', question_id: 'q1', note: 'revise' },
    { id: 'bookmark-2', user_id: 'user-1', question_id: 'missing', note: null },
  ];
  state.questions = [makeQuestion('q1')];
  state.exam_paper_questions = [];

  const rows = await historyService.getUserBookmarks('user-1');

  assert.equal(rows.length, 2);
  const present = rows.find((row: Row) => row.id === 'bookmark-1');
  const missing = rows.find((row: Row) => row.id === 'bookmark-2');
  assert.equal(present.note, 'revise');
  assert.equal(present.questions.body.text_en, 'Question q1');
  assert.equal(present.questions.options.length, 2);
  assert.equal(present.questions.options[1].isCorrect, true);
  assert.equal(missing.questions, null);
});

test('bookmarks for a live exam paper never expose the answer key', async () => {
  resetState();
  state.bookmarks = [
    { id: 'bookmark-1', user_id: 'user-1', question_id: 'q1', note: null },
  ];
  state.questions = [makeQuestion('q1')];
  state.exam_paper_questions = [
    {
      question_id: 'q1',
      exam_papers: {
        exam_type: 'model_test',
        end_time: '2999-01-01T00:00:00.000Z',
        result_publish_time: '2999-01-01T00:00:00.000Z',
      },
    },
  ];

  const rows = await historyService.getUserBookmarks('user-1');
  const question = rows[0].questions;

  assert.equal(rows.length, 1);
  assert.equal(question.explanation, null);
  question.options.forEach((option: Row) => {
    assert.equal('isCorrect' in option, false);
  });
});

test('without the dismissal table, deleting a mistake still persists the dismissal', async () => {
  resetState();
  state.missingTables = ['mistake_dismissals'];
  state.profiles = [{ id: 'user-1', settings: { theme: 'dark' } }];
  state.mistake_rows = [makeMistakeRow('q1'), makeMistakeRow('q2')];

  await historyService.deleteMistakeRecord('q1', 'user-1');
  const settings = state.profiles[0].settings;
  assert.equal(settings.theme, 'dark');
  assert.equal(typeof settings.mistake_dismissals.q1, 'string');

  // The shared SQL definition is the only filter; dismissing q1 hides it.
  state.mistake_rows = [makeMistakeRow('q2')];
  const rows = await historyService.getUserMistakes('user-1');
  assert.deepEqual(rows.map((row: Row) => row.id), ['q2']);
});

test('deleting a mistake persists a question-level dismissal', async () => {
  resetState();
  state.wrong_answers = [
    { id: 'legacy-1', user_id: 'user-1', question_id: 'q1', selected_option: 'a' },
  ];
  state.mistake_dismissals = [];

  const result = await historyService.deleteMistakeRecord('legacy-1', 'user-1');

  assert.equal(result, true);
  assert.equal(state.wrong_answers.length, 0);
  assert.equal(state.mistake_dismissals.length, 1);
  assert.equal(state.mistake_dismissals[0].question_id, 'q1');
  assert.equal(state.mistake_dismissals[0].user_id, 'user-1');
});
