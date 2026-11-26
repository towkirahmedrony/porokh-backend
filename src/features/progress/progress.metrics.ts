/**
 * Pure aggregation for the Progress dashboard.
 *
 * Every number the screen shows is derived here from rows the caller has
 * already scoped to one user, so the rules can be tested without a database:
 *
 * - accuracy      = correct responses / all responses
 * - topic error   = (wrong + skipped) / all responses for that topic
 * - average score = mean of score / total_marks over submitted exam attempts
 * - activity      = attempts bucketed by their Asia/Dhaka calendar day
 *
 * Practice attempts are question-level evidence, so they feed accuracy, subject
 * and topic analysis. They are not exams, so they are excluded from the exam
 * count and the score trend. That matches the mistake pool, which already reads
 * every exam_history_details row.
 */

export interface ProgressHistoryRow {
  id: string;
  exam_id: string | null;
  score: number | null;
  total_marks: number | null;
  submitted_at: string | null;
  created_at: string | null;
  status: string | null;
  practice_mode: string | null;
}

export interface ProgressDetailRow {
  exam_history_id: string;
  question_id: string;
  is_correct: boolean | null;
  subject_id: string | null;
  chapter_id: string | null;
  topic_id: string | null;
}

export interface ProgressSubjectLabel {
  id: string;
  name_bn: string;
  name_en: string | null;
}

export interface ProgressChapterLabel {
  id: string;
  subject_id: string | null;
  name_bn: string;
  name_en: string | null;
}

export interface ProgressTopicLabel {
  id: string;
  chapter_id: string | null;
  name_bn: string;
  name_en: string | null;
}

export interface ProgressLevelRow {
  id: number;
  name_bn: string;
  name_en: string;
  min_xp: number;
  max_xp: number | null;
}

export interface ProgressLevel {
  id: number;
  name_bn: string;
  name_en: string;
  min_xp: number;
  max_xp: number | null;
  next_min_xp: number | null;
}

export interface ProgressSummary {
  accuracy_pct: number | null;
  average_score_pct: number | null;
  exams_taken: number;
  practice_sessions: number;
  streak_days: number;
  longest_streak_days: number;
  correct: number;
  wrong: number;
  skipped: number;
  responses: number;
}

export interface ProgressActivityDay {
  date: string;
  count: number;
}

export interface ProgressTrendPoint {
  date: string;
  iso: string;
  score_pct: number;
  score: number;
  total_marks: number;
}

export interface ProgressChapterStat {
  chapter_id: string | null;
  name_bn: string | null;
  name_en: string | null;
  responses: number;
  correct: number;
  wrong: number;
  skipped: number;
  accuracy_pct: number | null;
}

export interface ProgressSubjectStat {
  subject_id: string;
  name_bn: string;
  name_en: string | null;
  attempts: number;
  responses: number;
  correct: number;
  wrong: number;
  skipped: number;
  accuracy_pct: number | null;
  chapters: ProgressChapterStat[];
}

export interface ProgressWeakTopic {
  topic_id: string;
  topic_name_bn: string;
  topic_name_en: string | null;
  chapter_id: string | null;
  chapter_name_bn: string | null;
  chapter_name_en: string | null;
  subject_id: string;
  subject_name_bn: string;
  subject_name_en: string | null;
  responses: number;
  wrong: number;
  skipped: number;
  error_rate_pct: number;
}

export type ProgressMentorKind =
  | 'weakest_topic'
  | 'weakest_subject'
  | 'no_attempts';

export interface ProgressMentor {
  kind: ProgressMentorKind;
  topic_id: string | null;
  topic_name_bn: string | null;
  chapter_name_bn: string | null;
  subject_id: string | null;
  subject_name_bn: string | null;
  accuracy_pct: number | null;
  error_rate_pct: number | null;
  skipped_heavy: boolean;
  href: string;
}

export interface ProgressSnapshot {
  summary: ProgressSummary;
  activity: { window_days: number; days: ProgressActivityDay[] };
  performance: ProgressTrendPoint[];
  subjects: ProgressSubjectStat[];
  weaknesses: ProgressWeakTopic[];
  mentor: ProgressMentor;
  level: ProgressLevel | null;
}

