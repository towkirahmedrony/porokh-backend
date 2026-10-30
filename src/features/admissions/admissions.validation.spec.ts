import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUnitCode,
  parseAdmissionId,
  parseAdmissionUnitStatus,
  parseCreateAdmissionUnit,
  parseUpdateAdmissionUnit,
} from './admissions.validation';

const UNIVERSITY_ID = '11111111-1111-4111-8111-111111111111';

const errorCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error: any) {
    return error.errorCode;
  }
};

test('create payload trims values, defaults status/order, and normalizes optional text', () => {
  const parsed = parseCreateAdmissionUnit({
    name_bn: '  ক ইউনিট  ',
    name_en: '  ',
    code: '  A  ',
    description: '  ',
  });

  assert.deepEqual(parsed, {
    name_bn: 'ক ইউনিট',
    name_en: null,
    code: 'A',
    description: null,
    is_active: true,
    display_order: 0,
  });
});

test('create payload rejects missing names/codes, unknown fields and invalid values', () => {
  assert.equal(errorCode(() => parseCreateAdmissionUnit({ code: 'A' })), 'VALIDATION_FAILED');
  assert.equal(errorCode(() => parseCreateAdmissionUnit({ name_bn: 'ক' })), 'VALIDATION_FAILED');
  assert.equal(
    errorCode(() => parseCreateAdmissionUnit({ name_bn: 'ক', code: '   ' })),
    'VALIDATION_FAILED'
  );
  assert.equal(
    errorCode(() =>
      parseCreateAdmissionUnit({ name_bn: 'ক', code: 'A', institution_id: UNIVERSITY_ID })
    ),
    'VALIDATION_FAILED'
  );
  assert.equal(
    errorCode(() => parseCreateAdmissionUnit({ name_bn: 'ক', code: 'A', is_active: 'yes' })),
    'VALIDATION_FAILED'
  );
  assert.equal(
    errorCode(() => parseCreateAdmissionUnit({ name_bn: 'ক', code: 'A', display_order: -1 })),
    'VALIDATION_FAILED'
  );
  assert.equal(
    errorCode(() => parseCreateAdmissionUnit({ name_bn: 'x'.repeat(161), code: 'A' })),
    'VALIDATION_FAILED'
  );
});

test('update payload accepts partial fields but rejects empty and unknown payloads', () => {
  assert.deepEqual(parseUpdateAdmissionUnit({ is_active: false }), { is_active: false });
  assert.deepEqual(parseUpdateAdmissionUnit({ description: '' }), { description: null });
  assert.equal(errorCode(() => parseUpdateAdmissionUnit({})), 'VALIDATION_FAILED');
  assert.equal(
    errorCode(() => parseUpdateAdmissionUnit({ institution_id: UNIVERSITY_ID })),
    'VALIDATION_FAILED'
  );
  assert.equal(
    errorCode(() => parseUpdateAdmissionUnit({ name_bn: '', code: 'A' })),
    'VALIDATION_FAILED'
  );
});

test('status payload requires exactly one boolean flag', () => {
  assert.deepEqual(parseAdmissionUnitStatus({ is_active: true }), { is_active: true });
  assert.equal(errorCode(() => parseAdmissionUnitStatus({})), 'VALIDATION_FAILED');
  assert.equal(errorCode(() => parseAdmissionUnitStatus({ is_active: 'true' })), 'VALIDATION_FAILED');
  assert.equal(
    errorCode(() => parseAdmissionUnitStatus({ is_active: true, id: UNIVERSITY_ID })),
    'VALIDATION_FAILED'
  );
});

test('admission identifiers must be UUIDs', () => {
  assert.equal(parseAdmissionId(UNIVERSITY_ID, 'university id'), UNIVERSITY_ID);
  assert.equal(errorCode(() => parseAdmissionId('1', 'university id')), 'VALIDATION_FAILED');
  assert.equal(errorCode(() => parseAdmissionId(undefined, 'unit id')), 'VALIDATION_FAILED');
});

test('unit code normalization ignores case and surrounding whitespace only', () => {
  assert.equal(normalizeUnitCode('  Ka  '), 'ka');
  assert.notEqual(normalizeUnitCode('Ka A'), normalizeUnitCode('ka'));
});
