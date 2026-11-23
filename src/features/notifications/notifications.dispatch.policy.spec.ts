import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PUSH_ATTEMPTS,
  canAttemptPush,
  isTerminalDenial,
  priorityRank,
  remainingTtlMs,
  retryDelayMs,
  shouldDropDeferredPush,
} from './notifications.dispatch.policy';

test('retry backoff is 1m, 5m, 15m and never runs past the last step', () => {
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(2), 5 * 60_000);
  assert.equal(retryDelayMs(3), 15 * 60_000);
  assert.equal(retryDelayMs(4), 15 * 60_000);
  assert.equal(retryDelayMs(0), 60_000);
});

test('only a preference denial is terminal; a rate limit is not', () => {
  assert.equal(isTerminalDenial('push_disabled'), true);
  assert.equal(isTerminalDenial('category_disabled'), true);
  assert.equal(isTerminalDenial('quiet_hours'), false);
  assert.equal(isTerminalDenial('daily_cap'), false);
  assert.equal(isTerminalDenial('min_gap'), false);
});

test('a deferral past the expiry drops instead of arriving late', () => {
  const examStart = '2026-11-23T10:00:00.000Z';

  assert.equal(shouldDropDeferredPush(examStart, '2026-11-23T09:59:00.000Z'), false);
  assert.equal(shouldDropDeferredPush(examStart, examStart), true);
  assert.equal(shouldDropDeferredPush(examStart, '2026-11-23T12:00:00.000Z'), true);
  assert.equal(shouldDropDeferredPush(null, '2026-11-23T12:00:00.000Z'), false);
  assert.equal(shouldDropDeferredPush(examStart, null), false);
});

test('the fourth attempt is never claimed', () => {
  assert.equal(canAttemptPush(0), true);
  assert.equal(canAttemptPush(1), true);
  assert.equal(canAttemptPush(2), true);
  assert.equal(canAttemptPush(3), false);
  assert.equal(canAttemptPush(MAX_PUSH_ATTEMPTS), false);
  assert.equal(canAttemptPush(null), true);
});

test('the daily cap is spent by priority, security first and rewards last', () => {
  assert.ok(priorityRank('new_device_login') > priorityRank('exam_live_1h'));
  assert.ok(priorityRank('exam_live_1h') > priorityRank('exam_result'));
  assert.ok(priorityRank('exam_result') > priorityRank('streak_warning'));
  assert.ok(priorityRank('streak_warning') > priorityRank('premium_expiring'));
  assert.ok(priorityRank('premium_expiring') > priorityRank('squad_invite'));
  assert.ok(priorityRank('squad_invite') > priorityRank('reward_earned'));
  assert.equal(priorityRank(null), 40);
});

test('ttl is the time left before expiry, and null when nothing expires', () => {
  const now = new Date('2026-11-23T09:00:00.000Z');

  assert.equal(remainingTtlMs('2026-11-23T10:00:00.000Z', now), 60 * 60 * 1000);
  assert.equal(remainingTtlMs('2026-11-23T08:00:00.000Z', now), -60 * 60 * 1000);
  assert.equal(remainingTtlMs(null, now), null);
});
