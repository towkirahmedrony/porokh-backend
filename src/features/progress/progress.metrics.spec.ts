import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProgressSnapshot,
  dhakaDateKey,
  resolveLevel,
  type ProgressChapterLabel,
  type ProgressDetailRow,
  type ProgressHistoryRow,
  type ProgressLevelRow,
  type ProgressSnapshotInput,
  type ProgressSubjectLabel,
  type ProgressTopicLabel,
} from './progress.metrics';

const NOW = Date.parse('2026-11-26T10:00:00.000Z');

const subject = (id: string, bn: string, en: string | null = null): ProgressSubjectLabel => ({
  id,
  name_bn: bn,
  name_en: en,
});

const chapter = (
  id: string,
  subjectId: string,
  bn: string
): ProgressChapterLabel => ({ id, subject_id: subjectId, name_bn: bn, name_en: null });

const topic = (id: string, chapterId: string, bn: string): ProgressTopicLabel => ({
  id,
  chapter_id: chapterId,
  name_bn: bn,
  name_en: null,
});

const history = (overrides: Partial<ProgressHistoryRow> & { id: string }): ProgressHistoryRow => ({
  exam_id: null,
  score: 0,
  total_marks: 30,
  submitted_at: '2026-10-19T05:29:49.621Z',
  created_at: '2026-10-19T05:29:50.337Z',
  status: null,
  practice_mode: null,
  ...overrides,
});

let detailSequence = 0;

const detail = (
  examHistoryId: string,
  isCorrect: boolean | null,
  subjectId: string | null = '101',
  chapterId: string | null = 'ch1',
  topicId: string | null = 't1'
): ProgressDetailRow => {
  detailSequence += 1;

  return {
    exam_history_id: examHistoryId,
    question_id: `${examHistoryId}-${detailSequence}`,
    is_correct: isCorrect,
    subject_id: subjectId,
    chapter_id: chapterId,
    topic_id: topicId,
  };
};

const levels: ProgressLevelRow[] = [
  { id: 1, name_bn: 'শিক্ষানবিশ', name_en: 'Beginner', min_xp: 0, max_xp: 200 },
  { id: 2, name_bn: 'আগ্রহী', name_en: 'Curious', min_xp: 201, max_xp: 999 },
];

const labels = {
  subjects: [subject('101', 'বাংলা প্রথম পত্র', 'Bangla 1st'), subject('english', 'ইংরেজি', 'English')],
  chapters: [chapter('ch1', '101', 'গদ্য'), chapter('ch2', 'english', 'Grammar')],
  topics: [topic('t1', 'ch1', 'অর্ধাঙ্গী'), topic('t2', 'ch1', 'বিলাসী'), topic('t3', 'ch2', 'Voice')],
};

const baseInput = (overrides: Partial<ProgressSnapshotInput> = {}): ProgressSnapshotInput => ({
  history: [],
  details: [],
  subjects: labels.subjects,
  chapters: labels.chapters,
  topics: labels.topics,
  levels,
  totalXp: 120,
  streakDays: 0,
  longestStreakDays: 0,
  now: NOW,
  ...overrides,
});

const realSeven = [
  history({ id: 'h1', score: 2.75, total_marks: 30, submitted_at: '2026-10-19T05:29:49.621Z' }),
  history({ id: 'h2', score: 0.25, total_marks: 30, submitted_at: '2026-10-20T05:15:21.829Z' }),
  history({ id: 'h3', score: 0, total_marks: 30, submitted_at: '2026-10-21T13:05:57.542Z' }),
  history({ id: 'h4', score: 0, total_marks: 30, submitted_at: '2026-10-26T15:13:28.532Z' }),
  history({ id: 'h5', score: 0, total_marks: 30, submitted_at: '2026-10-26T16:16:28.818Z' }),
  history({
    id: 'h6',
    exam_id: 'seed-test-bn-hsc',
    score: 0.75,
    total_marks: 20,
    submitted_at: '2026-10-30T06:31:21.967Z',
  }),
  history({ id: 'h7', score: 0, total_marks: 60, submitted_at: '2026-11-08T19:10:26.576Z' }),
];

test('zero attempts produce null percentages, not zeros', () => {
  const snapshot = buildProgressSnapshot(baseInput());

  assert.equal(snapshot.summary.exams_taken, 0);
  assert.equal(snapshot.summary.accuracy_pct, null);
  assert.equal(snapshot.summary.average_score_pct, null);
  assert.equal(snapshot.summary.responses, 0);
  assert.deepEqual(snapshot.performance, []);
  assert.deepEqual(snapshot.subjects, []);
  assert.deepEqual(snapshot.weaknesses, []);
  assert.equal(snapshot.mentor.kind, 'no_attempts');
  assert.equal(snapshot.mentor.href, '/exams/model');
});

test('the account history averages per attempt and counts seven exams', () => {
  const snapshot = buildProgressSnapshot(baseInput({ history: realSeven, details: [] }));

  assert.equal(snapshot.summary.exams_taken, 7);
  assert.equal(snapshot.summary.average_score_pct, 1.96);
  assert.equal(snapshot.performance.length, 7);
  assert.equal(snapshot.performance[0].score_pct, 9.17);
  assert.equal(snapshot.performance[6].score_pct, 0);

  const twoOnOneDay = snapshot.activity.days.find((day) => day.date === '2026-10-26');
  assert.equal(twoOnOneDay?.count, 2);
  assert.equal(
    snapshot.activity.days.reduce((sum, day) => sum + day.count, 0),
    7
  );
});

