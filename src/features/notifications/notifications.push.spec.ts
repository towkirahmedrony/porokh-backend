import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PUSH_ALIAS_LIMIT,
  buildOneSignalMessage,
  chunkExternalIds,
  normalizeDevicePlatform,
  normalizeExternalIds,
} from './notifications.push.ts';
import { sendOneSignalMessage } from '../../config/onesignal.ts';

const copy = {
  title: { bn: 'পরীক্ষা শুরু হবে', en: 'Exam starts soon' },
  body: { bn: '১০ মিনিট বাকি', en: '10 minutes left' },
  imageUrl: 'https://cdn.example.com/exam.png',
  actionLink: '/exam/live',
  type: 'exam',
  notificationId: 'n-1',
};

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

test('recipients are de-duplicated, trimmed and split at the alias limit', () => {
  assert.deepEqual(normalizeExternalIds([USER, ` ${USER} `, '', null, OTHER]), [
    USER,
    OTHER,
  ]);

  const chunks = chunkExternalIds([USER, OTHER, 'u3'], 2);
  assert.deepEqual(chunks, [[USER, OTHER], ['u3']]);
  assert.equal(PUSH_ALIAS_LIMIT, 20_000);

  const wide = Array.from({ length: PUSH_ALIAS_LIMIT + 1 }, (_, i) => `u${i}`);
  const wideChunks = chunkExternalIds(wide);
  assert.equal(wideChunks.length, 2);
  assert.equal(wideChunks[0].length, PUSH_ALIAS_LIMIT);
  assert.equal(wideChunks[1].length, 1);
});

test('unknown device platforms are recorded as web', () => {
  assert.equal(normalizeDevicePlatform('android'), 'android');
  assert.equal(normalizeDevicePlatform('ANDROID'), 'android');
  assert.equal(normalizeDevicePlatform('web'), 'web');
  assert.equal(normalizeDevicePlatform(null), 'web');
});

test('a message targets External IDs only, with bilingual copy and routing data', () => {
  const message = buildOneSignalMessage([USER], copy) as Record<string, any>;

  assert.equal(message.target_channel, 'push');
  assert.deepEqual(message.include_aliases, { external_id: [USER] });
  assert.deepEqual(message.headings, {
    en: 'Exam starts soon',
    bn: 'পরীক্ষা শুরু হবে',
  });
  assert.deepEqual(message.contents, { en: '10 minutes left', bn: '১০ মিনিট বাকি' });
  assert.equal(message.big_picture, copy.imageUrl);

  // Only identifiers travel in the payload; nothing private and no audience
  // selector other than include_aliases.
  assert.deepEqual(message.data, {
    type: 'exam',
    notification_id: 'n-1',
    action_link: '/exam/live',
  });
  assert.equal(message.external_id, undefined);
  assert.equal(message.included_segments, undefined);
  assert.equal(message.include_subscription_ids, undefined);
  assert.equal(message.app_id, undefined);
});

test('missing copy still produces a sendable message', () => {
  const message = buildOneSignalMessage(
    [USER],
    { title: { bn: '', en: '' }, body: { bn: '', en: '' }, type: 'social' } as any
  ) as Record<string, any>;

  assert.equal(message.headings.en, 'Porokh');
  assert.equal(message.contents.en, 'Porokh');
  assert.equal(message.data.action_link, '/');
  assert.equal(message.data.notification_id, '');
  assert.equal(message.big_picture, undefined);
});

test('high priority and idempotency keys are forwarded, normal priority is not', () => {
  const urgent = buildOneSignalMessage([USER], { ...copy, priority: 'high' }, {
    idempotencyKey: 'notification:n-1:0',
  }) as Record<string, any>;

  assert.equal(urgent.priority, 10);
  assert.equal(urgent.idempotency_key, 'notification:n-1:0');

  const normal = buildOneSignalMessage([USER], { ...copy, priority: 'normal' }) as Record<string, any>;
  assert.equal(normal.priority, undefined);
  assert.equal(normal.idempotency_key, undefined);
});

test('an empty recipient list is refused instead of broadcasting to everyone', () => {
  assert.throws(() => buildOneSignalMessage([], copy), /No push recipients/);
  assert.throws(() => buildOneSignalMessage(['  '], copy), /No push recipients/);
});

test('a request without server credentials fails before any HTTP call', async () => {
  const savedAppId = process.env.ONESIGNAL_APP_ID;
  const savedKey = process.env.ONESIGNAL_REST_API_KEY;
  delete process.env.ONESIGNAL_APP_ID;
  delete process.env.ONESIGNAL_REST_API_KEY;

  try {
    await assert.rejects(
      sendOneSignalMessage({ contents: { en: 'x' } }),
      /OneSignal is not configured/
    );
  } finally {
    if (savedAppId !== undefined) process.env.ONESIGNAL_APP_ID = savedAppId;
    if (savedKey !== undefined) process.env.ONESIGNAL_REST_API_KEY = savedKey;
  }
});
