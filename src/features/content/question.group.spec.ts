import test from 'node:test';
import assert from 'node:assert/strict';
import type { InstitutionRecord } from './exam-references.core';
import { applyReferenceChecks } from './question.refcheck';
import { normalizeImportQuestion } from './question.import';
import { parseQuestionText } from './question.textparse';

const inst = (id: string, name_en: string, short_name: string, code: string): InstitutionRecord => ({
  id,
  name_en,
  name_bn: '',
  short_name,
  code,
  eiin: code,
  type: 'university',
});

const INSTITUTIONS = [
  inst('du', 'University of Dhaka', 'DU', '90000001'),
  inst('ru', 'University of Rajshahi', 'RU', '90000002'),
];

const UNIT = {
  id: 'du-a',
  institution_id: 'du',
  code: 'a',
  name_en: 'Unit A',
  name_bn: 'ক ইউনিট',
};

const UNITS = new Map([['du', [UNIT]]]);

const Q = 'Q: One\nA: x\nB: y\nANS: A\n';

test('admission questions require both an institution and a unit', () => {
  const missingInstitution = parseQuestionText(`@source: admission\n@unit: A\n${Q}`);
  assert.equal(missingInstitution.counts.valid, 0);
  assert.match(missingInstitution.errors[0].messages.join(' '), /@institution/);

  const missingUnit = parseQuestionText(`@source: admission\n@institution: DU\n${Q}`);
  assert.equal(missingUnit.counts.valid, 0);
  assert.match(missingUnit.errors[0].messages.join(' '), /@unit/);
});

test('an admission question with an institution and unit links to the real unit', () => {
  const parsed = parseQuestionText(
    `@source: admission\n@institution: DU\n@unit: A\n${Q}`
  );
  assert.equal(parsed.counts.valid, 1);

  const checks = applyReferenceChecks(parsed.questions, INSTITUTIONS, UNITS);
  assert.equal(checks[0].status, 'ok');
  assert.equal(parsed.questions[0].exam_references[0].unit_id, 'du-a');
});

test('a reference marked admission without a unit is reported as unit_required', () => {
  const parsed = parseQuestionText(`@source: unknown\n@kind: admission\n@institution: DU\n${Q}`);
  assert.equal(parsed.counts.valid, 1);

  const checks = applyReferenceChecks(parsed.questions, INSTITUTIONS, UNITS);
  assert.equal(checks[0].status, 'unit_required');
  assert.ok(!('unit_id' in parsed.questions[0].exam_references[0]));
});

test('model_test and guidebook sources do not require an institution or unit', () => {
  for (const source of ['model_test', 'guidebook', 'unknown']) {
    const parsed = parseQuestionText(`@source: ${source}\n${Q}`);
    assert.equal(parsed.counts.valid, 1, source);
    assert.deepEqual(parsed.questions[0].exam_references, []);
  }
});

test('@session is accepted as a backward-compatible alias for year metadata', () => {
  const parsed = parseQuestionText(
    `@source: admission\n@institution: DU\n@unit: A\n@session: 2025-26\n${Q}`
  );

  assert.equal(parsed.counts.valid, 1);
  assert.equal(parsed.questions[0].exam_references[0].year, '2025-26');
});

test('optional model-test metadata without an institution remains non-blocking', () => {
  const parsed = parseQuestionText(`@source: model_test\n@exam: Practice Set\n@session: 2025-26\n${Q}`);

  assert.equal(parsed.counts.valid, 1);
  assert.deepEqual(parsed.questions[0].exam_references, []);
  assert.ok(parsed.warnings.length > 0);
});

test('the legacy @group header is rejected instead of being classified', () => {
  const parsed = parseQuestionText(`@institution: DU\n@group: science\n${Q}`);

  assert.equal(parsed.counts.valid, 0);
  assert.match(parsed.errors[0].messages.join(' '), /unknown header "@group"/);
});

test('admission imports reject a reference without a unit', () => {
  const result = normalizeImportQuestion(
    {
      type: 'mcq',
      body: { text_bn: 'প্রশ্ন', text_en: 'Question', image_url: null },
      options: [
        { text_bn: 'ক', text_en: 'A', isCorrect: false },
        { text_bn: 'খ', text_en: 'B', isCorrect: true },
      ],
      difficulty_level: 'medium',
      source_type: 'admission',
      exam_references: [
        { source_kind: 'admission', institution_name: 'University of Dhaka' },
      ],
      subject_id: 'sub',
      chapter_id: 'chap',
    },
    0
  );

  assert.ok(
    result.errors.some((error) => error.includes('both an institution and an admission unit'))
  );
});

test('a legacy unit_group key is never stored on an imported reference', () => {
  const result = normalizeImportQuestion(
    {
      type: 'mcq',
      body: { text_bn: 'প্রশ্ন', text_en: 'Question', image_url: null },
      options: [
        { text_bn: 'ক', text_en: 'A', isCorrect: false },
        { text_bn: 'খ', text_en: 'B', isCorrect: true },
      ],
      difficulty_level: 'medium',
      source_type: 'admission',
      exam_references: [
        {
          source_kind: 'admission',
          institution_name: 'University of Dhaka',
          unit_name: 'A',
          unit_group: 'science',
        },
      ],
      subject_id: 'sub',
      chapter_id: 'chap',
    },
    0
  );

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.payload.exam_references, [
    { source_kind: 'admission', institution_name: 'University of Dhaka', unit_name: 'A' },
  ]);
});
