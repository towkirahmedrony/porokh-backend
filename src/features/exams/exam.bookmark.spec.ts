import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

type Row = Record<string, any>;

const state: {
  questions: Row[];
  bookmarks: Row[];
  failNextWrite: boolean;
  calls: string[];
} = {
  questions: [],
  bookmarks: [],
  failNextWrite: false,
  calls: [],
};

const same = (a: unknown, b: unknown) => String(a) === String(b);

const createBuilder = (table: string) => {
  const filters: Record<string, any> = {};
  let inserted: Row[] | null = null;
  let upserted: Row[] | null = null;
  let ignoreDuplicates = false;
  let deleting = false;
  let mode: 'many' | 'single' = 'many';

  const rowsForTable = (): Row[] => {
    if (table === 'questions') return state.questions;
    if (table === 'bookmarks') return state.bookmarks;
    return [];
  };

  const matches = (row: Row): boolean =>
    Object.entries(filters).every(([column, value]) => {
      if (Array.isArray(value)) {
        return value.some((candidate) => same(row[column], candidate));
      }
      return same(row[column], value);
    });

  const resolve = () => {
    state.calls.push(`${table}:${deleting ? 'delete' : upserted ? 'upsert' : inserted ? 'insert' : 'select'}`);

    if (deleting) {
      if (state.failNextWrite) {
        state.failNextWrite = false;
        return { data: null, error: { message: 'simulated delete failure' } };
      }

      const removed = state.bookmarks.filter(matches);
      state.bookmarks = state.bookmarks.filter((row) => !matches(row));
      return { data: mode === 'single' ? removed[0] ?? null : removed, error: null };
    }

    if (upserted) {
      if (state.failNextWrite) {
        state.failNextWrite = false;
        return { data: null, error: { message: 'simulated upsert failure' } };
      }

      const stored: Row[] = [];
      upserted.forEach((row) => {
        const existing = state.bookmarks.find(
          (item) =>
            same(item.user_id, row.user_id) && same(item.question_id, row.question_id)
        );

        if (existing) {
          if (ignoreDuplicates) {
            stored.push(existing);
            return;
          }
          Object.assign(existing, row);
          stored.push(existing);
          return;
        }

        const created = {
          id: `bookmark-${state.bookmarks.length + 1}`,
          created_at: new Date().toISOString(),
          ...row,
        };
        state.bookmarks.push(created);
        stored.push(created);
      });

      return { data: mode === 'single' ? stored[0] ?? null : stored, error: null };
    }

    if (inserted) {
      const created = inserted.map((row) => ({
        id: `bookmark-${state.bookmarks.length + 1}`,
        created_at: new Date().toISOString(),
        ...row,
      }));
      state.bookmarks.push(...created);
      return { data: mode === 'single' ? created[0] ?? null : created, error: null };
    }

    const rows = rowsForTable().filter(matches);
    return { data: mode === 'single' ? rows[0] ?? null : rows, error: null };
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
    insert: (rows: Row[] | Row) => {
      inserted = Array.isArray(rows) ? rows : [rows];
      return builder;
    },
    upsert: (rows: Row[] | Row, options?: Row) => {
      upserted = Array.isArray(rows) ? rows : [rows];
      ignoreDuplicates = options?.ignoreDuplicates === true;
      return builder;
    },
    delete: () => {
      deleting = true;
      return builder;
    },
    maybeSingle: async () => {
      mode = 'single';
      return resolve();
    },
    single: async () => {
      mode = 'single';
      return resolve();
    },
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected),
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

const bookmarkService = require('./exam.bookmark.service');

const QUESTION_ID = '3f1c2b9e-1a2b-4c3d-8e4f-1234567890ab';
const OTHER_QUESTION_ID = '4f1c2b9e-1a2b-4c3d-8e4f-1234567890ab';
const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';

beforeEach(() => {
  state.questions = [
    { id: QUESTION_ID },
    { id: OTHER_QUESTION_ID },
  ];
  state.bookmarks = [];
  state.failNextWrite = false;
  state.calls = [];
});

test('bookmarking is idempotent and keeps a single row per user/question', async () => {
  const first = await bookmarkService.setBookmark(USER_ID, QUESTION_ID, true);
  const second = await bookmarkService.setBookmark(USER_ID, QUESTION_ID, true);

  assert.equal(first.bookmarked, true);
  assert.equal(second.bookmarked, true);
  assert.equal(state.bookmarks.length, 1);
  assert.equal(state.bookmarks[0].user_id, USER_ID);
  assert.equal(state.bookmarks[0].question_id, QUESTION_ID);
});

test('removing a bookmark only deletes the current user row', async () => {
  state.bookmarks = [
    { id: 'mine', user_id: USER_ID, question_id: QUESTION_ID },
    { id: 'theirs', user_id: OTHER_USER_ID, question_id: QUESTION_ID },
  ];

  const result = await bookmarkService.setBookmark(USER_ID, QUESTION_ID, false);

  assert.equal(result.bookmarked, false);
  assert.deepEqual(state.bookmarks.map((row) => row.id), ['theirs']);
});

test('omitting the desired state keeps the legacy toggle contract', async () => {
  const created = await bookmarkService.setBookmark(USER_ID, QUESTION_ID);
  const removed = await bookmarkService.setBookmark(USER_ID, QUESTION_ID);

  assert.equal(created.bookmarked, true);
  assert.equal(removed.bookmarked, false);
  assert.equal(state.bookmarks.length, 0);
});

test('invalid, missing and unauthenticated requests are rejected safely', async () => {
  await assert.rejects(
    bookmarkService.setBookmark(USER_ID, 'not-a-uuid', true),
    (error: any) => error.status === 400
  );

  await assert.rejects(
    bookmarkService.setBookmark(USER_ID, '9f1c2b9e-1a2b-4c3d-8e4f-1234567890ab', true),
    (error: any) => error.status === 404
  );

  await assert.rejects(
    bookmarkService.setBookmark('', QUESTION_ID, true),
    (error: any) => error.status === 401
  );
});

test('bookmark listing is scoped to the authenticated user', async () => {
  state.bookmarks = [
    { id: '1', user_id: USER_ID, question_id: QUESTION_ID },
    { id: '2', user_id: OTHER_USER_ID, question_id: OTHER_QUESTION_ID },
    { id: '3', user_id: USER_ID, question_id: OTHER_QUESTION_ID },
  ];

  const ids = await bookmarkService.getBookmarkQuestionIds(USER_ID, [QUESTION_ID, OTHER_QUESTION_ID]);

  assert.deepEqual(ids.sort(), [QUESTION_ID, OTHER_QUESTION_ID].sort());
  assert.equal(ids.includes(OTHER_QUESTION_ID), true);
  assert.equal(state.bookmarks.length, 3);
});

test('database failures surface as safe server errors', async () => {
  state.failNextWrite = true;

  await assert.rejects(
    bookmarkService.setBookmark(USER_ID, QUESTION_ID, true),
    (error: any) => error.status === 500 && !/simulated upsert failure/.test(error.message)
  );
});
