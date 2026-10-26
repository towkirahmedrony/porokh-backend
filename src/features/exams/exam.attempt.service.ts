import { randomUUID } from 'crypto';
import { supabase } from '../../config/supabase';
import {
  ATTEMPT_KIND,
  ATTEMPT_STATUS,
  checkExamWindow,
  isAttemptExpired,
  isAttemptExpiredForAttempt,
  isUntimedPracticeAttempt,
  resolveAttemptDeadline,
  resolvePracticeDeadline,
  resolveSubmitGraceMs,
} from './exam.timing';

type AnyObject = Record<string, any>;

export class ExamAttemptError extends Error {
  status: number;
  details?: any;
  /** Machine-readable code forwarded to the client for paywall decisions. */
  code?: string;
  /**
   * Error code taken from `details.code`. Callers may set the code through the
   * details object (the shape the API documents) and the global error handler
   * still forwards it as a top-level `code`.
   */
  errorCode?: string;

  constructor(message: string, status = 400, details?: any, code?: string) {
    super(message);
    this.name = 'ExamAttemptError';
    this.status = status;
    this.details = details;

    const detailsCode =
      details && typeof details === 'object' && typeof details.code === 'string'
        ? details.code
        : undefined;

    this.code = code ?? detailsCode;
    this.errorCode = detailsCode ?? code;
  }
}

/** Error codes the client uses to open the paywall or the result page. */
export const ATTEMPT_ERROR_CODES = {
  ALREADY_ATTEMPTED: 'ALREADY_ATTEMPTED',
  FREE_LIMIT_REACHED: 'FREE_LIMIT_REACHED',
  PREMIUM_REQUIRED: 'PREMIUM_REQUIRED',
} as const;

export const ATTEMPT_SELECT =
  'id, user_id, exam_id, kind, status, started_at, deadline_at, submitted_at, answers_draft, current_question_index, time_remaining, last_updated_at, exam_history_id, question_ids, practice_mode, source_history_id';

const MAX_PRACTICE_QUESTIONS = 100;

const normalizeId = (value: unknown): string => String(value ?? '').trim();

const toIso = (epochMs: number): string => new Date(epochMs).toISOString();

const secondsUntil = (deadlineAt: unknown, nowMs: number): number | null => {
  if (!deadlineAt) return null;

  const deadline = Date.parse(String(deadlineAt));

  if (Number.isNaN(deadline)) return null;

  return Math.max(0, Math.ceil((deadline - nowMs) / 1000));
};

export type AttemptDto = {
  id: string;
  exam_id: string | null;
  kind: string;
  status: string;
  started_at: string | null;
  deadline_at: string | null;
  submitted_at: string | null;
  server_time: string;
  seconds_remaining: number | null;
  answers_draft: AnyObject;
  current_question_index: number;
  question_ids: string[];
  practice_mode: string | null;
  source_history_id: string | null;
};

export const toAttemptDto = (row: AnyObject, nowMs = Date.now()): AttemptDto => ({
  id: row.id,
  exam_id: row.exam_id ?? null,
  kind: row.kind ?? ATTEMPT_KIND.EXAM,
  status: row.status,
  started_at: row.started_at ?? null,
  deadline_at: row.deadline_at ?? null,
  submitted_at: row.submitted_at ?? null,
  server_time: toIso(nowMs),
  seconds_remaining: secondsUntil(row.deadline_at, nowMs),
  answers_draft:
    row.answers_draft && typeof row.answers_draft === 'object' && !Array.isArray(row.answers_draft)
      ? row.answers_draft
      : {},
  current_question_index: Number(row.current_question_index ?? 0),
  question_ids: Array.isArray(row.question_ids) ? row.question_ids.map(normalizeId).filter(Boolean) : [],
  practice_mode: row.practice_mode ?? null,
  source_history_id: row.source_history_id ?? null,
});

