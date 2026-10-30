import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADMISSION_PRACTICE_MAX_QUESTIONS,
  buildUnitSubjectPool,
  countEligibleQuestionsPerPaper,
  groupPastExams,
  resolvePaperMode,
  resolvePaperSession,
  selectModelTests,
  selectPracticeQuestionIds,
  type AdmissionPaperRow,
  type AdmissionQuestionRow,
} from './admissions.practice';

const paper = (
  id: string,
  title: string,
  meta: Record<string, unknown> = {},
  overrides: Partial<AdmissionPaperRow> = {}
): AdmissionPaperRow => ({
  id,
  title,
  meta_data: meta,
  created_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

test('paper mode prefers canonical exam_mode over legacy metadata', () => {
  assert.equal(resolvePaperMode(paper('a', 'any', { exam_mode: 'past_exam' })), 'past_exam');
  assert.equal(resolvePaperMode(paper('b', 'any', { exam_mode: 'model_test' })), 'model_test');
  assert.equal(
    resolvePaperMode(paper('c', 'any', { exam_mode: 'subject_practice' })),
    'subject_practice'
  );
});

test('legacy papers fall back to session, model number and title', () => {
  assert.equal(
    resolvePaperMode(paper('session', 'ঢাবি ভর্তি ২০২৪', { admission_session: '2024-2025' })),
    'past_exam'
  );
  assert.equal(resolvePaperMode(paper('model', 'মডেল টেস্ট', { model_test_no: 3 })), 'model_test');
  assert.equal(resolvePaperMode(paper('title-model', 'Model Test 2024')), 'model_test');
  assert.equal(resolvePaperMode(paper('title-year', 'ঢাকা বিশ্ববিদ্যালয় 2023')), 'past_exam');
  assert.equal(resolvePaperMode(paper('none', 'ভর্তি প্রস্তুতি')), null);
});

test('session labels use the declared session, then the declared year, then the title year', () => {
  assert.equal(
    resolvePaperSession(paper('a', 'any', { admission_session: '2025-2026' })),
    '2025-2026'
  );
  assert.equal(resolvePaperSession(paper('b', 'any', { year: 2022 })), '2022');
  assert.equal(resolvePaperSession(paper('c', 'ঢাবি ২০২১')), null);
  assert.equal(resolvePaperSession(paper('d', 'DU 2021')), '2021');
});

test('past exams group newest session first and unitless sessions last', () => {
  const groups = groupPastExams([
    paper('p2023', 'DU 2023', { exam_mode: 'past_exam', admission_session: '2023-2024' }),
    paper('p2025', 'DU 2025', { exam_mode: 'past_exam', admission_session: '2025-2026' }),
    paper('pnone', 'DU old', { exam_mode: 'past_exam' }),
    paper('model', 'Model 1', { exam_mode: 'model_test' }),
    paper('practice', 'Practice', { exam_mode: 'subject_practice' }),
  ]);

  assert.deepEqual(
    groups.map((group) => group.session),
    ['2025-2026', '2023-2024', null]
  );
  assert.deepEqual(
    groups.flatMap((group) => group.papers.map((item) => item.id)),
    ['p2025', 'p2023', 'pnone']
  );
});

test('model tests sort by their declared number and never include other modes', () => {
  const papers = [
    paper('m2', 'Model 2', { exam_mode: 'model_test', model_test_no: 2 }),
    paper('m1', 'Model 1', { exam_mode: 'model_test', model_test_no: 1 }),
    paper('past', 'Past', { exam_mode: 'past_exam', admission_session: '2024' }),
    paper('practice', 'Practice', { exam_mode: 'subject_practice' }),
  ];

  assert.deepEqual(
    selectModelTests(papers).map((item) => item.id),
    ['m1', 'm2']
  );
});

const questions: AdmissionQuestionRow[] = [
  { id: 'q1', subject_id: 'physics', chapter_id: 'ch1' },
  { id: 'q2', subject_id: 'physics', chapter_id: 'ch1' },
  { id: 'q3', subject_id: 'physics', chapter_id: 'ch2' },
  { id: 'q4', subject_id: 'chemistry', chapter_id: 'ch3' },
  { id: 'q5', subject_id: null, chapter_id: null },
];

test('the subject pool keeps counts per subject and chapter and drops untagged questions', () => {
  const pool = buildUnitSubjectPool(questions);

  assert.equal(pool.get('physics')?.questionIds.length, 3);
  assert.equal(pool.get('physics')?.byChapter.get('ch1')?.length, 2);
  assert.equal(pool.get('chemistry')?.questionIds.length, 1);
  assert.equal(pool.size, 2);
});

test('selection stays inside one subject and honours an optional chapter', () => {
  const pool = buildUnitSubjectPool(questions);

  const subjectOnly = selectPracticeQuestionIds(pool, {
    subjectId: 'physics',
    randomize: false,
  });
  assert.deepEqual(subjectOnly, ['q1', 'q2', 'q3']);

  const chapterOnly = selectPracticeQuestionIds(pool, {
    subjectId: 'physics',
    chapterId: 'ch2',
    randomize: false,
  });
  assert.deepEqual(chapterOnly, ['q3']);

  const foreignChapter = selectPracticeQuestionIds(pool, {
    subjectId: 'physics',
    chapterId: 'ch3',
    randomize: false,
  });
  assert.deepEqual(foreignChapter, []);
});

test('an unrelated subject never receives another subject question set', () => {
  const pool = buildUnitSubjectPool(questions);

  assert.deepEqual(selectPracticeQuestionIds(pool, { subjectId: 'math', randomize: false }), []);
  assert.deepEqual(
    selectPracticeQuestionIds(pool, { subjectId: 'chemistry', randomize: false }),
    ['q4']
  );
});

test('practice selection is capped by the request and by the hard maximum', () => {
  const pool = buildUnitSubjectPool(questions);

  assert.equal(selectPracticeQuestionIds(pool, { subjectId: 'physics', limit: 2 }).length, 2);
  assert.equal(
    selectPracticeQuestionIds(pool, {
      subjectId: 'physics',
      limit: ADMISSION_PRACTICE_MAX_QUESTIONS + 100,
    }).length,
    3
  );
});

test('paper question counts include only questions a started exam can serve', () => {
  const links = [
    { exam_id: 'p1', question_id: 'q1' },
    { exam_id: 'p1', question_id: 'q2' },
    { exam_id: 'p1', question_id: 'q3' },
    { exam_id: 'p1', question_id: 'q2' },
    { exam_id: 'p2', question_id: 'q3' },
    { exam_id: 'p2', question_id: null },
  ];

  const counts = countEligibleQuestionsPerPaper(links, ['q1', 'q2']);

  assert.equal(counts.get('p1'), 2, 'ineligible links must not be counted');
  assert.equal(counts.get('p2'), 0);
  assert.equal(counts.has('missing'), false);
});
