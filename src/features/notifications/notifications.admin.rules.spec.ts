import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isSafeActionLink,
  isUuid,
  matchesAudienceRules,
  normalizeNotificationType,
  normalizePriority,
  normalizeStats,
  parseAudienceRules,
  parseListFilters,
  sanitizeCopy,
  sanitizeSearch,
  validateCampaignInput,
} from './notifications.admin.rules.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const validBody = {
  title_en: 'Exam reminder',
  title_bn: 'পরীক্ষার রিমাইন্ডার',
  body_en: 'Physics starts in one hour.',
  body_bn: 'পদার্থবিজ্ঞান এক ঘণ্টা পরে শুরু হবে।',
  type: 'exam',
  priority: 'high',
  target_rules: { subscription_status: 'all', class_level: ['HSC'] },
};

test('copy is stripped of markup and control characters', () => {
  assert.equal(sanitizeCopy('<script>alert(1)</script> Hello'), 'scriptalert(1)/script Hello');
  assert.equal(sanitizeCopy('  line\nbreak  '), 'line break');
  assert.equal(sanitizeCopy(null), '');
});

test('action links must be internal app paths', () => {
  assert.equal(isSafeActionLink('/history'), true);
  assert.equal(isSafeActionLink('/exam/live?id=1'), true);
  assert.equal(isSafeActionLink('https://evil.example'), false);
  assert.equal(isSafeActionLink('//evil.example/path'), false);
  assert.equal(isSafeActionLink('/\\evil'), false);
  assert.equal(isSafeActionLink('javascript:alert(1)'), false);
  assert.equal(isSafeActionLink('history'), false);
});

test('legacy campaign types map onto the six real categories', () => {
  assert.equal(normalizeNotificationType('exam'), 'exam');
  assert.equal(normalizeNotificationType('promo'), 'reward');
  assert.equal(normalizeNotificationType('system'), 'security');
  assert.equal(normalizeNotificationType('campaign'), 'social');
  assert.equal(normalizeNotificationType('anything-else'), 'social');
  assert.equal(normalizePriority('HIGH'), 'high');
  assert.equal(normalizePriority('urgent'), 'normal');
  assert.equal(normalizePriority(undefined), 'normal');
});

test('a valid notification is normalised into the exact writable row', () => {
  const { record, mode } = validateCampaignInput({
    ...validBody,
    channel: 'push',
    status: 'sent',
    created_by: OTHER,
    total_sent: 9999,
    action_link: '/exam/live',
  });

  assert.equal(mode, 'send');
  assert.equal(record.channel, 'both');
  assert.equal(record.type, 'exam');
  assert.equal(record.priority, 'high');
  assert.equal(record.action_link, '/exam/live');
  assert.equal(record.scheduled_at, null);
  // Client-supplied bookkeeping fields never reach the insert.
  assert.equal('status' in record, false);
  assert.equal('created_by' in record, false);
  assert.equal('total_sent' in record, false);
});

test('a notification needs a title and a body in at least one language', () => {
  assert.throws(
    () => validateCampaignInput({ ...validBody, title_en: '', title_bn: '' }),
    /title is required/i
  );
  assert.throws(
    () => validateCampaignInput({ ...validBody, body_en: '', body_bn: '' }),
    /message is required/i
  );
});

test('external action links and non-https images are refused', () => {
  assert.throws(
    () => validateCampaignInput({ ...validBody, action_link: 'https://evil.example' }),
    /in-app path/i
  );
  assert.throws(
    () => validateCampaignInput({ ...validBody, image_url: 'http://cdn.example/x.png' }),
    /https URL/i
  );
});

test('a future scheduled_at schedules instead of sending immediately', () => {
  const start = Date.now() + 60 * 60 * 1000;
  const { record, mode } = validateCampaignInput({
    ...validBody,
    scheduled_at: new Date(start).toISOString(),
    expires_at: new Date(start + 60 * 60 * 1000).toISOString(),
  });

  assert.equal(mode, 'schedule');
  assert.equal(record.scheduled_at, new Date(start).toISOString());
});

test('a scheduled notification cannot expire before it is sent', () => {
  const start = Date.now() + 60 * 60 * 1000;
  assert.throws(
    () =>
      validateCampaignInput({
        ...validBody,
        scheduled_at: new Date(start).toISOString(),
        expires_at: new Date(start - 1000).toISOString(),
      }),
    /expires_at must be after/i
  );
});