const loadExamPaper = async (examId: string) => {
  const { data, error } = await supabase
    .from('exam_papers')
    .select('id, is_published, is_premium, duration_min, start_time, end_time, default_negative_marks, total_marks, result_publish_time')
    .eq('id', examId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return data;
};

/**
 * Authoritative access state for the authenticated user. The service-role
 * client calls the existing database function; nothing about premium status is
 * ever taken from the request.
 */
export const loadUserAccess = async (userId: string): Promise<AnyObject> => {
  const { data, error } = await supabase.rpc('get_user_access', { p_user_id: userId });

  if (error) throw new Error(error.message);

  return (data && typeof data === 'object' ? data : {}) as AnyObject;
};

const assertPremiumContentAccess = (exam: AnyObject, access: AnyObject): void => {
  if (exam?.is_premium !== true) return;
  if (access?.premium === true) return;

  throw new ExamAttemptError(
    'Premium access is required to start this exam.',
    403,
    { feature: 'premium_content', resource: 'exam_paper', exam_id: exam?.id ?? null },
    ATTEMPT_ERROR_CODES.PREMIUM_REQUIRED
  );
};

const loadAuthoritativeQuestionIds = async (examId: string): Promise<string[]> => {
  const { data, error } = await supabase
    .from('exam_paper_questions')
    .select('question_id, sequence')
    .eq('exam_id', examId);

  if (error) throw new Error(error.message);

  return (data || [])
    .slice()
    .sort((a: AnyObject, b: AnyObject) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0))
    .map((row: AnyObject) => normalizeId(row.question_id))
    .filter(Boolean);
};

const loadPublishedQuestionIds = async (questionIds: string[]): Promise<string[]> => {
  if (questionIds.length === 0) return [];

  const { data, error } = await supabase
    .from('questions')
    .select('id')
    .in('id', questionIds)
    .eq('is_active', true)
    .eq('status', 'published')
    .is('deleted_at', null);

  if (error) throw new Error(error.message);

  return (data || []).map((row: AnyObject) => normalizeId(row.id)).filter(Boolean);
};

export const loadPracticeDurationMinutes = async (): Promise<number | null> => {
  const { data, error } = await supabase
    .from('app_configs')
    .select('value')
    .eq('key', 'arena_config')
    .maybeSingle();

  if (error) return null;

  const value = (data?.value as AnyObject) || {};
  const duration = Number(value.practice_duration_min ?? value.duration_min);

  return Number.isFinite(duration) && duration > 0 ? duration : null;
};

