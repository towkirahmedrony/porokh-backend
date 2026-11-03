import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * Structural guard for the importer routes.
 *
 * The project has no `.env` in a test environment, so the config modules that
 * exit without credentials are stubbed and the real Express router is loaded
 * to prove the middleware chain is attached to the routes themselves.
 */

type ModuleExports = Record<string, unknown>;

interface RouteLayer {
  handle: { length: number };
}

interface RouterLayer {
  name?: string;
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: RouteLayer[];
  };
}

const nodeRequire = createRequire(__filename);

const stub = (request: string, exports: ModuleExports): void => {
  // Optional modules that this route graph does not import may be absent in a
  // compiled test build; stubbing them is best-effort, not required.
  let resolved: string;
  try {
    resolved = nodeRequire.resolve(request);
  } catch {
    return;
  }

  nodeRequire.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  } as never;
};

stub('../../config/supabase', { supabase: {} });
stub('../../config/supabaseAdmin', { supabaseAdmin: {} });
stub('../../config/publicSupabase', { publicSupabase: {} });
stub('../../config/supabaseAuth', { supabaseAuth: {} });
stub('../../config/userSupabase', {
  createUserSupabaseClient: () => ({ rpc: async () => ({ data: true, error: null }) }),
});

const router = nodeRequire('./content.routes').default as { stack: RouterLayer[] };

const routeLayer = (path: string): RouterLayer | undefined =>
  router.stack.find((layer) => layer.route?.path === path);

test('every content route is authenticated before the importer routes run', () => {
  assert.equal(router.stack[0]?.name, 'requireAuth');
  assert.equal(router.stack[0]?.route, undefined);
});

test('the import route is POST with rbacGuard + requirePermission + controller', () => {
  const layer = routeLayer('/questions/import');

  assert.ok(layer?.route, '/questions/import must be registered');
  assert.equal(layer!.route!.methods.post, true);
  assert.equal(layer!.route!.methods.get, undefined);
  // rbacGuard(3-arg) + requirePermission(3-arg) + catchAsync handler
  assert.equal(layer!.route!.stack.length, 3);
});

test('the plain-text import route is POST with the same guard chain', () => {
  const layer = routeLayer('/questions/import-text');

  assert.ok(layer?.route, '/questions/import-text must be registered');
  assert.equal(layer!.route!.methods.post, true);
  assert.equal(layer!.route!.methods.get, undefined);
  assert.equal(layer!.route!.stack.length, 3);
});

test('the import history route is GET with the same guard chain', () => {
  const layer = routeLayer('/questions/import-history');

  assert.ok(layer?.route, '/questions/import-history must be registered');
  assert.equal(layer!.route!.methods.get, true);
  assert.equal(layer!.route!.methods.post, undefined);
  assert.equal(layer!.route!.stack.length, 3);
});

test('the importer routes never replace the existing bulk upload endpoint', () => {
  assert.ok(routeLayer('/questions/bulk'), '/questions/bulk must stay registered');
  assert.ok(routeLayer('/questions'));
});
