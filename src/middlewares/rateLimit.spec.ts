import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit, rateLimitStats, resetRateLimitState } from './rateLimit';

const makeReq = (userId?: string, ip = '203.0.113.10') =>
  ({ user: userId ? { id: userId } : undefined, ip, socket: { remoteAddress: ip } }) as any;

const makeRes = () => {
  const headers: Record<string, string> = {};
  const res: any = {
    statusCode: 200,
    body: null,
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
    headers,
  };
  return res;
};

beforeEach(() => resetRateLimitState());

test('requests under the limit pass through and the limit then rejects with Retry-After', () => {
  const limiter = rateLimit({ windowMs: 60_000, max: 2, keyPrefix: 'test' });
  let passed = 0;

  for (let index = 0; index < 2; index += 1) {
    limiter(makeReq('user-1'), makeRes(), () => { passed += 1; });
  }
  assert.equal(passed, 2);

  const res = makeRes();
  limiter(makeReq('user-1'), res, () => { passed += 1; });

  assert.equal(passed, 2, 'the rejected request must not reach the handler');
  assert.equal(res.statusCode, 429);
  assert.ok(Number(res.headers['Retry-After']) >= 0);
  assert.equal(rateLimitStats().rejected, 1);
});

test('buckets are scoped per user, so one student cannot exhaust another', () => {
  const limiter = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'scope' });
  let passed = 0;

  limiter(makeReq('user-a'), makeRes(), () => { passed += 1; });
  limiter(makeReq('user-b'), makeRes(), () => { passed += 1; });

  assert.equal(passed, 2);
});

test('an expired window starts a fresh bucket', () => {
  const limiter = rateLimit({ windowMs: 1, max: 1, keyPrefix: 'window' });
  let passed = 0;

  limiter(makeReq('user-c'), makeRes(), () => { passed += 1; });

  return new Promise<void>((resolve) => {
    setTimeout(() => {
      limiter(makeReq('user-c'), makeRes(), () => { passed += 1; });
      assert.equal(passed, 2);
      resolve();
    }, 10);
  });
});

test('tracked buckets stay bounded under many distinct clients', () => {
  const limiter = rateLimit({ windowMs: 60_000, max: 5, keyPrefix: 'flood' });

  for (let index = 0; index < 10_500; index += 1) {
    limiter(makeReq(`user-${index}`), makeRes(), () => undefined);
  }

  assert.ok(
    rateLimitStats().buckets <= 10_000,
    `bucket map grew to ${rateLimitStats().buckets}`
  );

  // The limiter still works for a client after pruning.
  const res = makeRes();
  let passed = 0;
  limiter(makeReq('fresh-user'), res, () => { passed += 1; });
  assert.equal(passed, 1);
});