export class ExamAttemptService {
  static async getAttempt(userId: string, attemptId: string) {
    const normalizedAttemptId = normalizeId(attemptId);

    if (!userId) throw new ExamAttemptError('Unauthorized', 401);
    if (!normalizedAttemptId) throw new ExamAttemptError('Attempt id is required', 400);

    const { data, error } = await supabase
      .from('exam_progress')
      .select(ATTEMPT_SELECT)
      .eq('id', normalizedAttemptId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(error.message);

    return data ?? null;
  }

  static async findActiveExamAttempt(userId: string, examId: string) {
    const { data, error } = await supabase
      .from('exam_progress')
      .select(ATTEMPT_SELECT)
      .eq('user_id', userId)
      .eq('exam_id', normalizeId(examId))
      .eq('status', ATTEMPT_STATUS.IN_PROGRESS)
      .maybeSingle();

    if (error) throw new Error(error.message);

    return data ?? null;
  }

  /**
   * The result row for a (user, exam) pair, if the student already completed
   * that exam. A single exam may only be taken once, so its presence blocks a
   * new attempt even when no in-progress row exists.
   */
  static async findHistoryForUserExam(userId: string, examId: string) {
    const { data, error } = await supabase
      .from('exam_history')
      .select('id, user_id, exam_id, status, score')
      .eq('user_id', userId)
      .eq('exam_id', normalizeId(examId))
      .maybeSingle();

    if (error) throw new Error(error.message);

    return data ?? null;
  }

  static async expireAttempt(attemptId: string): Promise<void> {
    try {
      await supabase
        .from('exam_progress')
        .update({ status: ATTEMPT_STATUS.EXPIRED, last_updated_at: new Date().toISOString() })
        .eq('id', attemptId)
        .eq('status', ATTEMPT_STATUS.IN_PROGRESS);
    } catch {
      // Best effort: the authoritative deadline still blocks further use.
    }
  }

  static async startExamAttempt(userId: string, examId: string): Promise<AttemptDto> {
    if (!userId) throw new ExamAttemptError('Unauthorized', 401);

    const normalizedExamId = normalizeId(examId);
    if (!normalizedExamId) throw new ExamAttemptError('Exam id is required', 400);

    const exam = await loadExamPaper(normalizedExamId);
    if (!exam) throw new ExamAttemptError('Exam not found', 404);
    if (exam.is_published !== true) throw new ExamAttemptError('Exam is not available', 403);

    const now = Date.now();
    const window = checkExamWindow(exam, now);

    if (!window.allowed) {
      throw new ExamAttemptError(
        window.reason === 'not_started' ? 'Exam has not started yet' : 'Exam window is closed',
        403
      );
    }

    // Premium papers are authorised server-side. This runs before any attempt
    // is created or resumed, so a locked paper can never yield a question set
    // and no quota is consumed for a request that will be rejected.
    assertPremiumContentAccess(exam, await loadUserAccess(userId));

    const existing = await ExamAttemptService.findActiveExamAttempt(userId, normalizedExamId);

    if (existing) {
      if (isAttemptExpired(existing.deadline_at, now)) {
        await ExamAttemptService.expireAttempt(existing.id);
        throw new ExamAttemptError('Exam attempt has expired', 409);
      }

      // Authoritative quota check for resumes to ensure consistency. The
      // reference id is the persisted attempt id, so the database function
      // treats the resume as already counted instead of a second start.
      const { data: quota, error: quotaError } = await supabase.rpc('consume_quota', {
        p_user_id: userId,
        p_feature: 'exam_start',
        p_reference_id: existing.id
      });

      if (quotaError) throw new Error(quotaError.message);
      if (!quota.allowed) {
        throw new ExamAttemptError(
          'Daily free exam limit reached.',
          403,
          {
            code: ATTEMPT_ERROR_CODES.FREE_LIMIT_REACHED,
            feature: 'exam_start',
            limit: quota.limit,
            used: quota.used,
            reset_at: quota.reset_at
          },
          ATTEMPT_ERROR_CODES.FREE_LIMIT_REACHED
        );
      }

      return toAttemptDto(existing, now);
    }

    // One attempt per exam. This application-level check runs before questions
    // are loaded or quota is consumed, so an already-completed exam never costs
    // the student a free-start credit. The database trigger remains the
    // authoritative concurrency safeguard (SQLSTATE P0409, handled below).
    const completed = await ExamAttemptService.findHistoryForUserExam(userId, normalizedExamId);

    if (completed) {
      throw new ExamAttemptError('You have already taken this exam', 409, {
        code: ATTEMPT_ERROR_CODES.ALREADY_ATTEMPTED,
        exam_history_id: completed.id
      });
    }

    const questionIds = await loadAuthoritativeQuestionIds(normalizedExamId);
    if (questionIds.length === 0) {
      throw new ExamAttemptError('Exam question set is not configured', 400);
    }

    const deadline = resolveAttemptDeadline(exam, now);
    if (deadline === null) {
      throw new ExamAttemptError('Exam does not define an authoritative duration', 400);
    }

    const attemptId = randomUUID();

    // 1. Authoritative Quota Consumption
    const { data: quota, error: quotaError } = await supabase.rpc('consume_quota', {
      p_user_id: userId,
      p_feature: 'exam_start',
      p_reference_id: attemptId
    });

    if (quotaError) throw new Error(quotaError.message);
    if (!quota.allowed) {
      throw new ExamAttemptError(
        'Daily free exam limit reached.',
        403,
        {
          code: ATTEMPT_ERROR_CODES.FREE_LIMIT_REACHED,
          feature: 'exam_start',
          limit: quota.limit,
          used: quota.used,
          reset_at: quota.reset_at
        },
        ATTEMPT_ERROR_CODES.FREE_LIMIT_REACHED
      );
    }

    const insertPayload = {
      id: attemptId,
      user_id: userId,
      exam_id: normalizedExamId,
      kind: ATTEMPT_KIND.EXAM,
      status: ATTEMPT_STATUS.IN_PROGRESS,
      started_at: toIso(now),
      deadline_at: toIso(deadline),
      question_ids: questionIds,
      answers_draft: {},
      current_question_index: 0,
      time_remaining: secondsUntil(toIso(deadline), now),
      last_updated_at: toIso(now),
    };

    // The quota was consumed for `attemptId`; if persisting the attempt fails
    // for any reason (returned error or thrown transport error) the consumption
    // is refunded exactly once with the same reference id.
    const refundConsumedQuota = () =>
      supabase.rpc('refund_quota', {
        p_user_id: userId,
        p_feature: 'exam_start',
        p_reference_id: attemptId
      });

    let insertResult;
    try {
      insertResult = await supabase
        .from('exam_progress')
        .insert([insertPayload])
        .select(ATTEMPT_SELECT)
        .single();
    } catch (thrown) {
      await refundConsumedQuota();
      throw thrown;
    }

    const { data, error } = insertResult;

    if (error) {
      // If insertion failed, refund the quota
      await refundConsumedQuota();

      // A concurrent start won the partial unique index; resume that attempt
      // instead of creating a second one.
      if ((error as AnyObject).code === '23505') {
        const { data: concurrent } = await supabase
          .from('exam_progress')
          .select(ATTEMPT_SELECT)
          .eq('user_id', userId)
          .eq('exam_id', normalizedExamId)
          .eq('status', ATTEMPT_STATUS.IN_PROGRESS)
          .maybeSingle();

        if (concurrent) return toAttemptDto(concurrent, now);
      }

      // The database trigger rejected a second attempt because a result
      // already exists. Report it exactly like the application-level check;
      // the quota consumed above has already been refunded.
      if ((error as AnyObject).code === 'P0409') {
        const existingResult = await ExamAttemptService.findHistoryForUserExam(
          userId,
          normalizedExamId
        ).catch(() => null);

        throw new ExamAttemptError('You have already taken this exam', 409, {
          code: ATTEMPT_ERROR_CODES.ALREADY_ATTEMPTED,
          exam_history_id: existingResult?.id ?? null
        });
      }

      throw new Error(error.message);
    }

    return toAttemptDto(data, now);
  }

  static async startPracticeAttempt(
    userId: string,
    questionIds: unknown
  ): Promise<AttemptDto> {
    if (!userId) throw new ExamAttemptError('Unauthorized', 401);

    const normalized = Array.from(
      new Set(
        (Array.isArray(questionIds) ? questionIds : [])
          .map(normalizeId)
          .filter(Boolean)
      )
    );

    if (normalized.length === 0) throw new ExamAttemptError('Question ids are required', 400);
    if (normalized.length > MAX_PRACTICE_QUESTIONS) {
      throw new ExamAttemptError('Too many questions for a practice attempt', 400);
    }

    const published = await loadPublishedQuestionIds(normalized);
    const publishedSet = new Set(published);
    const unavailable = normalized.filter((id) => !publishedSet.has(id));

    if (unavailable.length > 0) {
      throw new ExamAttemptError('One or more questions are not available', 400);
    }

    const now = Date.now();
    const durationMinutes = await loadPracticeDurationMinutes();
    const deadline = resolvePracticeDeadline(now, durationMinutes);

    const { data, error } = await supabase
      .from('exam_progress')
      .insert([
        {
          user_id: userId,
          exam_id: null,
          kind: ATTEMPT_KIND.PRACTICE,
          status: ATTEMPT_STATUS.IN_PROGRESS,
          started_at: toIso(now),
          deadline_at: toIso(deadline),
          question_ids: normalized,
          answers_draft: {},
          current_question_index: 0,
          time_remaining: secondsUntil(toIso(deadline), now),
          last_updated_at: toIso(now),
        },
      ])
      .select(ATTEMPT_SELECT)
      .single();

    if (error) throw new Error(error.message);

    return toAttemptDto(data, now);
  }

  static async getAttemptState(userId: string, attemptId: string): Promise<AttemptDto> {
    const attempt = await ExamAttemptService.getAttempt(userId, attemptId);

    if (!attempt) throw new ExamAttemptError('Attempt not found', 404);

    if (
      attempt.status === ATTEMPT_STATUS.IN_PROGRESS &&
      isAttemptExpiredForAttempt(attempt)
    ) {
      await ExamAttemptService.expireAttempt(attempt.id);

      return toAttemptDto({ ...attempt, status: ATTEMPT_STATUS.EXPIRED });
    }

    return toAttemptDto(attempt);
  }

  static async saveDraftAnswers(
    userId: string,
    attemptId: string,
    answers: unknown,
    currentQuestionIndex?: unknown
  ): Promise<AttemptDto> {
    // Only the timing/ownership fields are needed here. Selecting the full
    // attempt would pull the whole answer draft on every autosave.
    const { data: attempt, error: attemptError } = await supabase
      .from('exam_progress')
      .select('id, status, practice_mode, deadline_at')
      .eq('id', normalizeId(attemptId))
      .eq('user_id', userId)
      .maybeSingle();

    if (attemptError) throw new Error(attemptError.message);
    if (!attempt) throw new ExamAttemptError('Attempt not found', 404);
    if (attempt.status !== ATTEMPT_STATUS.IN_PROGRESS) {
      throw new ExamAttemptError('Attempt is no longer in progress', 409);
    }
    if (isAttemptExpiredForAttempt(attempt)) {
      await ExamAttemptService.expireAttempt(attempt.id);
      throw new ExamAttemptError('Exam attempt has expired', 409);
    }

    // `answers === undefined` is a position-only save (quiz navigation). It
    // must not overwrite a newer draft written by the answer endpoint.
    const hasAnswers = answers !== undefined;
    const safeAnswers = hasAnswers
      ? answers && typeof answers === 'object' && !Array.isArray(answers)
        ? answers
        : {}
      : null;

    const index = Number(currentQuestionIndex);
    const now = Date.now();
    const updates: AnyObject = {
      current_question_index: Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0,
      last_updated_at: toIso(now),
    };

    if (safeAnswers !== null) updates.answers_draft = safeAnswers;

    // The update is conditional on in_progress AND an unexpired deadline so a
    // concurrent submit/expire cannot be overwritten, and it never touches
    // started_at/deadline_at (a retry can never extend the exam).
    let updateQuery = supabase
      .from('exam_progress')
      .update(updates)
      .eq('id', attempt.id)
      .eq('user_id', userId)
      .eq('status', ATTEMPT_STATUS.IN_PROGRESS);

    if (!isUntimedPracticeAttempt(attempt)) {
      updateQuery = updateQuery.gt('deadline_at', toIso(now));
    }

    const { data, error } = await updateQuery.select(ATTEMPT_SELECT);

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      throw new ExamAttemptError('Attempt is no longer in progress', 409);
    }

    return toAttemptDto(data[0], now);
  }

