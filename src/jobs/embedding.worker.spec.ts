import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * Regression coverage for the embedding worker.
 *
 * The worker used to select its batch with an unordered
 * `is_embedding_stale = true LIMIT 12` scan, which was the largest
 * app-attributable cost in the database audit. The batch is now ordered by id
 * (so the partial index on `(id) WHERE is_embedding_stale = true` is used and a
 * batch is deterministic) and still relies on the per-row `false` write for
 * forward progress — no keyset cursor is persisted.
 *
 * These tests pin that contract: exactly one batch of 12, oldest id first, every
 * eligible question processed once, failures retried on the next run (never
 * dropped, never re-processed after success), and no change to the existing
 * update payloads, matching RPC arguments or rate-limit pause.
 */

type Row = Record<string, any>;
type Eq = { column: string; value: any };

const state: {
  questions: Row[];
  rpcResponse: { data: any; error: any };
  rpcCalls: { name: string; args: any }[];
  orderCalls: { column: string; ascending?: boolean }[];
  limitCalls: number[];
  updates: { ids: string[]; patch: Row }[];
  embedCalls: string[];
  embeddingFactory: (text: string) => number[];
  delays: number[];
  cronExpr: string | null;
} = {
  questions: [],
  rpcResponse: { data: [], error: null },
  rpcCalls: [],
  orderCalls: [],
  limitCalls: [],
  updates: [],
  embedCalls: [],
  embeddingFactory: () => [0.1, 0.2, 0.3],
  delays: [],
  cronExpr: null,
};

const matches = (row: Row, ops: Eq[]): boolean =>
  ops.every(({ column, value }) => String(row[column]) === String(value));

const createBuilder = (table: string) => {
  const ops: Eq[] = [];
  let patch: Row | null = null;
  let order: { column: string; ascending?: boolean } | null = null;
  let limit: number | null = null;

  const resolve = () => {
    if (table !== 'questions') return { data: [], error: null };

    const selected = state.questions.filter((row) => matches(row, ops));

    if (patch) {
      state.updates.push({ ids: selected.map((row) => row.id), patch });
      selected.forEach((row) => Object.assign(row, patch));
      return { data: null, error: null };
    }

    let rows = [...selected];

    if (order) {
      const { column, ascending } = order;
      rows.sort((a, b) => {
        const left = String(a[column]);
        const right = String(b[column]);
        const cmp = left < right ? -1 : left > right ? 1 : 0;
        return ascending === false ? -cmp : cmp;
      });
    }

    if (limit !== null) rows = rows.slice(0, limit);

    return {
      data: rows.map((row) => ({
        id: row.id,
        body: row.body,
        explanation: row.explanation,
        subject_id: row.subject_id,
      })),
      error: null,
    };
  };

  const builder: any = {
    select: () => builder,
    eq: (column: string, value: any) => {
      ops.push({ column, value });
      return builder;
    },
    order: (column: string, options?: { ascending?: boolean }) => {
      order = { column, ascending: options?.ascending };
      state.orderCalls.push(order);
      return builder;
    },
    limit: (value: number) => {
      limit = value;
      state.limitCalls.push(value);
      return builder;
    },
    update: (values: Row) => {
      patch = values;
      return builder;
    },
    maybeSingle: async () => resolve(),
    single: async () => resolve(),
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected),
  };

  return builder;
};

const fakeSupabaseAdmin = {
  from: (table: string) => createBuilder(table),
  rpc: async (name: string, args: any) => {
    state.rpcCalls.push({ name, args });
    return state.rpcResponse;
  },
};

const fakeLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};

const nodeRequire = createRequire(__filename);

const stub = (request: string, exports: any) => {
  const resolved = nodeRequire.resolve(request);
  nodeRequire.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  } as any;
};

stub('../config/supabaseAdmin', { supabaseAdmin: fakeSupabaseAdmin });
stub('../lib/utils/logger', { __esModule: true, default: fakeLogger });
stub('../features/ai/ai.service', {
  generateVectorEmbedding: async (text: string) => {
    state.embedCalls.push(text);
    return state.embeddingFactory(text);
  },
});
stub('node-cron', {
  __esModule: true,
  default: {
    schedule: (expression: string) => {
      state.cronExpr = expression;
      return { stop: () => {} };
    },
  },
});

const worker = nodeRequire('./embedding.worker') as {
  processStaleEmbeddings: (options?: {
    delay?: (ms: number) => Promise<void>;
  }) => Promise<void>;
  startEmbeddingWorker: () => void;
};

const delay = async (ms: number) => {
  state.delays.push(ms);
};

const run = () => worker.processStaleEmbeddings({ delay });

const staleIds = () => state.questions.filter((q) => q.is_embedding_stale === true).map((q) => q.id);

const question = (id: string, overrides: Row = {}): Row => ({
  id,
  body: { bn: `প্রশ্ন ${id}`, en: `Question ${id}` },
  explanation: { bn: `ব্যাখ্যা ${id}`, en: `Explanation ${id}` },
  subject_id: 'sub-1',
  is_embedding_stale: true,
  status: 'pending',
  ...overrides,
});

beforeEach(() => {
  state.questions = [];
  state.rpcResponse = { data: [], error: null };
  state.rpcCalls = [];
  state.orderCalls = [];
  state.limitCalls = [];
  state.updates = [];
  state.embedCalls = [];
  state.delays = [];
  state.cronExpr = null;
  state.embeddingFactory = () => [0.1, 0.2, 0.3];
});

