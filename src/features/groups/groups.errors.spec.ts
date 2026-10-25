import test from 'node:test';
import assert from 'node:assert/strict';
import { groupError, isGroupErrorCode, mapDataError } from './groups.errors';

test('documented RPC codes keep their HTTP status', () => {
  assert.equal(groupError('SLUG_TAKEN').statusCode, 409);
  assert.equal(groupError('INVALID_SLUG').statusCode, 400);
  assert.equal(groupError('MESSAGE_NOT_FOUND').statusCode, 404);
  assert.equal(groupError('INVALID_OFFENSE_TYPE').statusCode, 400);
  assert.equal(groupError('BATTLE_NOT_FOUND').statusCode, 404);
});

test('raw RPC messages are forwarded as codes', () => {
  const mapped = mapDataError({ message: 'CANNOT_REPORT_THIS_MESSAGE', code: 'P0001' });
  assert.equal(mapped.errorCode, 'CANNOT_REPORT_THIS_MESSAGE');
  assert.equal(mapped.statusCode, 400);
});

test('unknown database errors never leak SQL text', () => {
  const mapped = mapDataError({
    message: 'duplicate key value violates unique constraint "study_groups_slug_key"',
    code: '23505',
  });
  assert.equal(mapped.errorCode, 'ALREADY_MEMBER');
  assert.equal(mapped.statusCode, 409);
  assert.equal(isGroupErrorCode(mapped.message), true);
  assert.notEqual(mapped.message, 'duplicate key value violates unique constraint "study_groups_slug_key"');
});