  /**
   * Atomically claims an attempt for submission. Only one caller can win; a
   * losing caller receives claimed=false and must return the existing result.
   *
   * Submission is the one operation with a grace window: a client that
   * auto-submits at timer zero may reach the API slightly after `deadline_at`.
   * Draft saves, resume and start stay strictly deadline-bounded.
   */
  static async claimAttemptForSubmission(
    userId: string,
    attemptId: string,
    examHistoryId: string
  ): Promise<{ attempt: AnyObject; claimed: boolean }> {
    const attempt = await ExamAttemptService.getAttempt(userId, attemptId);

    if (!attempt) throw new ExamAttemptError('Attempt not found', 404);

    if (attempt.status !== ATTEMPT_STATUS.IN_PROGRESS) {
      return { attempt, claimed: false };
    }

    const graceMs = resolveSubmitGraceMs();
    const now = Date.now();

    const untimed = isUntimedPracticeAttempt(attempt);

    // `isAttemptExpired` is inclusive at the boundary; subtracting the grace is
    // exactly the same instant the database filter compares against below.
    if (!untimed && isAttemptExpired(attempt.deadline_at, now - graceMs)) {
      await ExamAttemptService.expireAttempt(attempt.id);

      return { attempt: { ...attempt, status: ATTEMPT_STATUS.EXPIRED }, claimed: false };
    }

    let updateQuery = supabase
      .from('exam_progress')
      .update({
        status: ATTEMPT_STATUS.SUBMITTED,
        submitted_at: toIso(now),
        exam_history_id: examHistoryId,
        last_updated_at: toIso(now),
      })
      .eq('id', attempt.id)
      .eq('user_id', userId)
      .eq('status', ATTEMPT_STATUS.IN_PROGRESS);

    if (!untimed) {
      updateQuery = updateQuery.gt('deadline_at', toIso(now - graceMs));
    }

    const { data, error } = await updateQuery.select(ATTEMPT_SELECT);

    if (error) throw new Error(error.message);

    if (!data || data.length === 0) {
      const latest = await ExamAttemptService.getAttempt(userId, attemptId);

      return { attempt: latest ?? { ...attempt, status: ATTEMPT_STATUS.SUBMITTED }, claimed: false };
    }

    return { attempt: data[0], claimed: true };
  }