test('drafts keep no schedule, and an expired expiry is refused', () => {
  const draft = validateCampaignInput({ ...validBody, mode: 'draft' });
  assert.equal(draft.mode, 'draft');
  assert.equal(draft.record.scheduled_at, null);

  assert.throws(
    () => validateCampaignInput({ ...validBody, expires_at: new Date(Date.now() - 1000).toISOString() }),
    /must be in the future/i
  );
});

test('audience rules reject unknown keys and malformed values', () => {
  assert.deepEqual(parseAudienceRules(undefined), {});
  assert.deepEqual(
    parseAudienceRules({ class_level: ['HSC', 'HSC'], platform: ['android'] }),
    { class_level: ['HSC'], platform: ['android'] }
  );

  assert.throws(() => parseAudienceRules({ admin: true }), /Unsupported audience rule/);
  assert.throws(() => parseAudienceRules({ platform: ['ios'] }), /android or web/);
  assert.throws(() => parseAudienceRules({ last_active_days_ago: 0 }), /whole number/);
  assert.throws(() => parseAudienceRules({ specific_user_ids: ['not-a-uuid'] }), /user ids/);
  assert.throws(() => parseAudienceRules({ subscription_status: 'gold' }), /all, free or premium/);
});

test('the rule matcher applies subscription, class, board, platform and inactivity', () => {
  const profile = {
    id: USER,
    subscription_status: 'active',
    class_level: 'HSC',
    education_board: 'Dhaka',
    last_active_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
  };

  assert.equal(matchesAudienceRules(null, profile), true);
  assert.equal(matchesAudienceRules({ subscription_status: 'premium' }, profile), true);
  assert.equal(matchesAudienceRules({ subscription_status: 'free' }, profile), false);
  assert.equal(matchesAudienceRules({ class_level: ['SSC'] }, profile), false);
  assert.equal(matchesAudienceRules({ education_board: ['Dhaka'] }, profile), true);
  assert.equal(matchesAudienceRules({ platform: ['android'] }, profile, ['android']), true);
  assert.equal(matchesAudienceRules({ platform: ['web'] }, profile, ['android']), false);
  assert.equal(matchesAudienceRules({ last_active_days_ago: 30 }, profile), true);
  assert.equal(matchesAudienceRules({ specific_user_ids: [OTHER] }, profile), false);
  assert.equal(matchesAudienceRules({ specific_user_ids: [OTHER, USER] }, profile), true);
});

test('search input and list filters are bounded and validated', () => {
  assert.equal(sanitizeSearch('  exam,title*()  '), 'examtitle');
  assert.equal(sanitizeSearch('পরীক্ষা'), 'পরীক্ষা');

  const filters = parseListFilters({ page: '2', limit: '500', search: 'physics' });
  assert.equal(filters.page, 2);
  assert.equal(filters.limit, 100);
  assert.equal(filters.search, 'physics');
  assert.ok(new Date(filters.to).getTime() > new Date(filters.from).getTime());

  assert.throws(() => parseListFilters({ status: 'archived' }), /status filter/);
  assert.throws(() => parseListFilters({ type: 'campaign' }), /type filter/);
  assert.throws(
    () => parseListFilters({ from: '2026-01-02', to: '2026-01-01' }),
    /to must be after from/
  );
});

test('stats never report a delivery rate the provider has not confirmed', () => {
  const pending = normalizeStats({
    total: 4,
    sent: 3,
    provider_accepted: 120,
    delivered: 0,
    delivery_reported: 0,
    taps: 6,
  });

  assert.equal(pending.deliveryRate, null);
  assert.equal(pending.tapRate, 0.05);

  const reported = normalizeStats({
    total: 4,
    sent: 3,
    provider_accepted: 100,
    delivered: 80,
    delivery_reported: 1,
    failed_devices: 20,
    taps: 10,
  });

  assert.equal(reported.deliveryRate, 0.8);
  assert.equal(reported.tapRate, 0.1);
  assert.equal(reported.failedDevices, 20);
});

test('uuid validation accepts user ids only', () => {
  assert.equal(isUuid(USER), true);
  assert.equal(isUuid('not-an-id'), false);
  assert.equal(isUuid(null), false);
});
