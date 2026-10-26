import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

type Row = Record<string, any>;

const state: {
  examHistory: Row[];
  mistakes: Row[];
  selects: string[];
} = {
  examHistory: [],
  mistakes: [],
  selects: [],
};

const project = (row: Row, columns: string): Row => {
  if (columns.trim() === '*') return row;

  const picked: Row = {};
  columns.split(',').map((column) => column.trim()).forEach((column) => {
    if (column in row) picked[column] = row[column];
  });

  return picked;
};

const createBuilder = (table: string) => {
  let columns = '*';

  const builder: any = {
    select: (selected: string = '*') => {
      columns = String(selected);
      state.selects.push(columns);
      return builder;
    },
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    is: () => builder,
    then: (onFulfilled: any, onRejected: any) => {
      const source = table === 'exam_history' ? state.examHistory : state.mistakes;
      // The mistakes join column list is not a flat projection, so return the
      // stored rows and let the service perform the field stripping under test.
      const rows =
        table === 'exam_history'
          ? source.map((row) => project(row, columns))
          : source.map((row) => ({ ...row }));
      return Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
    },
  };

  return builder;
};

const fakeSupabase = {
  from: (table: string) => createBuilder(table),
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

test('exam history listing never returns details_json or answer keys', async () => {
  state.examHistory = [
    {
      id: 'history-1',
      user_id: 'user-1',
      exam_id: 'exam-1',
      score: 1,
      total_marks: 2,
      correct_count: 1,
      wrong_count: 1,
      skipped_count: 0,
      time_taken: 10,
      submitted_at: '2026-10-18T12:00:00.000Z',
      created_at: '2026-10-18T12:00:00.000Z',
      status: 'submitted',
      details_json: {
        questions: [{ id: 'q1', options: [{ id: 'a', ...SECRET }], explanation: 'secret' }],
      },
    },
  ];

  const rows = await historyService.getUserExamHistory('user-1');

  assert.equal(rows.length, 1);
  assert.equal('details_json' in rows[0], false);
  assert.equal(state.selects.some((select: string) => select.includes('details_json')), false);
  assert.equal(JSON.stringify(rows).includes('secret'), false);
});

test('mistakes listing strips explanations and option correctness flags', async () => {
  state.mistakes = [
    {
      id: 'mistake-1',
      selected_option: 'a',
      question_id: 'q1',
      questions: {
        id: 'q1',
        body: { text_bn: 'প্রশ্ন' },
        options: [
          { id: 'a', text_bn: 'ক', ...SECRET },
          { id: 'b', text_bn: 'খ', ...SECRET },
        ],
        explanation: 'protected explanation',
      },
    },
  ];

  const rows = await historyService.getUserMistakes('user-1');

  assert.equal(rows.length, 1);
  assert.equal(state.selects.some((select: string) => select.includes('explanation')), false);
  assert.equal('explanation' in rows[0].questions, false);
  assert.equal(rows[0].questions.options.length, 2);
  rows[0].questions.options.forEach((option: Row) => {
    assert.deepEqual(Object.keys(option).sort(), ['id', 'image_url', 'text_bn', 'text_en']);
  });
  assert.equal(JSON.stringify(rows).includes('protected explanation'), false);
  assert.equal(JSON.stringify(rows).includes('secret-answer'), false);
});
