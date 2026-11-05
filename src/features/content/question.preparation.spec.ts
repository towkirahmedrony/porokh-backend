import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PreparationCategoryValidationError,
  assertPreparationCategory,
  categoryFromTrackIds,
  parsePreparationCategory,
  trackIdsForCategory,
} from './question.preparation';
import { buildQuestionContentHash } from './question.policy';

test('reads the three canonical preparation categories', () => {
  assert.deepEqual(parsePreparationCategory('hsc'), { present: true, category: 'hsc' });
  assert.deepEqual(parsePreparationCategory(' Admission '), {
    present: true,
    category: 'admission',
  });
  assert.deepEqual(parsePreparationCategory('both'), { present: true, category: 'both' });
});

test('accepts the documented both combinations without widening storage values', () => {
  for (const value of ['hsc+admission', 'admission + hsc', 'hsc,admission', 'admission and hsc']) {
    assert.deepEqual(parsePreparationCategory(value), { present: true, category: 'both' });
  }
});

test('empty and null clear the category while an absent field stays untouched', () => {
  assert.deepEqual(parsePreparationCategory(undefined), { present: false, category: null });
  assert.deepEqual(parsePreparationCategory(null), { present: true, category: null });
  assert.deepEqual(parsePreparationCategory('  '), { present: true, category: null });
  assert.deepEqual(parsePreparationCategory('none'), { present: true, category: null });
});

test('unknown values are rejected instead of silently stored', () => {
  const parsed = parsePreparationCategory('varsity');
  assert.equal(parsed.category, null);
  assert.match(parsed.error ?? '', /hsc, admission, both/);

  assert.throws(
    () => assertPreparationCategory('medical'),
    PreparationCategoryValidationError
  );
});

test('maps categories to junction tracks and back', () => {
  assert.deepEqual(trackIdsForCategory('hsc'), ['hsc']);
  assert.deepEqual(trackIdsForCategory('admission'), ['admission']);
  assert.deepEqual(trackIdsForCategory('both'), ['hsc', 'admission']);
  assert.deepEqual(trackIdsForCategory(null), []);
});

test('reading tracks preserves other preparation tracks', () => {
  assert.equal(categoryFromTrackIds(['hsc', 'medical']), 'hsc');
  assert.equal(categoryFromTrackIds(['engineering', 'admission']), 'admission');
  assert.equal(categoryFromTrackIds(['medical', 'hsc', 'admission']), 'both');
  assert.equal(categoryFromTrackIds(['engineering', 'varsity']), null);
});

test('preparation category never changes the duplicate content hash', () => {
  const question = {
    type: 'mcq',
    subject_id: 'subject-1',
    chapter_id: 'chapter-1',
    body: { text_bn: 'প্রশ্ন', text_en: 'Question', image_url: null },
    options: [{ id: 1, text_bn: 'ক', text_en: 'A', isCorrect: true }],
    difficulty_level: 'medium',
    source_type: 'board_exam',
    tags: ['hsc'],
    exam_references: [],
  };

  const withoutCategory = buildQuestionContentHash(question);
  const withCategory = buildQuestionContentHash({ ...question, preparation_category: 'both' });

  assert.equal(withoutCategory, withCategory);
});
