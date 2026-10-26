/**
 * Pure, dependency-free timing helpers for the authoritative exam attempt
 * lifecycle. Deadlines are always derived and evaluated on the trusted server;
 * no client timestamp is ever accepted as authoritative.
 */

export const ATTEMPT_STATUS = {
  IN_PROGRESS: 'in_progress',
  SUBMITTED: 'submitted',
  EXPIRED: 'expired',
  FINALIZED: 'finalized',
} as const;

export type AttemptStatus = (typeof ATTEMPT_STATUS)[keyof typeof ATTEMPT_STATUS];

export const ATTEMPT_KIND = {
  EXAM: 'exam',
  PRACTICE: 'practice',
} as const;

export type AttemptKind = (typeof ATTEMPT_KIND)[keyof typeof ATTEMPT_KIND];

export const MINUTE_MS = 60_000;

/**
 * A submission that was started before the deadline can legitimately arrive a
 * little after it (client timer, network latency, tab throttling). Submission
 * claiming therefore accepts a short grace window; every other operation
 * (draft saves, resume, start) stays strictly deadline-bounded.
 */
export const DEFAULT_SUBMIT_GRACE_MS = 30_000;

/** Upper bound for an operator-supplied grace, so a typo cannot disable expiry. */
export const MAX_SUBMIT_GRACE_MS = 10 * MINUTE_MS;

/**
 * Resolves the submission grace window from configuration.
 *
 * An invalid, negative or absurdly large value is ignored in favour of the safe
 * default instead of failing the request or opening an unbounded window.
 */
export const resolveSubmitGraceMs = (raw: unknown = process.env.EXAM_SUBMIT_GRACE_MS): number => {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return DEFAULT_SUBMIT_GRACE_MS;
  }

  const parsed = Number(String(raw).trim());

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return DEFAULT_SUBMIT_GRACE_MS;
  }

  if (parsed > MAX_SUBMIT_GRACE_MS) return DEFAULT_SUBMIT_GRACE_MS;

  return parsed;
};

/** Conservative default when no arena duration is configured. */
export const DEFAULT_PRACTICE_DURATION_MIN = 60;

export type ExamTimingConfig = {
  duration_min?: number | string | null;
  start_time?: string | null;
  end_time?: string | null;
};

export const toEpochMs = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;

  const parsed = Date.parse(String(value));

  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * The deadline is the earlier of (started_at + duration) and the exam window
 * end. Returns null when neither exists, which callers must treat as a failure
 * to establish authoritative timing (fail closed).
 */
export const resolveAttemptDeadline = (
  exam: ExamTimingConfig | null | undefined,
  startedAtMs: number
): number | null => {
  const durationMinutes = Number(exam?.duration_min);
  const windowEnd = toEpochMs(exam?.end_time);

  let durationDeadline: number | null = null;

  if (Number.isFinite(durationMinutes) && durationMinutes > 0) {
    durationDeadline = startedAtMs + durationMinutes * MINUTE_MS;
  }

  if (durationDeadline === null) return windowEnd;
  if (windowEnd === null) return durationDeadline;

  return Math.min(durationDeadline, windowEnd);
};

export type ExamWindowCheck =
  | { allowed: true }
  | { allowed: false; reason: 'not_started' | 'window_closed' };

/**
 * Validates the exam's published window. A null window is treated as open
 * (existing exams may not configure one); the attempt deadline still bounds the
 * attempt.
 */
export const checkExamWindow = (
  exam: ExamTimingConfig | null | undefined,
  nowMs: number = Date.now()
): ExamWindowCheck => {
  const windowStart = toEpochMs(exam?.start_time);
  const windowEnd = toEpochMs(exam?.end_time);

  if (windowStart !== null && nowMs < windowStart) {
    return { allowed: false, reason: 'not_started' };
  }

  if (windowEnd !== null && nowMs > windowEnd) {
    return { allowed: false, reason: 'window_closed' };
  }

  return { allowed: true };
};

/**
 * The deadline is inclusive: an operation at exactly deadline_at is allowed,
 * anything after it is expired. This is the single documented rule used by all
 * enforcement points.
 */
export const isAttemptExpired = (
  deadlineAt: unknown,
  nowMs: number = Date.now()
): boolean => {
  const deadline = toEpochMs(deadlineAt);

  if (deadline === null) return true;

  return nowMs > deadline;
};

export const QUIZ_PRACTICE_MODES = ['wrong_from_history', 'wrong_global'] as const;

export const isQuizPracticeMode = (mode: unknown): boolean =>
  QUIZ_PRACTICE_MODES.includes(String(mode ?? '') as (typeof QUIZ_PRACTICE_MODES)[number]);

/**
 * Quiz-mode mistake practice is deliberately untimed. A null deadline only
 * means unlimited for these two practice modes; every other attempt still
 * fails closed when its deadline is missing.
 */
export const isUntimedPracticeAttempt = (attempt: {
  practice_mode?: string | null;
  deadline_at?: string | null;
} | null | undefined): boolean =>
  attempt?.deadline_at === null &&
  isQuizPracticeMode(attempt?.practice_mode);

export const isAttemptExpiredForAttempt = (
  attempt: { practice_mode?: string | null; deadline_at?: string | null } | null | undefined,
  nowMs: number = Date.now()
): boolean => {
  if (isUntimedPracticeAttempt(attempt)) return false;

  return isAttemptExpired(attempt?.deadline_at, nowMs);
};

export const resolvePracticeDeadline = (
  startedAtMs: number,
  durationMinutes?: number | null
): number => {
  const resolved = Number(durationMinutes);

  const minutes =
    Number.isFinite(resolved) && resolved > 0 ? resolved : DEFAULT_PRACTICE_DURATION_MIN;

  return startedAtMs + minutes * MINUTE_MS;
};

export const isAttemptOpen = (attempt: {
  status?: string | null;
  deadline_at?: string | null;
}): boolean => {
  if (attempt?.status !== ATTEMPT_STATUS.IN_PROGRESS) return false;

  return !isAttemptExpired(attempt.deadline_at);
};
