import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCreateAdmissionUnit, parseUpdateAdmissionUnit } from './admissions.validation';

const errorCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error: any) {
    return error.errorCode;
  }
};

test('a unit can carry the HSC group it is meant for', () => {
  const science = parseCreateAdmissionUnit({ name_bn: 'ক', code: 'A', group_type: 'science' });
  assert.equal(science.group_type, 'science');

  const cleared = parseCreateAdmissionUnit({ name_bn: 'ক', code: 'A', group_type: null });
  assert.equal(cleared.group_type, null);

  const unset = parseCreateAdmissionUnit({ name_bn: 'ক', code: 'A' });
  assert.ok(!('group_type' in unset));
});

test('unknown group values are rejected on create and update', () => {
  assert.equal(
    errorCode(() => parseCreateAdmissionUnit({ name_bn: 'ক', code: 'A', group_type: 'arts' })),
    'VALIDATION_FAILED'
  );
  assert.equal(
    errorCode(() => parseUpdateAdmissionUnit({ group_type: 'engineering' })),
    'VALIDATION_FAILED'
  );
});

test('update can set and clear the group on its own', () => {
  assert.deepEqual(parseUpdateAdmissionUnit({ group_type: 'commerce' }), { group_type: 'commerce' });
  assert.deepEqual(parseUpdateAdmissionUnit({ group_type: null }), { group_type: null });
});
