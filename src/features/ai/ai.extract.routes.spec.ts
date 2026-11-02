import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * Structural guard for the extraction route.
 *
 * The config modules that exit without credentials are stubbed (as in the
 * importer route spec) so the real Express router can be inspected without a
 * live project or a Gemini key.
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

const router = nodeRequire('./ai.routes').default as { stack: RouterLayer[] };

const routeLayer = (path: string): RouterLayer | undefined =>
  router.stack.find((layer) => layer.route?.path === path);

test('the extraction route is POST with auth, role, permission and rate limits', () => {
  const layer = routeLayer('/extract-questions');

  assert.ok(layer?.route, '/extract-questions must be registered');
  assert.equal(layer!.route!.methods.post, true);
  assert.equal(layer!.route!.methods.get, undefined);
  // requireAuth + rbacGuard + requirePermission + rateLimit + catchAsync handler
  assert.equal(layer!.route!.stack.length, 5);
});

test('the extraction route never replaces the existing AI endpoints', () => {
  assert.ok(routeLayer('/chat'));
  assert.ok(routeLayer('/explanation'));
  assert.ok(routeLayer('/config'));
});
