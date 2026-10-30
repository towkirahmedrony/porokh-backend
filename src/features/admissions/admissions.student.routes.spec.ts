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

// The router contract is what this spec verifies, so the data layer and the
// limiter are replaced with inert stubs.
stub('../../config/supabase', { supabase: {} });
stub('../../middlewares/rateLimit', { rateLimit: () => (_req: any, _res: any, next: any) => next() });
stub('./admissions.student.service', {
  AdmissionStudentService: {
    getUnitContent: async () => ({}),
    startSubjectPractice: async () => ({}),
  },
});

const router = require('./admissions.student.routes').AdmissionStudentRoutes;

test('student admission router requires authentication for every route', () => {
  const stack = router.stack ?? [];

  assert.equal(stack[0]?.name, 'requireAuth');
  assert.ok(!stack[0]?.route, 'authentication must be router-level');
});

test('student admission router exposes only unit content and practice start', () => {
  const paths = Array.from(
    new Set(
      (router.stack ?? [])
        .filter((layer: any) => layer.route)
        .map((layer: any) => String(layer.route.path))
    )
  ).sort();

  assert.deepEqual(paths, ['/units/:unitId/content', '/units/:unitId/practice']);
});

test('practice start is the only state-changing student admission route', () => {
  const routeMethods = (router.stack ?? [])
    .filter((layer: any) => layer.route)
    .map((layer: any) => ({
      path: String(layer.route.path),
      methods: Object.keys(layer.route.methods ?? {}).sort(),
    }));

  assert.deepEqual(routeMethods, [
    { path: '/units/:unitId/content', methods: ['get'] },
    { path: '/units/:unitId/practice', methods: ['post'] },
  ]);
});
