import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

type Row = Record<string, any>;

const state: {
  notices: Row[];
  reads: Row[];
  visible: Row[];
  unread: number;
  recipients: string[];
  rpcCalls: Array<{ name: string; args: Row }>;
  nextId: number;
} = {
  notices: [],
  reads: [],
  visible: [],
  unread: 0,
  recipients: [],
  rpcCalls: [],
  nextId: 1,
};

const createBuilder = (table: string) => {
  const filters: Array<[string, unknown]> = [];
  let action: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  let payload: Row | null = null;
  let firstOnly = false;

  const matches = (row: Row) =>
    filters.every(([column, value]) => row[column] === value);

  const resolve = (): { data: Row | Row[] | null; error: null } => {
    if (action === 'insert' && payload) {
      const created = { id: `n${state.nextId++}`, ...payload };
      state.notices.push(created);
      return { data: created, error: null };
    }

    if (action === 'update' && payload) {
      const updated = state.notices.filter(matches);
      updated.forEach((row) => Object.assign(row, payload));
      return { data: updated[0] ?? null, error: null };
    }

    if (action === 'delete') {
      state.notices = state.notices.filter((row) => !matches(row));
      return { data: null, error: null };
    }

    if (action === 'upsert' && payload) {
      const existing = state.reads.find(
        (row) => row.user_id === payload!.user_id && row.notice_id === payload!.notice_id
      );
      if (existing) Object.assign(existing, payload);
      else state.reads.push({ id: `r${state.reads.length + 1}`, ...payload });
      return { data: null, error: null };
    }

    if (table === 'notices') {
      return { data: state.notices.filter(matches), error: null };
    }

    return { data: [], error: null };
  };

  const builder: any = {
    select: () => builder,
    insert: (row: Row) => {
      action = 'insert';
      payload = row;
      return builder;
    },
    update: (row: Row) => {
      action = 'update';
      payload = row;
      return builder;
    },
    delete: () => {
      action = 'delete';
      return builder;
    },
    upsert: (row: Row) => {
      action = 'upsert';
      payload = row;
      return builder;
    },
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    },
    order: () => builder,
    maybeSingle: () => {
      firstOnly = true;
      return builder;
    },
    single: () => {
      firstOnly = true;
      return builder;
    },
    then: (onFulfilled: any, onRejected: any) => {
      const result = resolve();
      const data = firstOnly && Array.isArray(result.data)
        ? result.data[0] ?? null
        : result.data;
      return Promise.resolve({ ...result, data }).then(onFulfilled, onRejected);
    },
  };

  return builder;
};

const fakeSupabase = {
  from: (table: string) => createBuilder(table),
  rpc: async (name: string, args: Row) => {
    state.rpcCalls.push({ name, args });

    if (name === 'get_notices_for_user') {
      return { data: state.visible, error: null };
    }
    if (name === 'get_unread_notice_count_for_user') {
      return { data: state.unread, error: null };
    }
    if (name === 'get_notice_target_user_ids') {
      return { data: state.recipients, error: null };
    }

    return { data: null, error: { message: 'unexpected rpc' } };
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

const NoticeService = require('./notices.service') as typeof import('./notices.service');
const { NoticeValidationError } = require('./notices.validation') as typeof import('./notices.validation');

beforeEach(() => {
  state.notices = [];
  state.reads = [];
  state.visible = [];
  state.unread = 0;
  state.recipients = [];
  state.rpcCalls = [];
  state.nextId = 1;
});

test('create normalizes defaults and validates the expiry window', async () => {
  const notice = await NoticeService.createNotice(
    {
      title_bn: 'নোটিশ',
      body_bn: 'বিস্তারিত',
      published_at: '2026-10-29T10:00:00.000Z',
      expires_at: '2026-10-30T10:00:00.000Z',
    },
    'admin-1'
  );

  assert.equal(notice.priority, 'normal');
  assert.equal(notice.is_active, true);
  assert.deepEqual(notice.target_rules, {});
  assert.equal(notice.created_by, 'admin-1');
  assert.equal(state.notices.length, 1);

  await assert.rejects(
    NoticeService.createNotice(
      {
        title_bn: 'নোটিশ',
        body_bn: 'বিস্তারিত',
        published_at: '2026-10-29T10:00:00.000Z',
        expires_at: '2026-10-29T09:00:00.000Z',
      },
      'admin-1'
    ),
    NoticeValidationError
  );
});

test('list returns pagination metadata from the RPC', async () => {
  state.visible = [
    {
      id: 'n1',
      title_bn: 'ক',
      priority: 'urgent',
      is_read: false,
      is_dismissed: false,
      total_count: 3,
    },
  ];

  const result = await NoticeService.listNoticesForUser('user-1', { limit: 10, offset: 20 });

  assert.equal(result.total, 3);
  assert.equal(result.limit, 10);
  assert.equal(result.offset, 20);
  assert.equal(result.items[0].id, 'n1');
  assert.equal(state.rpcCalls[0].args.p_limit, 10);
  assert.equal(state.rpcCalls[0].args.p_offset, 20);
});

test('mark read upserts only the read timestamp', async () => {
  state.visible = [
    { id: 'n1', title_bn: 'ক', priority: 'normal', is_read: false, is_dismissed: false },
  ];

  await NoticeService.markNoticeRead('user-1', 'n1');

  assert.equal(state.reads.length, 1);
  assert.equal(state.reads[0].user_id, 'user-1');
  assert.equal(state.reads[0].notice_id, 'n1');
  assert.ok(state.reads[0].read_at);
  assert.equal(state.reads[0].dismissed_at, undefined);
});

test('dismiss writes both read and dismissed timestamps', async () => {
  state.visible = [
    { id: 'n1', title_bn: 'ক', priority: 'urgent', is_read: false, is_dismissed: false },
  ];

  await NoticeService.dismissNotice('user-1', 'n1');

  assert.equal(state.reads.length, 1);
  assert.ok(state.reads[0].read_at);
  assert.ok(state.reads[0].dismissed_at);
});

test('mark read rejects a notice that is not visible to the user', async () => {
  state.visible = [];

  await assert.rejects(NoticeService.markNoticeRead('user-1', 'missing'), /not found/i);
  assert.equal(state.reads.length, 0);
});

test('update rejects an expiry before the existing publish time', async () => {
  state.notices = [
    {
      id: 'n1',
      title_bn: 'ক',
      body_bn: 'খ',
      priority: 'normal',
      published_at: '2026-10-29T10:00:00.000Z',
      expires_at: null,
    },
  ];

  await assert.rejects(
    NoticeService.updateNotice('n1', {
      title_bn: 'ক',
      body_bn: 'খ',
      expires_at: '2026-10-29T09:00:00.000Z',
    }),
    NoticeValidationError
  );
});
