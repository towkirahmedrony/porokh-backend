import test from 'node:test';
import assert from 'node:assert/strict';
import type { AdmissionUnitRecord, InstitutionRecord } from './exam-references.core';
import { applyReferenceChecks, matchInstitution, matchUnit } from './question.refcheck';
import { parseQuestionText } from './question.textparse';

const inst = (
  id: string,
  name_en: string,
  name_bn: string,
  short_name: string,
  code: string,
  type = 'university'
): InstitutionRecord => ({ id, name_en, name_bn, short_name, code, eiin: code, type });

const INSTITUTIONS: InstitutionRecord[] = [
  inst('du', 'University of Dhaka', 'ঢাকা বিশ্ববিদ্যালয়', 'DU', '90000001'),
  inst('ru', 'University of Rajshahi', 'রাজশাহী বিশ্ববিদ্যালয়', 'RU', '90000002'),
  inst('duet', 'Dhaka University of Engineering & Technology', 'ঢাকা প্রকৌশল ও প্রযুক্তি বিশ্ববিদ্যালয়', 'DUET', '90000010'),
  inst('ruet', 'Rajshahi University of Engineering & Technology', 'রাজশাহী প্রকৌশল ও প্রযুক্তি বিশ্ববিদ্যালয়', 'RUET', '90000011'),
  inst('buet', 'Bangladesh University of Engineering and Technology', 'বাংলাদেশ প্রকৌশল বিশ্ববিদ্যালয়', 'BUET', '90000009'),
  inst('sau', 'Sher-e-Bangla Agricultural University', 'শেরেবাংলা কৃষি বিশ্ববিদ্যালয়', 'SAU', '90000030'),
  inst('sauS', 'Sylhet Agricultural University', 'সিলেট কৃষি বিশ্ববিদ্যালয়', 'SAU-Sylhet', '90000033'),
];

const unit = (
  id: string,
  institution_id: string,
  name_en: string,
  name_bn: string,
  code: string
): AdmissionUnitRecord => ({ id, institution_id, name_en, name_bn, code });

const UNITS = new Map<string, AdmissionUnitRecord[]>([
  [
    'du',
    [
      unit('du-a', 'du', 'Unit A (Science)', 'ক ইউনিট (বিজ্ঞান)', 'a'),
      unit('du-b', 'du', 'Unit B (Arts, Law and Social Science)', 'খ ইউনিট (কলা, আইন ও সামাজিক বিজ্ঞান)', 'b'),
      unit('du-cha', 'du', 'Unit Cha (Fine Arts)', 'চ ইউনিট (চারুকলা)', 'cha'),
      unit('du-iba', 'du', 'IBA Unit', 'আইবিএ ইউনিট', 'iba'),
    ],
  ],
  [
    'ru',
    [
      unit('ru-a', 'ru', 'Unit A (Humanities)', 'এ ইউনিট (মানবিক)', 'a'),
      unit('ru-c', 'ru', 'Unit C (Science)', 'সি ইউনিট (বিজ্ঞান)', 'c'),
    ],
  ],
]);

const idOf = (name: string, kind = 'admission'): string | null => {
  const result = matchInstitution(name, kind, INSTITUTIONS);
  return result.status === 'matched' ? result.institution.id : null;
};

test('different spellings of the same institution resolve to one row', () => {
  for (const name of [
    'University of Rajshahi',
    'Rajshahi University',
    'rajshahi university',
    'RU',
    'রাজশাহী বিশ্ববিদ্যালয়',
    '90000002',
  ]) {
    assert.equal(idOf(name), 'ru', name);
  }
});

test('similar names do not collapse into each other', () => {
  assert.equal(idOf('Rajshahi University of Engineering & Technology'), 'ruet');
  assert.equal(idOf('Bangladesh University of Engineering and Technology'), 'buet');
  assert.equal(idOf('SAU'), 'sau');
  assert.equal(idOf('Sylhet Agricultural University'), 'sauS');
  assert.equal(idOf('Dhaka University'), 'du');
});

test('an unknown spelling is not linked and gets suggestions', () => {
  const result = matchInstitution('Dhaka Univ.', 'admission', INSTITUTIONS);

  assert.equal(result.status, 'not_found');
  if (result.status === 'not_found') {
    assert.equal(result.suggestions[0], 'University of Dhaka (DU)');
  }
});

test('two identical names are reported as ambiguous, not guessed', () => {
  const rows = [inst('x1', 'Example University', '', 'EX1', '1'), inst('x2', 'Example University', '', 'EX2', '2')];
  assert.equal(matchInstitution('Example University', 'admission', rows).status, 'ambiguous');
});

test('unit labels match by code, English name or Bengali name', () => {
  const du = UNITS.get('du') ?? [];
  const idFor = (label: string): string | null => {
    const result = matchUnit(label, du);
    return result.status === 'matched' ? result.unit.id : null;
  };

  assert.equal(idFor('A'), 'du-a');
  assert.equal(idFor('A Unit'), 'du-a');
  assert.equal(idFor('Unit A (Science)'), 'du-a');
  assert.equal(idFor('ক ইউনিট'), 'du-a');
  assert.equal(idFor('Cha'), 'du-cha');
  assert.equal(idFor('IBA'), 'du-iba');
  assert.equal(idFor('Ka'), null);
});

test('applyReferenceChecks links ids and canonical names onto the questions', () => {
  const parsed = parseQuestionText(`
@source: admission
@institution: Rajshahi University
@unit: C Unit
@year: 2025-26
Q: One
A: x
B: y
ANS: A
---
Q: Two
A: x
B: y
ANS: B
`);

  const checks = applyReferenceChecks(parsed.questions, INSTITUTIONS, UNITS);

  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'ok');
  assert.equal(checks[0].questions, 2);
  assert.deepEqual(parsed.questions[0].exam_references[0], {
    source_kind: 'admission',
    institution_name: 'University of Rajshahi',
    unit_name: 'Unit C (Science)',
    year: '2025-26',
    institution_id: 'ru',
    unit_id: 'ru-c',
  });
});

test('unmatched institution stays as typed; unmatched unit stays as text', () => {
  const parsed = parseQuestionText(`
@source: admission
@institution: Dhaka Univ.
Q: One
A: x
B: y
ANS: A
---
@institution: BUET
@unit: A
Q: Two
A: x
B: y
ANS: A
---
@institution: DU
@unit: Ka
Q: Three
A: x
B: y
ANS: A
`);

  const checks = applyReferenceChecks(parsed.questions, INSTITUTIONS, UNITS);
  const statuses = checks.map((check) => check.status);

  assert.deepEqual(statuses, ['institution_not_found', 'unit_not_found', 'unit_not_found']);
  assert.equal(parsed.questions[0].exam_references[0].institution_name, 'Dhaka Univ.');
  assert.ok(!('institution_id' in parsed.questions[0].exam_references[0]));
  assert.match(checks[1].message, /no admission units/);
  assert.ok((checks[2].suggestions ?? []).includes('Unit A (Science)'));
  assert.equal(parsed.questions[2].exam_references[0].institution_id, 'du');
  assert.ok(!('unit_id' in parsed.questions[2].exam_references[0]));
});
