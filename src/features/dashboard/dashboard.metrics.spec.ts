import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DashboardRangeError,
  averageScorePercent,
  bucketSeries,
  buildBucketKeys,
  calculateTrend,
  dhakaDayKey,
  dhakaDayStart,
  dhakaHourKey,
  parseDashboardRange,
  percentOf,
  previousRange,
  summarizePayments,
  sumBucketSeries,
} from './dashboard.metrics';

const NOW = new Date('2026-11-06T10:00:00.000Z');

test('defaults to the last seven Dhaka days', () => {
  const range = parseDashboardRange(null, null, NOW);

  assert.equal(range.toIso, NOW.toISOString());
  assert.equal(range.fromIso, new Date(NOW.getTime() - 7 * 86_400_000).toISOString());
  assert.equal(range.bucket, 'day');
  assert.equal(range.days, 7);
  assert.equal(buildBucketKeys(range).length, 7);
});

test('a short window is bucketed by hour', () => {
  const range = parseDashboardRange('2026-11-06T00:00:00.000Z', '2026-11-06T06:00:00.000Z');

  assert.equal(range.bucket, 'hour');
  assert.equal(range.days, 1);
});

test('rejects a partial custom range', () => {
  assert.throws(() => parseDashboardRange('2026-11-01T00:00:00.000Z', null), DashboardRangeError);
});

test('rejects inverted and oversized ranges', () => {
  assert.throws(
    () => parseDashboardRange('2026-11-06T00:00:00.000Z', '2026-11-05T00:00:00.000Z'),
    DashboardRangeError
  );
  assert.throws(
    () => parseDashboardRange('2025-01-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
    DashboardRangeError
  );

  try {
    parseDashboardRange('2026-11-06T00:00:00.000Z', '2026-11-05T00:00:00.000Z');
    assert.fail('expected a range error');
  } catch (error) {
    assert.equal((error as DashboardRangeError).status, 400);
  }
});

test('previous range is the same length immediately before', () => {
  const range = parseDashboardRange('2026-11-01T00:00:00.000Z', '2026-11-05T00:00:00.000Z', NOW);
  const previous = previousRange(range);

  assert.equal(previous.toIso, range.fromIso);
  assert.equal(previous.fromIso, '2026-10-28T00:00:00.000Z');
});

test('trend never invents a percentage without a baseline', () => {
  assert.equal(calculateTrend(150, 100), 50);
  assert.equal(calculateTrend(50, 100), -50);
  assert.equal(calculateTrend(0, 0), 0);
  assert.equal(calculateTrend(5, 0), null);
  assert.equal(calculateTrend(12.345, 10), 23.5);
});

test('Dhaka day and hour keys cross the UTC boundary', () => {
  assert.equal(dhakaDayKey('2026-11-05T19:00:00.000Z'), '2026-11-06');
  assert.equal(dhakaHourKey('2026-11-05T19:30:00.000Z'), '2026-11-06T01');
  assert.equal(dhakaDayStart('2026-11-06T10:00:00.000Z').toISOString(), '2026-11-05T18:00:00.000Z');
});

test('bucketSeries keeps empty buckets at zero', () => {
  const series = bucketSeries(
    ['2026-11-06', '2026-11-07'],
    ['2026-11-06T01:00:00.000Z', '2026-11-06T05:00:00.000Z', '2026-11-08T02:00:00.000Z'],
    dhakaDayKey
  );

  assert.deepEqual(series, [
    { key: '2026-11-06', value: 2 },
    { key: '2026-11-07', value: 0 },
  ]);
});

test('sumBucketSeries groups money into one bucket each', () => {
  const rows = [
    { at: '2026-11-06T03:00:00.000Z', amount: 500.5 },
    { at: '2026-11-06T04:00:00.000Z', amount: 99.5 },
    { at: '2026-11-07T03:00:00.000Z', amount: 10 },
  ];

  const series = sumBucketSeries(
    ['2026-11-06', '2026-11-07'],
    rows,
    (row) => dhakaDayKey(row.at),
    (row) => row.amount
  );

  assert.deepEqual(series, [
    { key: '2026-11-06', value: 600 },
    { key: '2026-11-07', value: 10 },
  ]);
});

test('payment summary counts each request once and separates statuses', () => {
  const summary = summarizePayments([
    { status: 'paid', amount: 500.5 },
    { status: 'paid', amount: 99.5 },
    { status: 'pending', amount: 200 },
    { status: 'failed', amount: 100 },
    { status: 'pending', amount: 1 },
  ]);

  assert.deepEqual(summary, {
    gross: 901,
    confirmed: 600,
    pending: 201,
    failed: 100,
    confirmedCount: 2,
    pendingCount: 2,
    failedCount: 1,
  });
});

test('score and share helpers handle empty data', () => {
  assert.equal(averageScorePercent([]), null);
  assert.equal(
    averageScorePercent([
      { score: 8, total_marks: 10 },
      { score: 6, total_marks: 10 },
    ]),
    70
  );
  assert.equal(averageScorePercent([{ score: 5, total_marks: 0 }]), null);
  assert.equal(percentOf(1, 0), null);
  assert.equal(percentOf(0, 0), null);
  assert.equal(percentOf(1, 4), 25);
});
