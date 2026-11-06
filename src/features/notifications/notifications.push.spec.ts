import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANDROID_NOTIFICATION_CHANNEL_ID,
  ANDROID_URGENT_CHANNEL_ID,
  buildFcmPushPayload,
  normalizeDevicePlatform,
  normalizePushLanguage,
  safeActionLink,
} from './notifications.push';

const copy = {
  title: { bn: 'পরীক্ষা শুরু', en: 'Exam starts' },
  body: { bn: '১০ মিনিট বাকি', en: '10 minutes left' },
  type: 'exam',
  notificationId: '11111111-1111-5111-8111-111111111111',
  actionLink: '/exam/live',
};

test('android payload carries a system notification so a closed app still shows it', () => {
  const payload = buildFcmPushPayload(copy, { platform: 'android', language: 'bn' });

  assert.equal(payload.notification?.title, 'পরীক্ষা শুরু');
  assert.equal(payload.notification?.body, '১০ মিনিট বাকি');
  assert.equal(payload.android?.notification?.channelId, ANDROID_NOTIFICATION_CHANNEL_ID);
  assert.equal(payload.android?.priority, 'normal');
  assert.equal(payload.data?.action_link, '/exam/live');
  assert.equal(payload.data?.notification_id, copy.notificationId);
});

test('high priority selects the urgent android channel', () => {
  const payload = buildFcmPushPayload(
    { ...copy, priority: 'high' },
    { platform: 'android', language: 'en' }
  );

  assert.equal(payload.android?.priority, 'high');
  assert.equal(payload.android?.notification?.channelId, ANDROID_URGENT_CHANNEL_ID);
  assert.equal(payload.notification?.title, 'Exam starts');
});

test('web payload is data-only so the service worker renders exactly one notification', () => {
  const payload = buildFcmPushPayload(copy, { platform: 'web', language: 'en' });

  assert.equal(payload.notification, undefined);
  assert.equal(payload.webpush?.notification, undefined);
  assert.equal(payload.webpush?.data?.title, 'Exam starts');
  assert.equal(payload.webpush?.data?.action_link, '/exam/live');
  assert.equal(payload.webpush?.headers?.Urgency, 'normal');
});

test('every payload value is a string because FCM data cannot carry objects', () => {
  const payload = buildFcmPushPayload(
    { ...copy, imageUrl: 'https://cdn.example.com/a.png' },
    { platform: 'android', language: 'bn' }
  );

  Object.entries(payload.data ?? {}).forEach(([, value]) => {
    assert.equal(typeof value, 'string');
  });
  assert.equal(payload.data?.image_url, 'https://cdn.example.com/a.png');
  assert.equal(payload.android?.notification?.imageUrl, 'https://cdn.example.com/a.png');
});

test('both languages travel in the payload so the client can switch without a lookup', () => {
  const payload = buildFcmPushPayload(copy, { platform: 'android', language: 'bn' });

  assert.equal(payload.data?.title_bn, 'পরীক্ষা শুরু');
  assert.equal(payload.data?.title_en, 'Exam starts');
  assert.equal(payload.data?.body_bn, '১০ মিনিট বাকি');
  assert.equal(payload.data?.body_en, '10 minutes left');
});

test('a missing translation falls back instead of sending an empty notification', () => {
  const payload = buildFcmPushPayload(
    { title: { bn: '', en: 'Only English' }, body: { bn: '', en: '' }, type: 'exam' },
    { platform: 'android', language: 'bn' }
  );

  assert.equal(payload.notification?.title, 'Only English');
  assert.equal(payload.notification?.body, 'Only English');
});

test('unsafe destinations are replaced with the home route', () => {
  assert.equal(safeActionLink('/exam/live'), '/exam/live');
  assert.equal(safeActionLink('https://evil.example.com'), '/');
  assert.equal(safeActionLink('//evil.example.com'), '/');
  assert.equal(safeActionLink('javascript:alert(1)'), '/');
  assert.equal(safeActionLink(null), '/');
  assert.equal(safeActionLink(''), '/');
});

test('a payload without a stored notification id has no empty tag', () => {
  const payload = buildFcmPushPayload(
    { title: { bn: 'শিরোনাম', en: 'Title' }, body: { bn: 'বডি', en: 'Body' }, type: 'social' },
    { platform: 'android', language: 'bn' }
  );

  assert.equal(payload.android?.notification?.tag, undefined);
  assert.equal(payload.data?.notification_id, '');
});

test('push language defaults to Bangla and only an explicit english preference changes it', () => {
  assert.equal(normalizePushLanguage('bn'), 'bn');
  assert.equal(normalizePushLanguage('en'), 'en');
  assert.equal(normalizePushLanguage('EN-us'), 'en');
  assert.equal(normalizePushLanguage(undefined), 'bn');
  assert.equal(normalizePushLanguage('klingon'), 'bn');
});

test('device platform defaults to web and only android is special-cased', () => {
  assert.equal(normalizeDevicePlatform('android'), 'android');
  assert.equal(normalizeDevicePlatform('Android'), 'android');
  assert.equal(normalizeDevicePlatform('web'), 'web');
  assert.equal(normalizeDevicePlatform(null), 'web');
});
