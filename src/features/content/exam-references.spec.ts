import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ExamReferenceValidationError,
  normalizeExamReference,
  normalizeReferenceSourceKind,
  referenceKindSupportsUnit,
  referenceNameVariants,
  type AdmissionUnitRecord,
  type InstitutionRecord,
  type ReferenceLookups,
} from './exam-references.core';

const university: InstitutionRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  name_bn: 'ঢাকা বিশ্ববিদ্যালয়',
  name_en: 'University of Dhaka',
  type: 'university',
  code: 'DU',
  eiin: '90000001',
};

const college: InstitutionRecord = {
  id: '22222222-2222-4222-8222-222222222222',
  name_bn: 'নটর ডেম কলেজ',
  name_en: 'Notre Dame College',
  type: 'college',
  code: '108274',
  eiin: '108274',
};

const board: InstitutionRecord = {
  id: '33333333-3333-4333-8333-333333333333',
  name_bn: 'ঢাকা বোর্ড',
  name_en: 'Dhaka Board',
  type: 'board',
  code: '91000001',
  eiin: '91000001',
};

const school: InstitutionRecord = {
  id: '44444444-4444-4444-8444-444444444444',
  name_bn: 'মতিঝিল মডেল স্কুল',
  name_en: 'Motijheel Model School',
  type: 'school',
  code: 'SCHOOL_1',
};

const unitA: AdmissionUnitRecord = {
  id: '55555555-5555-4555-8555-555555555555',
  institution_id: university.id,
  name_bn: 'ক ইউনিট',
  name_en: 'A Unit',
  code: 'A',
  is_active: true,
};

const collegeUnit: AdmissionUnitRecord = {
  id: '66666666-6666-4666-8666-666666666666',
  institution_id: college.id,
  name_bn: 'বিজ্ঞান',
  name_en: 'Science',
  code: 'SCI',
  is_active: true,
};

const lookups: ReferenceLookups = {
  institutions: new Map([
    [university.id, university],
    [college.id, college],
    [board.id, board],
    [school.id, school],
  ]),
  units: new Map([
    [unitA.id, unitA],
    [collegeUnit.id, collegeUnit],
  ]),
};

test('legacy references without ids are preserved exactly', () => {
  const legacy = { source_kind: 'board', board: 'Dhaka Board', year: '2023', imported_from: 'old-csv' };
  assert.deepEqual(normalizeExamReference(legacy, lookups), legacy);
});

test('extended university reference with a valid unit is canonicalised', () => {
  const resolved = normalizeExamReference(
    {
      source_kind: 'admission',
      institution_id: university.id,
      unit_id: unitA.id,
      year: '2024',
      extra_key: 'kept',
    },
    lookups
  );

  assert.equal(resolved.institution_name, 'University of Dhaka');
  assert.equal(resolved.unit_name, 'A Unit');
  assert.equal(resolved.eiin, '90000001');
  assert.equal(resolved.code, 'DU');
  assert.equal(resolved.extra_key, 'kept');
});

test('a unit alone resolves its parent institution', () => {
  const resolved = normalizeExamReference(
    { source_kind: 'admission', unit_id: unitA.id },
    lookups
  );

  assert.equal(resolved.institution_id, university.id);
  assert.equal(resolved.institution_name, 'University of Dhaka');
  assert.equal(resolved.unit_name, 'A Unit');
});

test('null and missing admission units are accepted', () => {
  assert.deepEqual(
    normalizeExamReference(
      { source_kind: 'admission', institution_id: university.id, unit_id: null, unit_name: null },
      lookups
    ),
    {
      source_kind: 'admission',
      institution_id: university.id,
      unit_id: null,
      unit_name: null,
      institution_name: 'University of Dhaka',
      code: 'DU',
      eiin: '90000001',
    }
  );

  const withoutUnit = normalizeExamReference(
    { source_kind: 'college', institution_id: college.id },
    lookups
  );
  assert.equal(withoutUnit.unit_name, undefined);
});

test('board and school references do not need a unit', () => {
  const boardRef = normalizeExamReference({ source_kind: 'board', institution_id: board.id }, lookups);
  assert.equal(boardRef.board, 'Dhaka Board');
  assert.equal(boardRef.eiin, '91000001');
  assert.equal(boardRef.unit_id, undefined);

  const schoolRef = normalizeExamReference({ source_kind: 'school', institution_id: school.id }, lookups);
  assert.equal(schoolRef.institution_name, 'Motijheel Model School');
});

test('unit and institution relationships are enforced', () => {
  assert.throws(
    () =>
      normalizeExamReference(
        { source_kind: 'admission', institution_id: university.id, unit_id: collegeUnit.id },
        lookups
      ),
    ExamReferenceValidationError
  );

  assert.throws(
    () => normalizeExamReference({ source_kind: 'board', institution_id: board.id, unit_id: unitA.id }, lookups),
    /only valid for admission/
  );

  assert.throws(
    () =>
      normalizeExamReference(
        { source_kind: 'admission', institution_id: school.id },
        lookups
      ),
    /not a valid admission reference/
  );
});

test('unknown ids are rejected, never invented', () => {
  assert.throws(
    () =>
      normalizeExamReference(
        {
          source_kind: 'admission',
          institution_id: '99999999-9999-4999-8999-999999999999',
        },
        lookups
      ),
    /does not match an existing institution/
  );

  assert.throws(
    () => normalizeExamReference({ source_kind: 'admission', unit_id: 'not-a-uuid' }, lookups),
    /valid UUID/
  );
});

test('kind helpers map legacy aliases and unit support', () => {
  assert.equal(normalizeReferenceSourceKind('school_and_college'), 'school');
  assert.equal(normalizeReferenceSourceKind('madrasa'), 'board');
  assert.equal(normalizeReferenceSourceKind('admission'), 'admission');
  assert.equal(referenceKindSupportsUnit('admission'), true);
  assert.equal(referenceKindSupportsUnit('college'), true);
  assert.equal(referenceKindSupportsUnit('board'), false);
  assert.equal(referenceKindSupportsUnit('book'), false);
});


test('legacy names resolve across board short names and university word order', () => {
  assert.ok(
    referenceNameVariants('Dhaka Board', 'board').includes(
      referenceNameVariants('Board of Intermediate and Secondary Education, Dhaka', 'board')[1]
    )
  );

  assert.deepEqual(
    referenceNameVariants('Dhaka University', 'admission').at(-1),
    referenceNameVariants('University of Dhaka', 'admission').at(-1)
  );

  assert.notDeepEqual(
    referenceNameVariants('Dhaka College', 'college'),
    referenceNameVariants('University of Dhaka', 'university')
  );
});
