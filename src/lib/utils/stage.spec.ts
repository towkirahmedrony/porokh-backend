import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStage, isExamEnded } from './stage';

const TODAY = '2026-11-26';

test('an exam counts as finished only from the day after its end date', () => {
  assert.equal(isExamEnded(null, TODAY), false);
  assert.equal(isExamEnded('2027-06-30', TODAY), false);
  assert.equal(isExamEnded(TODAY, TODAY), false);
  assert.equal(isExamEnded('2026-11-26', '2026-11-27'), true);
});

test('no exam end date means the student is still studying', () => {
  for (const goal of [null, 'hsc', 'medical', 'varsity']) {
    for (const confirmedAt of [null, '2026-01-01T00:00:00.000Z']) {
      assert.equal(
        computeStage(
          { study_goal: goal, goal_confirmed_at: confirmedAt, exam_end_date: null },
          TODAY
        ),
        'studying'
      );
    }
  }
});

test('a future exam keeps every goal in the studying stage', () => {
  assert.equal(
    computeStage(
      { study_goal: 'medical', goal_confirmed_at: '2026-01-01T00:00:00.000Z', exam_end_date: '2027-06-30' },
      TODAY
    ),
    'studying'
  );
});

test('after the exam, an unsettled goal needs the gate', () => {
  const ended = '2026-10-01';
  const settled = '2026-01-01T00:00:00.000Z';

  const cases = [
    { study_goal: null, goal_confirmed_at: null },
    { study_goal: 'hsc', goal_confirmed_at: settled },
    { study_goal: 'varsity', goal_confirmed_at: null },
    { study_goal: 'medical', goal_confirmed_at: null },
  ];

  for (const input of cases) {
    assert.equal(computeStage({ ...input, exam_end_date: ended }, TODAY), 'post_hsc');
  }
});

test('after the exam, a confirmed admission goal is admission prep', () => {
  const settled = '2026-01-01T00:00:00.000Z';

  for (const goal of ['medical', 'engineering', 'varsity']) {
    assert.equal(
      computeStage(
        { study_goal: goal, goal_confirmed_at: settled, exam_end_date: '2026-10-01' },
        TODAY
      ),
      'admission_prep'
    );
  }
});

/**
 * The client clock never reaches this rule: the stage is a pure function of the
 * stored row and a server day key. Two devices with different local dates, and
 * two calls at different wall-clock times, produce the same answer.
 */
test('the stage depends on the server day key, not on any device clock', () => {
  const row = {
    study_goal: 'varsity' as const,
    goal_confirmed_at: '2026-01-01T00:00:00.000Z',
    exam_end_date: '2026-10-01',
  };

  assert.equal(computeStage(row, TODAY), computeStage({ ...row }, TODAY));
  assert.equal(computeStage(row, '2026-10-01'), 'studying');
  assert.equal(computeStage(row, '2026-10-02'), 'admission_prep');
});
