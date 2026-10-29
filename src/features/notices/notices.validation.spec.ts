import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoticeWindow,
  isOwnedMediaUrl,
  isSafeNoticeActionLink,
  parseNoticeCreate,
  parseNoticeUpdate,
  NoticeValidationError,
} from './notices.validation';

const basePayload = {
  title_bn: 'নোটিশ',
  body_bn: 'বিস্তারিত',
};

test('create accepts bilingual copy, priority and target rules', () => {
  const parsed = parseNoticeCreate({
    ...basePayload,
    title_en: 'Notice',
    body_en: 'Details',
    priority: 'urgent',
    target_rules: {
      roles: ['student'],
      class_levels: ['HSC 26'],
      subscription: 'free',
      languages: ['bn'],
    },
  });

  assert.equal(parsed.priority, 'urgent');
  assert.deepEqual(parsed.target_rules?.class_levels, ['HSC 26']);
});

test('create rejects an unknown priority and empty bn copy', () => {
  assert.throws(
    () => parseNoticeCreate({ ...basePayload, priority: 'critical' }),
    NoticeValidationError
  );
  assert.throws(
    () => parseNoticeCreate({ title_bn: '  ', body_bn: 'x' }),
    NoticeValidationError
  );
});

test('update rejects an empty patch', () => {
  assert.throws(() => parseNoticeUpdate({}), NoticeValidationError);
});

test('action links are limited to internal routes and https urls', () => {
  assert.equal(isSafeNoticeActionLink('/notices/abc'), true);
  assert.equal(isSafeNoticeActionLink('/exams/routine?tab=1'), true);
  assert.equal(isSafeNoticeActionLink('https://example.com/notice'), true);
  assert.equal(isSafeNoticeActionLink('http://example.com/notice'), false);
  assert.equal(isSafeNoticeActionLink('//evil.example'), false);
  assert.equal(isSafeNoticeActionLink('javascript:alert(1)'), false);
  assert.equal(isSafeNoticeActionLink('/bad path'), false);
});

test('media urls must belong to the project cloudinary cloud', () => {
  assert.equal(
    isOwnedMediaUrl('https://res.cloudinary.com/demo/image/upload/a.webp', 'demo'),
    true
  );
  assert.equal(
    isOwnedMediaUrl('https://res.cloudinary.com/other/image/upload/a.webp', 'demo'),
    false
  );
  assert.equal(isOwnedMediaUrl('https://example.com/a.webp', 'demo'), false);
  assert.equal(isOwnedMediaUrl('https://res.cloudinary.com/demo/a.webp', undefined), false);
});

test('expiry must be after publish time', () => {
  assert.doesNotThrow(() =>
    assertNoticeWindow('2026-10-29T10:00:00.000Z', '2026-10-30T10:00:00.000Z')
  );
  assert.throws(
    () => assertNoticeWindow('2026-10-29T10:00:00.000Z', '2026-10-29T10:00:00.000Z'),
    NoticeValidationError
  );
  assert.throws(
    () => assertNoticeWindow('2026-10-29T10:00:00.000Z', 'not-a-date'),
    NoticeValidationError
  );
});
