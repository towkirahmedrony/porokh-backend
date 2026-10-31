import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canEditQuestion,
  decideQuestionWrite,
  normalizeQuestionOptions,
} from './question.policy';

test('Editor and Teacher may update only questions they own', () => {
  assert.equal(canEditQuestion('editor', 'user-1', 'user-1'), true);
  assert.equal(canEditQuestion('teacher', 'user-1', 'user-1'), true);
  assert.equal(canEditQuestion('editor', 'user-1', 'user-2'), false);
  assert.equal(canEditQuestion('teacher', 'user-1', null), false);
});

test('Students cannot update questions and missing identity fails closed', () => {
  assert.equal(canEditQuestion('student', 'user-1', 'user-1'), false);
  assert.equal(canEditQuestion('student', 'user-1', 'user-2'), false);
  assert.equal(canEditQuestion('teacher', null, 'user-1'), false);
});

test('Only privileged content reviewer roles bypass question ownership', () => {
  assert.equal(canEditQuestion('admin', 'admin-1', 'author-1'), true);
  assert.equal(canEditQuestion('moderator', 'mod-1', 'author-1'), true);
  assert.equal(canEditQuestion('super_admin', 'root-1', 'author-1'), true);
});

test('imported options are stored with the canonical is_correct flag and an id', () => {
  const options = normalizeQuestionOptions([
    { text_bn: 'ক', text_en: 'A', isCorrect: true },
    { text_bn: 'খ', text_en: 'B', is_correct: 'true', image_url: '' },
    { text_bn: 'গ', text_en: 'C', id: 'opt-3' },
  ]);

  assert.deepEqual(options, [
    { text_bn: 'ক', text_en: 'A', id: 1, is_correct: true },
    { text_bn: 'খ', text_en: 'B', image_url: '', id: 2, is_correct: true },
    { text_bn: 'গ', text_en: 'C', id: 'opt-3', is_correct: false },
  ]);
});

test('a created question persists canonical options', () => {
  const { payload } = decideQuestionWrite({
    role: 'admin',
    mode: 'create',
    body: {
      type: 'mcq',
      body: { text_bn: 'প্রশ্ন' },
      options: [{ text_bn: 'ক', isCorrect: true }],
    },
  });

  assert.deepEqual(payload.options, [{ text_bn: 'ক', id: 1, is_correct: true }]);
});
