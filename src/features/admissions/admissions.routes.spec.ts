import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

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

stub('../../config/supabase', { supabase: {} });
stub('../../config/supabaseAdmin', { supabaseAdmin: {} });
stub('../../lib/utils/adminAudit', { recordAdminAudit: async () => undefined });

const router = require('./admissions.admin.routes').AdmissionAdminRoutes;

const routePaths = (stack: any[]): string[] =>
  Array.from(
    new Set(
      stack
        .filter((layer) => layer.route)
        .map((layer) => String(layer.route.path))
    )
  ).sort();

test('admission admin router authenticates, checks an active admin role, and checks exams permission', () => {
  const stack = router.stack ?? [];

  assert.equal(stack[0]?.name, 'requireAuth');
  assert.ok(!stack[0]?.route, 'authentication must be router-level');

  assert.ok(!stack[1]?.route, 'rbacGuard must be router-level');
  assert.equal(stack[1]?.handle?.length, 3);

  assert.ok(!stack[2]?.route, 'requirePermission must be router-level');
  assert.equal(stack[2]?.handle?.length, 3);
});

test('admission admin router exposes only the Phase 2 management surface', () => {
  assert.deepEqual(routePaths(router.stack ?? []), [
    '/units/:unitId',
    '/units/:unitId/status',
    '/universities',
    '/universities/:universityId/units',
  ]);
});

test('the service-role client is never imported into the browser-facing code path', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const controller = fs.readFileSync(
    path.join(process.cwd(), 'src', 'features', 'admissions', 'admissions.admin.controller.ts'),
    'utf8'
  );

  assert.ok(!controller.includes('SERVICE_ROLE'));
  assert.ok(!controller.includes('config/supabase'));
});