export interface ProgressSnapshotInput {
  history: ProgressHistoryRow[];
  details: ProgressDetailRow[];
  subjects: ProgressSubjectLabel[];
  chapters: ProgressChapterLabel[];
  topics: ProgressTopicLabel[];
  levels: ProgressLevelRow[];
  totalXp: number;
  streakDays: number;
  longestStreakDays: number;
  now: number;
  activityWindowDays?: number;
}

const DEFAULT_ACTIVITY_WINDOW_DAYS = 120;
const TOPIC_LIMIT = 5;
const MAX_CHAPTERS_PER_SUBJECT = 8;

const DHAKA_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dhaka',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const toFiniteNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

const percentOf = (part: number, whole: number): number | null =>
  whole > 0 ? round2((part / whole) * 100) : null;

const attemptTimestamp = (row: ProgressHistoryRow): number => {
  const raw = row.submitted_at || row.created_at;
  if (!raw) return Number.NaN;
  return Date.parse(raw);
};

/** Asia/Dhaka calendar key for an ISO timestamp, or null when unparseable. */
export const dhakaDateKey = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return DHAKA_DATE.format(new Date(parsed));
};

const isCountableAttempt = (row: ProgressHistoryRow): boolean =>
  row.status !== 'fraud_detected' && !Number.isNaN(attemptTimestamp(row));

const isPracticeAttempt = (row: ProgressHistoryRow): boolean =>
  Boolean(row.practice_mode);

const scorePercent = (row: ProgressHistoryRow): number | null => {
  const score = toFiniteNumber(row.score);
  const total = toFiniteNumber(row.total_marks);
  if (score === null || total === null || total <= 0) return null;
  return round2((score / total) * 100);
};

export const resolveLevel = (
  totalXp: number,
  levels: ProgressLevelRow[]
): ProgressLevel | null => {
  if (levels.length === 0) return null;

  const ordered = [...levels].sort((a, b) => a.min_xp - b.min_xp);
  const xp = Math.max(0, Math.trunc(totalXp));

  const current =
    ordered.find(
      (level) =>
        xp >= level.min_xp && (level.max_xp === null || xp <= level.max_xp)
    ) ?? ordered[0];

  const next = ordered.find((level) => level.min_xp > current.min_xp) ?? null;

  return {
    id: current.id,
    name_bn: current.name_bn,
    name_en: current.name_en,
    min_xp: current.min_xp,
    max_xp: current.max_xp,
    next_min_xp: next ? next.min_xp : null,
  };
};

interface Counter {
  responses: number;
  correct: number;
  wrong: number;
  skipped: number;
  historyIds: Set<string>;
}

const emptyCounter = (): Counter => ({
  responses: 0,
  correct: 0,
  wrong: 0,
  skipped: 0,
  historyIds: new Set<string>(),
});

const addResponse = (counter: Counter, historyId: string, isCorrect: boolean | null): void => {
  counter.responses += 1;
  counter.historyIds.add(historyId);
  if (isCorrect === true) counter.correct += 1;
  else if (isCorrect === false) counter.wrong += 1;
  else counter.skipped += 1;
};

const accuracyOf = (counter: Counter): number | null =>
  percentOf(counter.correct, counter.responses);

const describeChapter = (
  chapterId: string | null,
  counter: Counter,
  chaptersById: Map<string, ProgressChapterLabel>
): ProgressChapterStat => {
  const chapter = chapterId ? chaptersById.get(chapterId) : null;

  return {
    chapter_id: chapterId,
    name_bn: chapter?.name_bn ?? null,
    name_en: chapter?.name_en ?? null,
    responses: counter.responses,
    correct: counter.correct,
    wrong: counter.wrong,
    skipped: counter.skipped,
    accuracy_pct: accuracyOf(counter),
  };
};

