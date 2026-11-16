import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * Regression coverage for the set-based sweeper.
 *
 * The sweeper used to issue one UPDATE per expired attempt. It now issues a
 * single guarded statement, so the tests assert both the outcome and the round
 * trip count: a batch of N attempts must still cost exactly one write.
 */

type Row = Record<string, any>;
type Op = { column: string; op: 'eq' | 'lt' | 'in' | 'select'; value: any };

const state: { attempts: Row[]; updateCalls: number; selectCalls: number } = {
  attempts: [],
  updateCalls: 0,
  selectCalls: 0,
};

const matches = (row: Row, ops: Op[]): boolean =>
  ops.every(({ column, op, value }) => {
    if (op === 'in') return (value as any[]).map(String).includes(String(row[column]));
    if (op === 'lt') {
      const actual = Date.parse(String(row[column]));
      const boundary = Date.parse(String(value));
      return Number.isFinite(actual) && actual < boundary;
    }
    return String(row[column]) === String(value);
  });

const createBuilder = (table: string) => {
  const ops: Op[] = [];
  let patch: Row | null = null;

  const resolve = () => {
    if (table !== 'exam_progress') return { data: [], error: null };

    const rows = state.attempts.filter((row) => matches(row, ops));

    if (patch) {
      state.updateCalls += 1;
      rows.forEach((row) => Object.assign(row, patch));
      return { data: rows.map((row) => ({ id: row.id })), error: null };
    }

    state.selectCalls += 1;
    return { data: rows, error: null };
  };

  const builder: any = {
    select: () => builder,
    eq: (column: string, value: any) => {
      ops.push({ column, op: 'eq', value });
      return builder;
    },
    lt: (column: string, value: any) => {
      ops.push({ column, op: 'lt', value });
      return builder;
    },
    in: (column: string, values: any[]) => {
      ops.push({ column, op: 'in', value: values });
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    update: (values: Row) => {
      patch = values;
      return builder;
    },
    maybeSingle: async () => resolve(),
    single: async () => resolve(),
    then: (onFulfilled: any, onRejected: any) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
  };

  return builder;
};

const fakeSupabase = {
  from: (table: string) => createBuilder(table),
  rpc: async () => ({ data: null, error: null }),
};

const nodeRequire = createRequire(__filename);
const supabaseConfigPath = nodeRequire.resolve('../config/supabase');

nodeRequire.cache[supabaseConfigPath] = {
  id: supabaseConfigPath,
  filename: supabaseConfigPath,
  loaded: true,
  exports: { supabase: fakeSupabase },
} as any;

const { sweepExpiredAttempts } = nodeRequire('./exam.sweeper.job') as {
  sweepExpiredAttempts: (nowMs?: number) => Promise<number>;
};

const NOW = Date.parse('2026-11-16T10:00:00.000Z');
const ANCIENT = new Date(NOW - 60 * 60 * 1000).toISOString();
const FUTURE = new Date(NOW + 60 * 60 * 1000).toISOString();

beforeEach(() => {
  state.attempts = [];
  state.updateCalls = 0;
  state.selectCalls = 0;
});

test('a batch of expired attempts is expired with one write', async () => {
  state.attempts = [
    { id: 'a-1', status: 'in_progress', deadline_at: ANCIENT },
    { id: 'a-2', status: 'in_progress', deadline_at: ANCIENT },
    { id: 'a-3', status: 'in_progress', deadline_at: ANCIENT },
    { id: 'a-4', status: 'in_progress', deadline_at: FUTURE },
    { id: 'a-5', status: 'submitted', deadline_at: ANCIENT },
  ];

  const expired = await sweepExpiredAttempts(NOW);

  assert.equal(expired, 3);
  assert.equal(state.updateCalls, 1, 'expected a single set-based UPDATE');

  const byId = new Map(state.attempts.map((row) => [row.id, row]));
  assert.equal(byId.get('a-1')?.status, 'expired');
  assert.equal(byId.get('a-2')?.status, 'expired');
  assert.equal(byId.get('a-3')?.status, 'expired');
  // A live attempt is never expired, and a submitted one is never touched.
  assert.equal(byId.get('a-4')?.status, 'in_progress');
  assert.equal(byId.get('a-5')?.status, 'submitted');
});

test('an attempt inside the submission grace window is left in progress', async () => {
  state.attempts = [
    // Just past the deadline: still inside the default grace window.
    { id: 'b-1', status: 'in_progress', deadline_at: new Date(NOW - 5_000).toISOString() },
  ];

  const expired = await sweepExpiredAttempts(NOW);

  assert.equal(expired, 0);
  assert.equal(state.attempts[0].status, 'in_progress');
  assert.equal(state.updateCalls, 0, 'no write is issued when nothing is eligible');
});

test('a second sweep is a no-op, so overlapping runs stay harmless', async () => {
  state.attempts = [{ id: 'c-1', status: 'in_progress', deadline_at: ANCIENT }];

  assert.equal(await sweepExpiredAttempts(NOW), 1);
  assert.equal(await sweepExpiredAttempts(NOW), 0);
});
