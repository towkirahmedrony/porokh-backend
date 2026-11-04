import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PUSH_CHANNEL_ID,
  buildPushMessage,
  groupTokensByPlatform,
  normalizeDevicePlatform,
} from './notifications.push.ts';

const copy = {
  title: 'পরীক্ষা শুরু হবে',
  body: '১০ মিনিট বাকি',
  imageUrl: 'https://cdn.example.com/exam.png',
  actionLink: '/exam/live',
  type: 'exam',
  notificationId: 'n-1',
};

test('tokens are split by platform and unknown platforms stay web', () => {
  assert.equal(normalizeDevicePlatform('android'), 'android');
  assert.equal(normalizeDevicePlatform('ANDROID'), 'android');
  assert.equal(normalizeDevicePlatform('web'), 'web');
  assert.equal(normalizeDevicePlatform(null), 'web');

  const grouped = groupTokensByPlatform([
    { fcm_token: 'web-1', platform: 'web' },
    { fcm_token: 'android-1', platform: 'android' },
    { fcm_token: 'legacy-1', platform: null },
    { fcm_token: 'android-1', platform: 'android' },
    { fcm_token: '   ', platform: 'web' },
    { fcm_token: null, platform: 'android' },
  ]);

  assert.deepEqual(grouped, {
    android: ['android-1'],
    web: ['web-1', 'legacy-1'],
  });
});

test('a web token keeps the data-only payload the service worker expects', () => {
  const message = buildPushMessage(['web-1'], 'web', copy) as Record<string, any>;

  assert.equal(message.notification, undefined);
  assert.equal(message.android, undefined);
  assert.deepEqual(message.data, {
    title: copy.title,
    body: copy.body,
    image_url: copy.imageUrl,
    action_link: copy.actionLink,
    type: 'exam',
    notification_id: 'n-1',
  });
});

test('an android token carries a displayable notification for background and terminated delivery', () => {
  const message = buildPushMessage(['android-1'], 'android', copy) as Record<string, any>;

  assert.deepEqual(message.notification, {
    title: copy.title,
    body: copy.body,
    imageUrl: copy.imageUrl,
  });
  assert.equal(message.android.priority, 'high');
  assert.equal(message.android.notification.channelId, PUSH_CHANNEL_ID);
  assert.equal(message.android.notification.sound, 'default');
  // The tap handler reads the same data keys as the web service worker.
  assert.equal(message.data.action_link, '/exam/live');
  assert.equal(message.data.notification_id, 'n-1');
});

test('missing copy still produces a valid android notification', () => {
  const message = buildPushMessage(['android-1'], 'android', {
    title: '',
    body: '',
    type: 'social',
  }) as Record<string, any>;

  assert.equal(message.notification.title, 'Porokh');
  assert.equal(message.notification.imageUrl, undefined);
  assert.equal(message.android.notification.imageUrl, undefined);
  assert.equal(message.data.action_link, '/');
});
