import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isOffenseType,
  isUuid,
  isValidSlug,
  normalizeReportReason,
  normalizeSlug,
  slugifyName,
} from './groups.validation';

test('slug validation mirrors the database constraint', () => {
  assert.equal(isValidSlug('dhaka-toppers'), true);
  assert.equal(isValidSlug('abc'), true);
  assert.equal(isValidSlug('ab'), false);
  assert.equal(isValidSlug('-leading'), false);
  assert.equal(isValidSlug('trailing-'), false);
  assert.equal(isValidSlug('has space'), false);
  assert.equal(isValidSlug('a'.repeat(41)), false);
  assert.equal(isValidSlug('new'), true, 'reserved words are checked by the trigger');
});

test('slug normalization is lower-case and trimmed', () => {
  assert.equal(normalizeSlug('  Dhaka-Toppers  '), 'dhaka-toppers');
});

test('slug suggestions are URL safe', () => {
  assert.equal(slugifyName('Dhaka Science Squad!'), 'dhaka-science-squad');
  assert.equal(slugifyName('  প্রিয় দল  '), '');
  assert.equal(slugifyName('A'.repeat(60)), 'a'.repeat(40));
});

test('uuid detection only accepts real uuids', () => {
  assert.equal(isUuid('00000000-0000-4000-8000-000000000001'), true);
  assert.equal(isUuid('dhaka-toppers'), false);
});

test('offense types are allow-listed', () => {
  assert.equal(isOffenseType('Spam'), true);
  assert.equal(isOffenseType('spam'), false);
  assert.equal(isOffenseType('Other'), true);
  assert.equal(isOffenseType('auto_ban_dictionary'), false);
});

test('report reasons are trimmed and capped at 200 characters', () => {
  assert.equal(normalizeReportReason('  bad words  '), 'bad words');
  assert.equal(normalizeReportReason('x'.repeat(250)).length, 200);
});
