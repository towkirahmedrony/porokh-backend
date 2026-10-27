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
  assert.equal(second.subject_name_en, 'Math');
  assert.equal(state.selects.some((select: string) => select.includes('details_json')), false);
  assert.equal(JSON.stringify(rows).includes('secret-answer'), false);
});

test('mistakes use the latest response per question and respect newer dismissals', async () => {
  resetState();
  state.exam_history = [
    {
      id: 'history-1',
      user_id: 'user-1',
      status: 'completed',
      submitted_at: '2026-10-18T12:00:00.000Z',
      created_at: '2026-10-18T12:00:00.000Z',
    },
  ];
  state.exam_history_details = [
    {
      id: 'd1',
      exam_history_id: 'history-1',
      question_id: 'q1',
      selected_option: 'a',
      is_correct: false,
      created_at: '2026-10-18T10:00:00.000Z',
    },
    {
      id: 'd2',
      exam_history_id: 'history-1',
      question_id: 'q1',
      selected_option: 'b',
      is_correct: false,
      created_at: '2026-10-18T10:10:00.000Z',
    },
    {
      id: 'd3',
      exam_history_id: 'history-1',
      question_id: 'q2',
      selected_option: 'a',
      is_correct: true,
      created_at: '2026-10-18T10:00:00.000Z',
    },
    {
      id: 'd4',
      exam_history_id: 'history-1',
      question_id: 'q3',
      selected_option: 'a',
      is_correct: false,
      created_at: '2026-10-18T10:00:00.000Z',
    },
    {
      id: 'd5',
      exam_history_id: 'history-1',
      question_id: 'q3',
      selected_option: 'b',
      is_correct: true,
      created_at: '2026-10-18T10:05:00.000Z',
    },
    {
      id: 'd6',
      exam_history_id: 'history-1',
      question_id: 'q4',
      selected_option: 'a',
      is_correct: false,
      created_at: '2026-10-18T10:00:00.000Z',
    },
    {
      id: 'd7',
      exam_history_id: 'history-1',
      question_id: 'q5',
      selected_option: 'a',
      is_correct: false,
      created_at: '2026-10-18T10:00:00.000Z',
    },
  ];
  state.questions = ['q1', 'q2', 'q3', 'q4', 'q5'].map((id) => makeQuestion(id));
  state.mistake_dismissals = [
    {
      user_id: 'user-1',
      question_id: 'q4',
      created_at: '2026-10-18T10:20:00.000Z',
    },
    {
      user_id: 'user-1',
      question_id: 'q5',
      created_at: '2026-10-18T09:00:00.000Z',
    },
  ];

  const rows = await historyService.getUserMistakes('user-1');
  const ids = rows.map((row: Row) => row.id).sort();

  assert.deepEqual(ids, ['q1', 'q5']);
  const q1 = rows.find((row: Row) => row.id === 'q1');
  const q5 = rows.find((row: Row) => row.id === 'q5');
  assert.equal(q1.selected_option, 'b');
  assert.equal(q1.detail_id, 'd2');
  assert.equal(q5.detail_id, 'd7');
  const correctOption = q1.questions.options.find((option: Row) => option.isCorrect === true);
  assert.ok(correctOption);
  assert.match(q1.questions.explanation.en, /Explanation q1/);
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

test('without the dismissal table, profile settings keep the feature working', async () => {
  resetState();
  state.missingTables = ['mistake_dismissals'];
  state.profiles = [{ id: 'user-1', settings: { theme: 'dark' } }];
  state.exam_history = [
    {
      id: 'history-1',
      user_id: 'user-1',
      status: 'completed',
      submitted_at: '2026-10-18T12:00:00.000Z',
      created_at: '2026-10-18T12:00:00.000Z',
    },
  ];
  state.exam_history_details = [
    {
      id: 'd1',
      exam_history_id: 'history-1',
      question_id: 'q1',
      selected_option: 'a',
      is_correct: false,
      created_at: '2026-10-18T10:00:00.000Z',
    },
    {
      id: 'd2',
      exam_history_id: 'history-1',
      question_id: 'q2',
      selected_option: 'a',
      is_correct: false,
      created_at: '2026-10-18T10:00:00.000Z',
    },
  ];
  state.questions = [makeQuestion('q1'), makeQuestion('q2')];

  await historyService.deleteMistakeRecord('q1', 'user-1');
  const settings = state.profiles[0].settings;
  assert.equal(settings.theme, 'dark');
  assert.equal(typeof settings.mistake_dismissals.q1, 'string');

  state.profiles[0].settings = {
    ...settings,
    mistake_dismissals: {
      ...settings.mistake_dismissals,
      q2: '2026-10-18T10:20:00.000Z',
    },
  };

  const rows = await historyService.getUserMistakes('user-1');
  assert.deepEqual(rows, []);
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