test('selects one ordered batch of 12 and skips questions that are not stale', async () => {
  for (let i = 1; i <= 20; i += 1) state.questions.push(question(`q-${String(i).padStart(2, '0')}`));
  state.questions.push(question('q-99', { is_embedding_stale: false }));

  await run();

  assert.deepEqual(state.orderCalls, [{ column: 'id', ascending: true }], 'batch must be ordered by id');
  assert.deepEqual(state.limitCalls, [12], 'the existing batch size of 12 must be preserved');
  assert.deepEqual(
    state.updates.map((u) => u.ids.join(',')),
    Array.from({ length: 12 }, (_, i) => `q-${String(i + 1).padStart(2, '0')}`),
    'exactly the first 12 stale questions, in id order, are processed'
  );
  assert.equal(state.questions.find((q) => q.id === 'q-99')?.is_embedding_stale, false);
  assert.equal(state.embedCalls.length, 12);
  assert.deepEqual(state.delays, Array(12).fill(4000), 'the 4s per-question pacing is preserved');
});

test('a second run continues with the remaining stale questions instead of repeating the batch', async () => {
  for (let i = 1; i <= 20; i += 1) state.questions.push(question(`q-${String(i).padStart(2, '0')}`));

  await run();
  assert.equal(staleIds().length, 8);

  await run();

  assert.deepEqual(staleIds(), [], 'every eligible question is eventually processed');
  const processed = state.updates.flatMap((u) => u.ids);
  assert.equal(processed.length, 20);
  assert.equal(new Set(processed).size, 20, 'no question is processed twice');
});

test('a question that becomes stale during a run is picked up by the next run', async () => {
  state.questions = [question('q-05')];

  let injected = false;
  state.embeddingFactory = (text: string) => {
    if (!injected) {
      injected = true;
      // A concurrent import publishes a newer question with a LOWER id while the
      // batch is still being processed. Without a persisted cursor it must still
      // be seen by the following run.
      state.questions.push(question('q-00'));
    }
    return [0.4, 0.5, 0.6];
  };

  await run();
  assert.deepEqual(staleIds(), ['q-00']);

  await run();
  assert.deepEqual(staleIds(), [], 'the late arrival is processed on the next run');
});

test('a successful embedding marks the question fresh and publishes it', async () => {
  state.questions = [question('q-01')];

  await run();

  assert.equal(state.updates.length, 1);
  const { ids, patch } = state.updates[0];
  assert.deepEqual(ids, ['q-01']);
  assert.equal(patch.is_embedding_stale, false);
  assert.equal(patch.status, 'published');
  assert.equal(patch.confidence_score, 95);
  assert.equal(patch.embedding, JSON.stringify([0.1, 0.2, 0.3]));
  assert.equal(typeof patch.embedding_updated_at, 'string');

  assert.deepEqual(state.rpcCalls, [
    {
      name: 'match_questions',
      args: { query_embedding: JSON.stringify([0.1, 0.2, 0.3]), match_threshold: 0.85, match_count: 2 },
    },
  ]);
});

test('a near-duplicate match flags the question for review instead of publishing', async () => {
  state.questions = [question('q-01')];
  state.rpcResponse = { data: [{ id: 'q-other', similarity: 0.93 }], error: null };

  await run();

  const { patch } = state.updates[0];
  assert.equal(patch.is_embedding_stale, false);
  assert.equal(patch.status, 'pending');
  assert.equal(patch.confidence_score, 65);
  assert.match(String(patch.audit_notes), /q-other/);
  assert.match(String(patch.audit_notes), /93\.0%/);
});

test('a match RPC error still stores the embedding and publishes', async () => {
  state.questions = [question('q-01')];
  state.rpcResponse = { data: null, error: { message: 'rpc failed' } };

  await run();

  const { patch } = state.updates[0];
  assert.equal(patch.is_embedding_stale, false);
  assert.equal(patch.status, 'published');
  assert.equal(patch.confidence_score, 95);
});

test('a failed embedding leaves the question stale, keeps the batch going and retries next run', async () => {
  state.questions = [question('q-01'), question('q-02')];

  state.embeddingFactory = (text: string) => {
    if (text.includes('q-01')) throw new Error('embedding provider unavailable');
    return [0.7, 0.8, 0.9];
  };

  await run();

  const byId = new Map(state.questions.map((row) => [row.id, row]));
  assert.equal(byId.get('q-01')?.is_embedding_stale, true, 'a failure must not mark the question fresh');
  assert.equal(byId.get('q-02')?.is_embedding_stale, false, 'the rest of the batch still runs');
  assert.deepEqual(state.updates.map((u) => u.ids.join(',')), ['q-02']);

  // Retry behaviour is unchanged: the failed row is picked up again.
  state.embeddingFactory = () => [0.1, 0.1, 0.1];
  await run();
  assert.equal(byId.get('q-01')?.is_embedding_stale, false);
});

test('a rate-limited embedding pauses for one minute and keeps the question pending', async () => {
  state.questions = [question('q-01')];
  state.embeddingFactory = () => {
    throw new Error('429 Too Many Requests');
  };

  await run();

  assert.deepEqual(state.delays, [60000], 'the existing 60s rate-limit pause is preserved');
  assert.equal(state.questions[0].is_embedding_stale, true);
  assert.equal(state.updates.length, 0);
});

test('the worker still schedules every five minutes', () => {
  worker.startEmbeddingWorker();

  assert.equal(state.cronExpr, '*/5 * * * *');
});
