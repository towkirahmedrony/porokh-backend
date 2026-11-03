import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuestionText, TextParseValidationError } from './question.textparse';

const SAMPLE = `
@source: admission
@institution: Rajshahi University
@exam: A Unit
@unit: A
@year: ২০২৫-২৬
@difficulty: easy
@tags: biology, Cell Structure

Q_BN: প্রোটোপ্লাজমকে “জীবনের ভৌত ভিত্তি” হিসেবে ব্যক্ত করেন কে?
Q_EN: Who described protoplasm as the "physical basis of life"?
A: Jan E. Purkinje
B: Thomas Huxley
C: Robert Von Hanstein
D: Butschli
ANS: B
EXP_BN: টমাস হাক্সলি ১৮৬৮ সালে এটি বলেন।
EXP_EN: Thomas Huxley said it in 1868.
TAGS: protoplasm
---
Q: Choose the correct statement.
i. First statement
ii. Second statement
A_BN: i ও ii
A_EN: i and ii
B: ii only
ANS: ক
`;

test('parses a question and applies the batch defaults', () => {
  const result = parseQuestionText(SAMPLE);

  assert.deepEqual(result.errors, []);
  assert.equal(result.counts.valid, 2);

  const [first] = result.questions;
  assert.equal(first.body.text_en, 'Who described protoplasm as the "physical basis of life"?');
  assert.equal(first.body.image_url, null);
  assert.deepEqual(first.options.map((option) => option.id), [1, 2, 3, 4]);
  assert.deepEqual(first.options.map((option) => option.isCorrect), [false, true, false, false]);
  assert.equal(first.options[1].text_bn, 'Thomas Huxley');
  assert.equal(first.options[1].text_en, 'Thomas Huxley');
  assert.equal(first.difficulty_level, 'easy');
  assert.equal(first.source_type, 'admission');
  assert.deepEqual(first.tags, ['biology', 'cell_structure', 'protoplasm']);
  assert.deepEqual(first.exam_references, [
    {
      source_kind: 'admission',
      institution_name: 'Rajshahi University',
      exam_name: 'A Unit',
      unit_name: 'A',
      year: '2025-26',
    },
  ]);
  assert.ok(!('subject_id' in first));
});

test('keeps multi-line statements and accepts a Bengali answer letter', () => {
  const [, second] = parseQuestionText(SAMPLE).questions;

  assert.equal(
    second.body.text_bn,
    'Choose the correct statement.\ni. First statement\nii. Second statement'
  );
  assert.equal(second.options[0].text_bn, 'i ও ii');
  assert.equal(second.options[0].text_en, 'i and ii');
  assert.equal(second.options[0].isCorrect, true);
  assert.equal(second.tags.includes('protoplasm'), false);
});

test('reports only the broken question and still returns the valid ones', () => {
  const result = parseQuestionText(`
Q: One
A: x
B: y
ANS: A
---
Q: Two
A: x
B: y
---
Q: Three
A: x
C: z
ANS: A
`);

  assert.equal(result.counts.total, 3);
  assert.equal(result.counts.valid, 1);
  assert.deepEqual(
    result.errors.map((issue) => issue.question),
    [2, 3]
  );
  assert.match(result.errors[0].messages.join(' '), /ANS is missing/);
  assert.match(result.errors[1].messages.join(' '), /Option B is missing/);
});

test('a later @ block changes the defaults for the following questions', () => {
  const result = parseQuestionText(`
@institution: University of Dhaka
Q: One
A: x
B: y
ANS: B
---
@institution: Jahangirnagar University
@year: 2024
Q: Two
A: x
B: y
ANS: A
`);

  assert.equal(result.questions[0].exam_references[0].institution_name, 'University of Dhaka');
  assert.equal(result.questions[1].exam_references[0].institution_name, 'Jahangirnagar University');
  assert.equal(result.questions[1].exam_references[0].year, '2024');
});

test('rejects invalid difficulty and source type, and ignores code fences', () => {
  const result = parseQuestionText('```\n@source: nonsense\nQ: One\nA: x\nB: y\nANS: A\nDIFF: insane\n```');

  assert.equal(result.counts.valid, 0);
  assert.match(result.errors[0].messages.join(' '), /DIFF "insane"/);
  assert.match(result.errors[0].messages.join(' '), /Source type "nonsense"/);
});

test('throws on empty text or text without questions', () => {
  assert.throws(() => parseQuestionText('   '), TextParseValidationError);
  assert.throws(() => parseQuestionText('just some words'), TextParseValidationError);
  assert.throws(() => parseQuestionText(42), TextParseValidationError);
});
