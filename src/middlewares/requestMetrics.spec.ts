import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { requestMetricsSnapshot, requestTiming, resetRequestMetrics } from './requestMetrics';

const finish = (req: any) => {
  let handler: (() => void) | null = null;
  const res: any = {
    statusCode: 200,
    once: (event: string, callback: () => void) => {
      if (event === 'finish') handler = callback;
      res.statusCode = res.statusCode;
    },
  };

  requestTiming(req, res, () => undefined);
  handler?.();
  return res;
};

beforeEach(() => resetRequestMetrics());

test('a matched route is recorded by template, not by URL', () => {
  finish({
    method: 'GET',
    path: '/api/v1/exams/user/attempts/abc-123',
    baseUrl: '/api/v1/exams/user',
    route: { path: '/attempts/:id' },
  });

  const [entry] = requestMetricsSnapshot();
  assert.equal(entry.route, 'GET /api/v1/exams/user/attempts/:id');
  assert.equal(entry.count, 1);
});

test('repeated requests aggregate into one entry', () => {
  const req = {
    method: 'POST',
    path: '/api/v1/exams/user/submit',
    baseUrl: '/api/v1/exams/user',
    route: { path: '/submit' },
  };

  finish(req);
  finish(req);

  const [entry] = requestMetricsSnapshot();
  assert.equal(entry.count, 2);
});

test('health probes are not recorded', () => {
  finish({ method: 'GET', path: '/health/ready', baseUrl: '', route: { path: '/health/ready' } });

  assert.equal(requestMetricsSnapshot().length, 0);
});

test('an unmatched request is labelled without its path', () => {
  finish({ method: 'GET', path: '/api/v1/secret-value/abc', baseUrl: '' });

  const [entry] = requestMetricsSnapshot();
  assert.equal(entry.route, 'GET unmatched');
});