  /**
   * Marks a claimed attempt finalized and records the awarded XP for audit. The
   * update is conditional on `submitted`, so finalization can never happen twice
   * and can never resurrect an attempt in another state.
   */
  static async finalizeAttempt(
    attemptId: string,
    examHistoryId: string | null,
    awardedXp: number
  ): Promise<void> {
    try {
      await supabase
        .from('exam_progress')
        .update({
          status: ATTEMPT_STATUS.FINALIZED,
          exam_history_id: examHistoryId,
          awarded_xp: Math.max(0, Math.trunc(Number(awardedXp) || 0)),
          last_updated_at: new Date().toISOString(),
        })
        .eq('id', attemptId)
        .eq('status', ATTEMPT_STATUS.SUBMITTED);
    } catch {
      // The claimed attempt plus its single history row keep retries idempotent
      // even if this best-effort bookkeeping update fails.
    }
  }

  static async releaseClaim(attemptId: string): Promise<void> {
    try {
      await supabase
        .from('exam_progress')
        .update({
          status: ATTEMPT_STATUS.IN_PROGRESS,
          submitted_at: null,
          exam_history_id: null,
        })
        .eq('id', attemptId)
        .eq('status', ATTEMPT_STATUS.SUBMITTED);
    } catch {
      // Best effort rollback; a stuck attempt can be recovered by an operator.
    }
  }

  static async findHistoryByAttempt(attemptId: string) {
    const { data, error } = await supabase
      .from('exam_history')
      .select('*')
      .eq('attempt_id', attemptId)
      .maybeSingle();

    if (error) throw new Error(error.message);

    return data ?? null;
  }
}
