import { findOptionById, isAnswerCorrect, normalizeOptionId } from '../exams/exam.grading';

type QuestionLike = {
  id?: string | number | null;
  options?: unknown;
};

export type BattleScore = {
  score: number;
  correct_count: number;
  wrong_count: number;
  skipped_count: number;
  total_questions: number;
};

/**
 * Pure grading for a group battle. Kept separate from the service so the
 * negative-marking and skipped-question rules can be unit tested.
 */
export const scoreBattleAnswers = (
  questions: QuestionLike[],
  answers: Record<string, unknown> | null | undefined,
  negativeMarks = 0.25
): BattleScore => {
  const allowed = new Set(
    questions.map((question) => String(question.id ?? '').trim()).filter(Boolean)
  );

  let correct = 0;
  let wrong = 0;
  let skipped = 0;
  let totalScore = 0;

  questions.forEach((question) => {
    const questionId = String(question.id ?? '').trim();
    const raw = answers?.[questionId];
    const selectedId = raw === null || raw === undefined ? '' : normalizeOptionId(raw);
    const options = Array.isArray(question.options) ? question.options : [];

    if (!allowed.has(questionId) || !selectedId) {
      skipped += 1;
      return;
    }

    if (!findOptionById(options, selectedId)) {
      skipped += 1;
      return;
    }

    if (isAnswerCorrect(options, selectedId)) {
      correct += 1;
      totalScore += 1;
    } else {
      wrong += 1;
      totalScore -= negativeMarks;
    }
  });

  return {
    score: Math.max(0, Number(totalScore.toFixed(2))),
    correct_count: correct,
    wrong_count: wrong,
    skipped_count: skipped,
    total_questions: questions.length,
  };
};

/** Seconds spent, clamped to the configured battle window. */
export const computeTimeTaken = (
  startTime: string | number | null | undefined,
  nowMs: number,
  durationMinutes: number,
  maxDurationMinutes = 180
): number => {
  const start = Date.parse(String(startTime ?? ''));
  const durationSeconds = Math.min(
    maxDurationMinutes * 60,
    Math.max(60, Math.floor(Number(durationMinutes || 20) * 60))
  );
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.min(durationSeconds, Math.round((nowMs - start) / 1000)));
};