export const buildProgressSnapshot = (input: ProgressSnapshotInput): ProgressSnapshot => {
  const windowDays = input.activityWindowDays ?? DEFAULT_ACTIVITY_WINDOW_DAYS;
  const subjectsById = new Map(input.subjects.map((row) => [row.id, row]));
  const chaptersById = new Map(input.chapters.map((row) => [row.id, row]));
  const topicsById = new Map(input.topics.map((row) => [row.id, row]));

  const countableHistory = input.history.filter(isCountableAttempt);
  const countableIds = new Set(countableHistory.map((row) => row.id));

  const examAttempts = countableHistory.filter((row) => !isPracticeAttempt(row));
  const practiceAttempts = countableHistory.filter(isPracticeAttempt);

  const scoredExamAttempts = examAttempts
    .map((row) => ({ row, pct: scorePercent(row) }))
    .filter((entry): entry is { row: ProgressHistoryRow; pct: number } => entry.pct !== null);

  const averageScorePct =
    scoredExamAttempts.length > 0
      ? round2(
          scoredExamAttempts.reduce((sum, entry) => sum + entry.pct, 0) /
            scoredExamAttempts.length
        )
      : null;

  const performance: ProgressTrendPoint[] = [...scoredExamAttempts]
    .sort((a, b) => attemptTimestamp(a.row) - attemptTimestamp(b.row))
    .map(({ row, pct }) => ({
      date: dhakaDateKey(row.submitted_at || row.created_at) ?? '',
      iso: new Date(attemptTimestamp(row)).toISOString(),
      score_pct: pct,
      score: toFiniteNumber(row.score) ?? 0,
      total_marks: toFiniteNumber(row.total_marks) ?? 0,
    }));

  const countsByDate = new Map<string, number>();
  for (const row of countableHistory) {
    const key = dhakaDateKey(row.submitted_at || row.created_at);
    if (!key) continue;
    countsByDate.set(key, (countsByDate.get(key) ?? 0) + 1);
  }

  const windowStart = new Date(input.now - (windowDays - 1) * 86_400_000);
  const windowStartKey = dhakaDateKey(windowStart.toISOString()) ?? '';

  const days = [...countsByDate.entries()]
    .filter(([date]) => date >= windowStartKey)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  const subjectCounters = new Map<string, Counter>();
  const chapterCounters = new Map<string, Map<string | null, Counter>>();
  const topicCounters = new Map<string, Counter>();

  let totalResponses = 0;
  let totalCorrect = 0;
  let totalWrong = 0;
  let totalSkipped = 0;

  for (const detail of input.details) {
    if (!countableIds.has(detail.exam_history_id)) continue;

    totalResponses += 1;
    if (detail.is_correct === true) totalCorrect += 1;
    else if (detail.is_correct === false) totalWrong += 1;
    else totalSkipped += 1;

    if (detail.subject_id) {
      const counter = subjectCounters.get(detail.subject_id) ?? emptyCounter();
      addResponse(counter, detail.exam_history_id, detail.is_correct);
      subjectCounters.set(detail.subject_id, counter);

      const chapters = chapterCounters.get(detail.subject_id) ?? new Map();
      const chapterCounter = chapters.get(detail.chapter_id) ?? emptyCounter();
      addResponse(chapterCounter, detail.exam_history_id, detail.is_correct);
      chapters.set(detail.chapter_id, chapterCounter);
      chapterCounters.set(detail.subject_id, chapters);
    }

    if (detail.topic_id) {
      const counter = topicCounters.get(detail.topic_id) ?? emptyCounter();
      addResponse(counter, detail.exam_history_id, detail.is_correct);
      topicCounters.set(detail.topic_id, counter);
    }
  }

  const subjects: ProgressSubjectStat[] = [...subjectCounters.entries()]
    .map(([subjectId, counter]) => {
      const label = subjectsById.get(subjectId);
      const chapters = [...(chapterCounters.get(subjectId) ?? new Map()).entries()]
        .map(([chapterId, chapterCounter]) =>
          describeChapter(chapterId, chapterCounter, chaptersById)
        )
        .sort((a, b) => b.responses - a.responses)
        .slice(0, MAX_CHAPTERS_PER_SUBJECT);

      return {
        subject_id: subjectId,
        name_bn: label?.name_bn ?? subjectId,
        name_en: label?.name_en ?? null,
        attempts: counter.historyIds.size,
        responses: counter.responses,
        correct: counter.correct,
        wrong: counter.wrong,
        skipped: counter.skipped,
        accuracy_pct: accuracyOf(counter),
        chapters,
      };
    })
    .sort((a, b) => b.responses - a.responses || a.name_bn.localeCompare(b.name_bn));

  const weaknesses: ProgressWeakTopic[] = [...topicCounters.entries()]
    .map(([topicId, counter]) => {
      const topic = topicsById.get(topicId);
      if (!topic) return null;

      const chapter = topic.chapter_id ? chaptersById.get(topic.chapter_id) : null;
      const subject = chapter?.subject_id
        ? subjectsById.get(chapter.subject_id)
        : null;

      if (!subject) return null;

      return {
        topic_id: topicId,
        topic_name_bn: topic.name_bn,
        topic_name_en: topic.name_en,
        chapter_id: topic.chapter_id,
        chapter_name_bn: chapter?.name_bn ?? null,
        chapter_name_en: chapter?.name_en ?? null,
        subject_id: subject.id,
        subject_name_bn: subject.name_bn,
        subject_name_en: subject.name_en,
        responses: counter.responses,
        wrong: counter.wrong,
        skipped: counter.skipped,
        error_rate_pct: percentOf(counter.wrong + counter.skipped, counter.responses) ?? 0,
      };
    })
    .filter((row): row is ProgressWeakTopic => row !== null)
    .sort(
      (a, b) =>
        b.error_rate_pct - a.error_rate_pct ||
        b.responses - a.responses ||
        a.topic_name_bn.localeCompare(b.topic_name_bn)
    )
    .slice(0, TOPIC_LIMIT);

  const buildTopicHref = (subjectId: string, topicId: string): string =>
    `/question-bank?subject=${encodeURIComponent(subjectId)}&topic=${encodeURIComponent(topicId)}`;

  let mentor: ProgressMentor;

  const attemptCount = examAttempts.length + practiceAttempts.length;

  if (attemptCount === 0) {
    mentor = {
      kind: 'no_attempts',
      topic_id: null,
      topic_name_bn: null,
      chapter_name_bn: null,
      subject_id: null,
      subject_name_bn: null,
      accuracy_pct: null,
      error_rate_pct: null,
      skipped_heavy: false,
      href: '/exams/model',
    };
  } else if (weaknesses.length > 0) {
    const worst = weaknesses[0];
    mentor = {
      kind: 'weakest_topic',
      topic_id: worst.topic_id,
      topic_name_bn: worst.topic_name_bn,
      chapter_name_bn: worst.chapter_name_bn,
      subject_id: worst.subject_id,
      subject_name_bn: worst.subject_name_bn,
      accuracy_pct: percentOf(worst.responses - worst.wrong - worst.skipped, worst.responses),
      error_rate_pct: worst.error_rate_pct,
      skipped_heavy: worst.skipped > worst.wrong,
      href: buildTopicHref(worst.subject_id, worst.topic_id),
    };
  } else {
    const worstSubject = [...subjects].sort(
      (a, b) =>
        (b.wrong + b.skipped) / Math.max(1, b.responses) -
        (a.wrong + a.skipped) / Math.max(1, a.responses)
    )[0];

    mentor = {
      kind: 'weakest_subject',
      topic_id: null,
      topic_name_bn: null,
      chapter_name_bn: null,
      subject_id: worstSubject?.subject_id ?? null,
      subject_name_bn: worstSubject?.name_bn ?? null,
      accuracy_pct: worstSubject?.accuracy_pct ?? null,
      error_rate_pct: worstSubject
        ? percentOf(worstSubject.wrong + worstSubject.skipped, worstSubject.responses)
        : null,
      skipped_heavy: worstSubject ? worstSubject.skipped > worstSubject.wrong : false,
      href: worstSubject
        ? `/question-bank?subject=${encodeURIComponent(worstSubject.subject_id)}`
        : '/question-bank',
    };
  }

  return {
    summary: {
      accuracy_pct: percentOf(totalCorrect, totalResponses),
      average_score_pct: averageScorePct,
      exams_taken: examAttempts.length,
      practice_sessions: practiceAttempts.length,
      streak_days: Math.max(0, Math.trunc(input.streakDays)),
      longest_streak_days: Math.max(0, Math.trunc(input.longestStreakDays)),
      correct: totalCorrect,
      wrong: totalWrong,
      skipped: totalSkipped,
      responses: totalResponses,
    },
    activity: { window_days: windowDays, days },
    performance,
    subjects,
    weaknesses,
    mentor,
    level: resolveLevel(input.totalXp, input.levels),
  };
};
