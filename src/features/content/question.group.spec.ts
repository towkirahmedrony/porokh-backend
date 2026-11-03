import test from 'node:test';
import assert from 'node:assert/strict';
import type { InstitutionRecord } from './exam-references.core';
import { applyReferenceChecks, type AdmissionUnitWithGroup } from './question.refcheck';
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
  inst('ju', 'Jahangirnagar University', 'JU', '90000003'),
  inst('cu', 'University of Chittagong', 'CU', '90000004'),
  inst('buet', 'Bangladesh University of Engineering and Technology', 'BUET', '90000009'),
];

const u = (
  id: string,
  institution_id: string,
  code: string,
  name_en: string,
  group_type: string
): AdmissionUnitWithGroup => ({ id, institution_id, code, name_en, name_bn: name_en, group_type });

const UNITS = new Map<string, AdmissionUnitWithGroup[]>([
  ['du', [
    u('du-a', 'du', 'a', 'Unit A (Science)', 'science'),
    u('du-b', 'du', 'b', 'Unit B (Arts)', 'humanities'),
    u('du-c', 'du', 'c', 'Unit C (Business Studies)', 'commerce'),
  ]],
  ['ru', [
    u('ru-a', 'ru', 'a', 'Unit A (Humanities)', 'humanities'),
    u('ru-b', 'ru', 'b', 'Unit B (Business)', 'commerce'),
    u('ru-c', 'ru', 'c', 'Unit C (Science)', 'science'),
  ]],
  ['ju', [
    u('ju-a', 'ju', 'a', 'Unit A (Mathematical and Physical Sciences)', 'science'),
    u('ju-d', 'ju', 'd', 'Unit D (Biological Sciences)', 'science'),
    u('ju-b', 'ju', 'b', 'Unit B (Social Sciences)', 'humanities'),
  ]],
  ['cu', [
    u('cu-a', 'cu', 'a', 'Unit A (Science)', 'science'),
    u('cu-d', 'cu', 'd', 'Unit D (Social Science and Law)', 'all'),
  ]],
]);

const run = (text: string) => {
  const parsed = parseQuestionText(text);
  const checks = applyReferenceChecks(parsed.questions, INSTITUTIONS, UNITS);
  return { parsed, checks };
};

const Q = 'Q: One\nA: x\nB: y\nANS: A\n';

test('a group alone picks the single matching unit of each university', () => {
  const { parsed, checks } = run(`@institution: DU\n@group: science\n${Q}---\n@institution: RU\n@group: science\n${Q}`);

  assert.deepEqual(checks.map((check) => check.status), ['ok', 'ok']);
  assert.equal(parsed.questions[0].exam_references[0].unit_id, 'du-a');
  assert.equal(parsed.questions[1].exam_references[0].unit_id, 'ru-c');
  assert.equal(checks[1].unit?.group, 'science');
  assert.ok(!('unit_group' in parsed.questions[0].exam_references[0]));
});

test('a group with several units asks for the unit instead of guessing', () => {
  const { parsed, checks } = run(`@institution: JU\n@group: science\n${Q}`);

  assert.equal(checks[0].status, 'unit_ambiguous');
  assert.equal(checks[0].suggestions?.length, 2);
  assert.ok(!('unit_id' in parsed.questions[0].exam_references[0]));
  assert.equal(parsed.questions[0].exam_references[0].institution_id, 'ju');
});

test('units for every group (all) are not picked by a group lookup', () => {
  const { parsed } = run(`@institution: CU\n@group: science\n${Q}`);

  assert.equal(parsed.questions[0].exam_references[0].unit_id, 'cu-a');
});

test('a unit that belongs to a different group is flagged, not linked', () => {
  const { parsed, checks } = run(`@institution: RU\n@unit: A\n@group: science\n${Q}`);

  assert.equal(checks[0].status, 'unit_group_mismatch');
  assert.match(checks[0].message, /humanities, not science/);
  assert.deepEqual(checks[0].suggestions, ['Unit C (Science)']);
  assert.ok(!('unit_id' in parsed.questions[0].exam_references[0]));
});

test('a matching unit and group link normally; no group means no check', () => {
  const { checks } = run(`@institution: RU\n@unit: C\n@group: science\n${Q}---\n@institution: RU\n@unit: A\n${Q}`);

  assert.deepEqual(checks.map((check) => check.status), ['ok', 'ok']);
});

test('an institution without units reports that the group cannot be linked', () => {
  const { checks } = run(`@institution: BUET\n@group: science\n${Q}`);

  assert.equal(checks[0].status, 'unit_not_found');
  assert.match(checks[0].message, /no admission units/);
});

test('a new institution does not inherit the previous unit, group or exam', () => {
  const parsed = parseQuestionText(
    `@institution: DU\n@unit: A\n@group: science\n@exam: A Unit\n${Q}---\n@institution: RU\n${Q}`
  );

  assert.equal(parsed.questions[0].exam_references[0].unit_name, 'A');
  assert.deepEqual(parsed.questions[1].exam_references[0], {
    source_kind: 'admission',
    institution_name: 'RU',
  });
});

test('Bengali group names are accepted and unknown ones are rejected', () => {
  const ok = parseQuestionText(`@institution: DU\n@group: বিজ্ঞান\n${Q}`);
  assert.equal(ok.questions[0].exam_references[0].unit_group, 'science');

  const bad = parseQuestionText(`@institution: DU\n@group: engineering\n${Q}`);
  assert.equal(bad.counts.valid, 0);
  assert.match(bad.errors[0].messages.join(' '), /GROUP "engineering"/);
});
