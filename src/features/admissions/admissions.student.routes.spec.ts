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
// limiter are replaced with inert stubs. Limiter options are captured so the
// applied limits stay part of the tested contract.
const limiters = new Map<string, any>();

stub('../../config/supabase', { supabase: {} });
stub('../../middlewares/rateLimit', {
  rateLimit: (options: Row) => {
    const middleware: any = (_req: any, _res: any, next: any) => next();
    middleware.options = options;
    limiters.set(String(options.keyPrefix), middleware);
    return middleware;
  },
});
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

test('unit content reads are rate limited per user without blocking navigation', () => {
  const layer = (router.stack ?? []).find(
    (entry: any) => entry.route?.path === '/units/:unitId/content'
  );
  const handlers = layer?.route?.stack ?? [];

  assert.equal(handlers.length, 2, 'unit content must be limiter + handler');
  assert.equal(
    handlers[0]?.handle,
    limiters.get('admission-content'),
    'the limiter must run before the controller'
  );

  const options = limiters.get('admission-content')?.options ?? {};

  assert.equal(options.windowMs, 60_000);
  // A unit screen is fetched once per navigation; the ceiling must leave room
  // for pull-to-refresh, retries and multi-tab use.
  assert.ok(options.max >= 60, `expected a navigation-safe ceiling, got ${options.max}`);
  assert.ok(options.max <= 600, `expected a bounded ceiling, got ${options.max}`);
});

test('practice start keeps its own stricter limit', () => {
  const options = limiters.get('admission-practice')?.options ?? {};

  assert.equal(options.windowMs, 60_000);
  assert.equal(options.max, 20);
});
