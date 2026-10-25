import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Security contract for the admin group API.
 *
 * The database-backed behaviour is covered by the live verification checklist;
 * these assertions protect the properties that a later refactor can silently
 * remove: every route is behind auth + admin role + permission, destructive
 * identifiers are validated before they reach the service, and the supporting
 * migration keeps the duplicate-membership invariant at the database level.
 */

type Row = Record<string, any>;

const require = createRequire(__filename);

const stub = (request: string, exports: Row) => {
  const resolved = require.resolve(request);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  } as any;
};

stub('../../config/supabase', {
  supabase: {
    from: () => {
      throw new Error('service must not be reached by validation tests');
    },
  },
});
stub('../../config/supabaseAdmin', {
  supabaseAdmin: {
    from: () => {
      throw new Error('service must not be reached by validation tests');
    },
  },
});
stub('./groups.service', {
  getGroupsConfig: async () => ({
    squadDefaultMembers: 30,
    squadMaxMembers: 50,
    communityMaxMembers: 200,
    battleParticipationXp: 10,
    battleWinnerBonusXp: 20,
    leaderboardMinMembers: 3,
  }),
});

const controller = require('./groups.admin.controller');
const router = require('./groups.admin.routes').default;

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

const invoke = async (handler: any, req: Row) => {
  const res = createRes();
  const errors: any[] = [];
  await handler(req, res, (error: any) => errors.push(error));

  const error = errors[0];
  if (error) {
    res.statusCode = error.status ?? error.statusCode ?? 500;
    res.body = {
      success: false,
      message: error.message,
      data: null,
      code: error.errorCode ?? error.code,
    };
  }
  return res;
};

const routeLayers = (stack: any[]) => stack.filter((layer) => layer.route);
const paths = (stack: any[]): string[] =>
  Array.from(new Set(routeLayers(stack).map((layer) => String(layer.route.path)))).sort();

test('the admin group router authenticates, checks an active admin role, and checks settings permission', () => {
  const stack = router.stack ?? [];

  assert.equal(stack[0]?.name, 'requireAuth');
  assert.equal(stack[0]?.handle?.length, 3);
  assert.ok(!stack[0]?.route, 'authentication must be router-level');

  assert.ok(!stack[1]?.route, 'rbacGuard must be router-level');
  assert.equal(stack[1]?.handle?.length, 3);

  assert.ok(!stack[2]?.route, 'requirePermission must be router-level');
  assert.equal(stack[2]?.handle?.length, 3);
});

test('the admin group router exposes the complete management surface', () => {
  assert.deepEqual(paths(router.stack ?? []), [
    '/',
    '/:id',
    '/:id/battles/:battleId/cancel',
    '/:id/flags',
    '/:id/members',
    '/:id/members/:userId',
    '/:id/members/:userId/kick',
    '/:id/messages',
    '/:id/messages/:messageId',
    '/:id/owner',
    '/:id/status',
    '/dictionary',
    '/dictionary/:entryId',
    '/leaderboard',
    '/leaderboard/refresh',
    '/moderation',
    '/moderation/:flagId/ban',
    '/moderation/:flagId/delete',
    '/moderation/:flagId/ignore',
    '/moderation/:flagId/warn',
    '/settings',
    '/stats',
    '/users/search',
  ]);
});

test('invalid pagination and filters are rejected before the service layer', async () => {
  const res = await invoke(controller.getGroups, { query: { page: 0 } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'VALIDATION_FAILED');

  const res2 = await invoke(controller.getGroups, { query: { pageSize: 500 } });
  assert.equal(res2.statusCode, 400);

  const res3 = await invoke(controller.getGroups, { query: { type: 'owner' } });
  assert.equal(res3.statusCode, 400);
});

test('malformed group and user identifiers are rejected', async () => {
  const badGroup = await invoke(controller.getGroup, { params: { id: 'not-a-uuid' } });
  assert.equal(badGroup.statusCode, 400);

  const badMember = await invoke(controller.addGroupMember, {
    user: { id: '00000000-0000-4000-8000-000000000001' },
    params: { id: '00000000-0000-4000-8000-000000000002' },
    body: { userId: 'injection' },
  });
  assert.equal(badMember.statusCode, 400);

  const badRole = await invoke(controller.updateGroupMemberRole, {
    user: { id: '00000000-0000-4000-8000-000000000001' },
    params: {
      id: '00000000-0000-4000-8000-000000000002',
      userId: '00000000-0000-4000-8000-000000000003',
    },
    body: { role: 'super_admin' },
  });
  assert.equal(badRole.statusCode, 400);
});

test('mutating endpoints require a verified actor id', async () => {
  const res = await invoke(controller.createGroup, {
    body: { name: 'Valid group' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'AUTH_REQUIRED');
});

test('a max-members value below the product minimum is rejected', async () => {
  const res = await invoke(controller.createGroup, {
    user: { id: '00000000-0000-4000-8000-000000000001' },
    body: { name: 'Valid group', maxMembers: 1 },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'VALIDATION_FAILED');
});

test('the group admin migration enforces unique membership and revokes trigger execution', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20261025120000_group_admin_management.sql'),
    'utf8'
  ).toLowerCase();

  assert.match(
    sql,
    /create unique index if not exists group_members_group_id_user_id_key\s+on public\.group_members\(group_id, user_id\)/
  );
  assert.match(sql, /create or replace function public\.enforce_group_membership_limit\(\)/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = ''/);
  assert.match(sql, /select max_members[\s\S]*for update/);
  assert.match(sql, /raise exception 'group_full'/);
  assert.match(
    sql,
    /revoke all on function public\.enforce_group_membership_limit\(\) from public, anon, authenticated/
  );
  assert.match(sql, /create trigger group_members_enforce_cap/);
});
