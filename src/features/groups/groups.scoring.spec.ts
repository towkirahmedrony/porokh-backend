import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTimeTaken, scoreBattleAnswers } from './groups.scoring';

const questions = [
  { id: 'q1', options: [{ id: 'a', is_correct: true }, { id: 'b' }] },
  { id: 'q2', options: [{ id: 'a' }, { id: 'b', isCorrect: true }] },
  { id: 'q3', options: [{ id: 'a' }, { id: 'b' }] },
];

test('grading applies +1, -0.25 and skips unknown ids', () => {
  const result = scoreBattleAnswers(questions, {
    q1: 'a',
    q2: 'a',
    q3: 'missing-option',
    unknown: 'a',
  });

  assert.deepEqual(result, {
    score: 0.75,
    correct_count: 1,
    wrong_count: 1,
    skipped_count: 1,
    total_questions: 3,
  });
});

test('scores never go below zero', () => {
  const result = scoreBattleAnswers(questions, { q1: 'b', q2: 'a', q3: 'a' });
  assert.equal(result.score, 0);
  assert.equal(result.wrong_count, 3);
});

test('missing answers are skipped', () => {
  const result = scoreBattleAnswers(questions, {});
  assert.equal(result.skipped_count, 3);
  assert.equal(result.correct_count, 0);
});

test('time taken is clamped to the battle window', () => {
  const start = new Date('2026-01-01T10:00:00.000Z').toISOString();
  assert.equal(computeTimeTaken(start, Date.parse('2026-01-01T10:05:00.000Z'), 20), 300);
  assert.equal(computeTimeTaken(start, Date.parse('2026-01-01T12:00:00.000Z'), 1), 60);
  assert.equal(computeTimeTaken(start, Date.parse('2026-01-01T09:00:00.000Z'), 20), 0);
  assert.equal(computeTimeTaken(null, Date.now(), 20), 0);
});
