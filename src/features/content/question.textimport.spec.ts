import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PARSE_TEXT_LENGTH, parseQuestionText } from './question.textparse';
import {
  TextImportValidationError,
  applyTextImportTaxonomy,
  readTextImportRequest,
} from './question.textimport';

/**
 * Pure checks for the plain-text import contract: transport validation and the
 * taxonomy attach step. Database writes are covered by the import service's own
 * policy tests, which this endpoint reuses.
 */

const VALID_TEXT = `@source: admission
@institution: University of Dhaka
@unit: A
@year: 2024-25

Q_BN: বাংলাদেশের রাজধানী কোনটি?
Q_EN: What is the capital of Bangladesh?
A_BN: ঢাকা
A_EN: Dhaka
B_BN: খুলনা
B_EN: Khulna
ANS: A
EXP_BN: ঢাকা বাংলাদেশের রাজধানী।
EXP_EN: Dhaka is the capital of Bangladesh.
DIFF: easy
TAGS: bangladesh, capital`;

const TAXONOMY = { subject_id: 'subject-1', chapter_id: 'chapter-1' };

test('readTextImportRequest trims text and requires a subject and chapter', () => {
  assert.deepEqual(
    readTextImportRequest({ text: `  ${VALID_TEXT}  `, ...TAXONOMY, topic_id: ' topic-1 ' }),
    {
      text: VALID_TEXT,
      taxonomy: { subject_id: 'subject-1', chapter_id: 'chapter-1', topic_id: 'topic-1' },
    }
  );
});

test('readTextImportRequest rejects an empty body, text, subject or chapter', () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /must be an object/],
    [[], /must be an object/],
    [{ ...TAXONOMY }, /text is required/],
    [{ text: '   ', ...TAXONOMY }, /text is required/],
    [{ text: VALID_TEXT, chapter_id: 'chapter-1' }, /subject_id is required/],
    [{ text: VALID_TEXT, subject_id: 'subject-1' }, /chapter_id is required/],
  ];

  for (const [body, pattern] of cases) {
    assert.throws(() => readTextImportRequest(body), pattern);
  }
});

test('readTextImportRequest enforces the shared 90k plain-text limit', () => {
  assert.throws(
    () =>
      readTextImportRequest({
        text: 'x'.repeat(MAX_PARSE_TEXT_LENGTH + 1),
        ...TAXONOMY,
      }),
    /too long/
  );

  assert.equal(MAX_PARSE_TEXT_LENGTH, 90_000);
  assert.ok(new TextImportValidationError('x') instanceof Error);
});

test('applyTextImportTaxonomy adds the curriculum ids without changing content', () => {
  const parsed = parseQuestionText(VALID_TEXT);
  assert.equal(parsed.counts.valid, 1);

  const [question] = applyTextImportTaxonomy(parsed.questions, {
    ...TAXONOMY,
    topic_id: 'topic-1',
  });

  assert.equal(question.subject_id, 'subject-1');
  assert.equal(question.chapter_id, 'chapter-1');
  assert.equal(question.topic_id, 'topic-1');
  assert.equal(question.type, 'mcq');
  assert.equal((question.options as Array<{ isCorrect: boolean }>)[0].isCorrect, true);
  assert.deepEqual(question.exam_references, [
    {
      source_kind: 'admission',
      institution_name: 'University of Dhaka',
      unit_name: 'A',
      year: '2024-25',
    },
  ]);
});

test('a question without a topic never carries a topic_id key', () => {
  const parsed = parseQuestionText(VALID_TEXT);
  const [question] = applyTextImportTaxonomy(parsed.questions, TAXONOMY);

  assert.equal('topic_id' in question, false);
});

test('readTextImportRequest carries an explicitly selected preparation category', () => {
  const request = readTextImportRequest({
    text: VALID_TEXT,
    ...TAXONOMY,
    preparation_category: 'both',
  });

  assert.equal(request.preparation_present, true);
  assert.equal(request.preparation_category, 'both');
});

test('readTextImportRequest rejects an unknown preparation category', () => {
  assert.throws(
    () =>
      readTextImportRequest({
        text: VALID_TEXT,
        ...TAXONOMY,
        preparation_category: 'varsity',
      }),
    /preparation_category/
  );
});

test('applyTextImportTaxonomy places every parsed question in the selected bank', () => {
  const parsed = parseQuestionText(VALID_TEXT);
  const [question] = applyTextImportTaxonomy(parsed.questions, TAXONOMY, {
    present: true,
    category: 'admission',
  });

  assert.equal(question.preparation_category, 'admission');
});