test('activity buckets the late UTC attempt into the next Dhaka day', () => {
  const snapshot = buildProgressSnapshot(baseInput({ history: [realSeven[6]] }));
  assert.equal(snapshot.activity.days[0].date, '2026-11-09');
  assert.equal(dhakaDateKey('2026-11-08T19:10:26.576Z'), '2026-11-09');
  assert.equal(dhakaDateKey('not-a-date'), null);
  assert.equal(dhakaDateKey(null), null);
});

test('fraud, missing timestamps and zero totals are excluded', () => {
  const snapshot = buildProgressSnapshot(
    baseInput({
      history: [
        history({ id: 'ok', score: 10, total_marks: 20, submitted_at: '2026-10-19T05:00:00Z' }),
        history({ id: 'fraud', score: 20, total_marks: 20, status: 'fraud_detected' }),
        history({ id: 'zero', score: 0, total_marks: 0 }),
        history({ id: 'undated', score: 5, total_marks: 10, submitted_at: null, created_at: null }),
      ],
    })
  );

  assert.equal(snapshot.summary.exams_taken, 2);
  assert.equal(snapshot.summary.average_score_pct, 50);
  assert.equal(snapshot.performance.length, 1);
  assert.equal(snapshot.activity.days.length, 1);
});

test('practice attempts stay out of the exam count but feed accuracy', () => {
  const snapshot = buildProgressSnapshot(
    baseInput({
      history: [
        history({ id: 'exam', score: 10, total_marks: 20 }),
        history({ id: 'practice', practice_mode: 'wrong_global', score: 0, total_marks: 10 }),
      ],
      details: [detail('exam', true), detail('practice', false)],
    })
  );

  assert.equal(snapshot.summary.exams_taken, 1);
  assert.equal(snapshot.summary.practice_sessions, 1);
  assert.equal(snapshot.summary.average_score_pct, 50);
  assert.equal(snapshot.summary.accuracy_pct, 50);
});

test('all skipped is 0% accuracy and a 100% topic error rate', () => {
  const snapshot = buildProgressSnapshot(
    baseInput({
      history: [history({ id: 'h1' })],
      details: [detail('h1', null), detail('h1', null), detail('h1', null)],
    })
  );

  assert.equal(snapshot.summary.accuracy_pct, 0);
  assert.equal(snapshot.summary.correct, 0);
  assert.equal(snapshot.summary.skipped, 3);
  assert.equal(snapshot.weaknesses[0].error_rate_pct, 100);
  assert.equal(snapshot.weaknesses[0].responses, 3);
  assert.equal(snapshot.mentor.skipped_heavy, true);
});

test('subject and chapter totals follow the responses, and topic ties break on volume', () => {
  const snapshot = buildProgressSnapshot(
    baseInput({
      history: [history({ id: 'h1' }), history({ id: 'h2' })],
      details: [
        detail('h1', false, '101', 'ch1', 't1'),
        detail('h1', null, '101', 'ch1', 't1'),
        detail('h1', null, '101', 'ch1', 't1'),
        detail('h1', true, '101', 'ch1', 't2'),
        detail('h1', null, 'english', 'ch2', 't3'),
        detail('h2', null, 'english', 'ch2', 't3'),
      ],
    })
  );

  assert.equal(snapshot.subjects.length, 2);

  const bangla = snapshot.subjects.find((row) => row.subject_id === '101');
  assert.equal(bangla?.responses, 4);
  assert.equal(bangla?.correct, 1);
  assert.equal(bangla?.wrong, 1);
  assert.equal(bangla?.skipped, 2);
  assert.equal(bangla?.accuracy_pct, 25);
  assert.equal(bangla?.attempts, 1);
  assert.equal(bangla?.chapters[0].name_bn, 'গদ্য');
  assert.equal(bangla?.chapters[0].responses, 4);

  assert.equal(snapshot.subjects[0].subject_id, '101');
  assert.equal(snapshot.weaknesses[0].topic_id, 't1');
  assert.equal(snapshot.weaknesses[0].error_rate_pct, 100);
  assert.equal(snapshot.weaknesses[1].topic_id, 't3');
  assert.equal(snapshot.mentor.kind, 'weakest_topic');
  assert.equal(
    snapshot.mentor.href,
    '/question-bank?subject=101&topic=t1'
  );
});

test('an orphan topic is dropped rather than shown unlabeled', () => {
  const snapshot = buildProgressSnapshot(
    baseInput({
      history: [history({ id: 'h1' })],
      details: [detail('h1', false, '101', 'ch1', 't1'), detail('h1', false, '101', 'ch1', 'unknown')],
    })
  );

  assert.equal(snapshot.weaknesses.length, 1);
  assert.equal(snapshot.weaknesses[0].topic_id, 't1');
  assert.equal(snapshot.weaknesses[0].subject_id, '101');
});

test('level lookup honours the boundary and the next threshold', () => {
  const beginner = resolveLevel(200, levels);
  assert.equal(beginner?.id, 1);
  assert.equal(beginner?.next_min_xp, 201);

  const curious = resolveLevel(201, levels);
  assert.equal(curious?.id, 2);
  assert.equal(curious?.next_min_xp, null);

  const negative = resolveLevel(-10, levels);
  assert.equal(negative?.id, 1);
});

test('a user with attempts but no analyzable responses gets a subject mentor', () => {
  const snapshot = buildProgressSnapshot(
    baseInput({
      history: [history({ id: 'h1' })],
      details: [],
    })
  );

  assert.equal(snapshot.mentor.kind, 'weakest_subject');
  assert.equal(snapshot.mentor.subject_id, null);
  assert.equal(snapshot.mentor.href, '/question-bank');
});

test('streak values are floored at zero', () => {
  const snapshot = buildProgressSnapshot(
    baseInput({ streakDays: -3, longestStreakDays: 3 })
  );
  assert.equal(snapshot.summary.streak_days, 0);
  assert.equal(snapshot.summary.longest_streak_days, 3);
});
