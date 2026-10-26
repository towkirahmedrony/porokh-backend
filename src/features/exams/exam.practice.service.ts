import { randomUUID } from 'crypto';
import { supabase } from '../../config/supabase';
import {
  ATTEMPT_KIND,
  ATTEMPT_STATUS,
  isAttemptExpiredForAttempt,
  isQuizPracticeMode,
  resolvePracticeDeadline,
} from './exam.timing';
import { findOptionById, isAnswerCorrect, isOptionCorrect } from './exam.grading';
import {
  ATTEMPT_ERROR_CODES,
  ATTEMPT_SELECT,
  ExamAttemptError,
  ExamAttemptService,
  loadPracticeDurationMinutes,
  toAttemptDto,
  type AttemptDto,
} from './exam.attempt.service';

type AnyObject = Record<string, any>;

export const PRACTICE_MODES = {
  RETAKE: 'retake',
  WRONG_FROM_HISTORY: 'wrong_from_history',
  WRONG_GLOBAL: 'wrong_global',
} as const;

export type PracticeMode = (typeof PRACTICE_MODES)[keyof typeof PRACTICE_MODES];

type PracticeEmptyReason = 'empty' | 'confirm_partial' | 'confirm_reduced';

type PracticeCommonResult = {
  mode: PracticeMode;
  source_history_id: string | null;
  available_count: number;
  unavailable_count: number;
  total_count: number;
  requested_count?: number;
};

export type PracticeEmptyResult = PracticeCommonResult & {
  started: false;
  reason: PracticeEmptyReason;
};

export type PracticeStartedResult = PracticeCommonResult & {
  started: true;
  resumed: boolean;
  attempt: AttemptDto;
};

export type PracticeStartResult = PracticeEmptyResult | PracticeStartedResult;

const MAX_PRACTICE_QUESTIONS = 100;

const normalizeId = (value: unknown): string => String(value ?? '').trim();

const normalizeQuestionIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  return Array.from(new Set(value.map(normalizeId).filter(Boolean)));
};

const toIso = (epochMs: number): string => new Date(epochMs).toISOString();

const quotaFeatureFor = (mode: PracticeMode): string =>
  mode === PRACTICE_MODES.WRONG_GLOBAL ? 'mistake_practice' : 'exam_start';

const mapPracticeRpcError = (error: unknown, resource: string): never => {
  const candidate = (error ?? {}) as AnyObject;
  const code = String(candidate.code ?? '');
  const message = String(candidate.message ?? '');

  if (code === 'P0002' || message.includes('history_not_found')) {
    throw new ExamAttemptError('Exam history not found', 404, {
      code: 'HISTORY_NOT_FOUND',
    });
  }

  if (code === 'P0403' || message.includes('premium_required')) {
    throw new ExamAttemptError(
      'Premium access is required to practise this content.',
      403,
      {
        code: ATTEMPT_ERROR_CODES.PREMIUM_REQUIRED,
        feature: 'premium_content',
        resource,
      },
      ATTEMPT_ERROR_CODES.PREMIUM_REQUIRED
    );
  }

  if (
    code === '22023' ||
    message.includes('invalid_count') ||
    message.includes('invalid_arguments')
  ) {
    throw new ExamAttemptError('Invalid practice request', 400, {
      code: 'INVALID_PRACTICE_REQUEST',
    });
  }

  throw new Error(message || 'Practice request failed');
};

const loadHistoryQuestionSet = async (
  userId: string,
  historyId: string
): Promise<{ total: number; available: string[]; unavailable: number }> => {
  const { data, error } = await supabase.rpc('get_history_question_set', {
    p_user_id: userId,
    p_history_id: historyId,
  });

  if (error) mapPracticeRpcError(error, 'exam_history');

  const rows = Array.isArray(data) ? data : [];
  const ordered = rows
    .map((row: AnyObject) => ({
      questionId: normalizeId(row.question_id),
      available: row.available === true,
    }))
    .filter((row) => Boolean(row.questionId));

  const available = ordered.filter((row) => row.available).map((row) => row.questionId);

  return {
    total: ordered.length,
    available,
    unavailable: ordered.length - available.length,
  };
};

const loadHistoryTimeLimit = async (
  userId: string,
  historyId: string
): Promise<number | null> => {
  const { data, error } = await supabase.rpc('get_history_time_limit', {
    p_user_id: userId,
    p_history_id: historyId,
  });

  if (error) mapPracticeRpcError(error, 'exam_history');

  const seconds = Number(data);
  return Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds) : null;
};

const loadHistoryWrongSet = async (
  userId: string,
  historyId: string
): Promise<{ total: number; available: string[]; unavailable: number }> => {
  const { data, error } = await supabase.rpc('get_history_wrong_questions', {
    p_user_id: userId,
    p_history_id: historyId,
  });

  if (error) mapPracticeRpcError(error, 'exam_history');

  const rows = Array.isArray(data) ? data : [];
  const ordered = rows
    .map((row: AnyObject) => ({
      questionId: normalizeId(row.question_id),
      available: row.available === true,
    }))
    .filter((row) => Boolean(row.questionId));

  const available = ordered.filter((row) => row.available).map((row) => row.questionId);

  return {
    total: ordered.length,
    available,
    unavailable: ordered.length - available.length,
  };
};

const consumePracticeQuota = async (
  userId: string,
  feature: string,
  attemptId: string
): Promise<void> => {
  const { data, error } = await supabase.rpc('consume_quota', {
    p_user_id: userId,
    p_feature: feature,
    p_reference_id: attemptId,
  });

  if (error) throw new Error(error.message);

  if (!data?.allowed) {
    throw new ExamAttemptError(
      'Daily practice limit reached.',
      403,
      {
        code: ATTEMPT_ERROR_CODES.FREE_LIMIT_REACHED,
        feature,
        limit: data?.limit,
        used: data?.used,
        reset_at: data?.reset_at,
      },
      ATTEMPT_ERROR_CODES.FREE_LIMIT_REACHED
    );
  }
};

const refundPracticeQuota = async (
  userId: string,
  feature: string,
  attemptId: string
): Promise<void> => {
  try {
    await supabase.rpc('refund_quota', {
      p_user_id: userId,
      p_feature: feature,
      p_reference_id: attemptId,
    });
  } catch {
    // Best effort. The reference id makes a later reconciliation idempotent.
  }
};

const findInProgressPracticeAttempt = async (
  userId: string,
  mode: PracticeMode,
  sourceHistoryId: string | null
): Promise<AnyObject | null> => {
  let query = supabase
    .from('exam_progress')
    .select(ATTEMPT_SELECT)
    .eq('user_id', userId)
    .eq('kind', ATTEMPT_KIND.PRACTICE)
    .eq('status', ATTEMPT_STATUS.IN_PROGRESS)
    .eq('practice_mode', mode);

  query = sourceHistoryId
    ? query.eq('source_history_id', sourceHistoryId)
    : query.is('source_history_id', null);

  const { data, error } = await query
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return data ?? null;
};

const practiceLocks = new Map<string, Promise<void>>();

const withPracticeLock = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
  const previous = practiceLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);

  practiceLocks.set(key, queued);

  await previous.catch(() => undefined);

  try {
    return await task();
  } finally {
    release();
    if (practiceLocks.get(key) === queued) practiceLocks.delete(key);
  }
};

const emptyResult = (
  mode: PracticeMode,
  sourceHistoryId: string | null,
  counts: {
    available: number;
    unavailable: number;
    total: number;
    requested?: number;
  },
  reason: PracticeEmptyReason
): PracticeEmptyResult => ({
  started: false,
  reason,
  mode,
  source_history_id: sourceHistoryId,
  available_count: counts.available,
  unavailable_count: counts.unavailable,
  total_count: counts.total,
  ...(counts.requested !== undefined ? { requested_count: counts.requested } : {}),
});

const insertPracticeAttempt = async (params: {
  userId: string;
  mode: PracticeMode;
  sourceHistoryId: string | null;
  questionIds: string[];
  counts: { available: number; unavailable: number; total: number; requested?: number };
  now: number;
  timeLimitSeconds?: number | null;
}): Promise<PracticeStartedResult> => {
  const { userId, mode, sourceHistoryId, questionIds, counts, now, timeLimitSeconds } = params;

  return withPracticeLock(`${userId}:${mode}:${sourceHistoryId ?? 'global'}`, async () => {
    const existing = await findInProgressPracticeAttempt(userId, mode, sourceHistoryId);

    if (existing) {
      if (!isAttemptExpiredForAttempt(existing, now)) {
        await consumePracticeQuota(userId, quotaFeatureFor(mode), existing.id);

        return {
          started: true,
          resumed: true,
          mode,
          source_history_id: sourceHistoryId,
          available_count: counts.available,
          unavailable_count: counts.unavailable,
          total_count: counts.total,
          ...(counts.requested !== undefined ? { requested_count: counts.requested } : {}),
          attempt: toAttemptDto(existing, now),
        };
      }

      await ExamAttemptService.expireAttempt(existing.id);
    }

    const attemptId = randomUUID();
    const feature = quotaFeatureFor(mode);

    await consumePracticeQuota(userId, feature, attemptId);

    const untimed = isQuizPracticeMode(mode);
    let deadline: number | null = null;

    if (!untimed) {
      const durationMinutes = await loadPracticeDurationMinutes();
      const limitSeconds = Number(timeLimitSeconds);

      deadline =
        Number.isFinite(limitSeconds) && limitSeconds > 0
          ? now + Math.trunc(limitSeconds) * 1000
          : resolvePracticeDeadline(now, durationMinutes);
    }

    const insertPayload: AnyObject = {
      id: attemptId,
      user_id: userId,
      exam_id: null,
      kind: ATTEMPT_KIND.PRACTICE,
      status: ATTEMPT_STATUS.IN_PROGRESS,
      practice_mode: mode,
      started_at: toIso(now),
      deadline_at: deadline === null ? null : toIso(deadline),
      question_ids: questionIds,
      answers_draft: {},
      current_question_index: 0,
      time_remaining: deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000)),
      last_updated_at: toIso(now),
    };

    if (sourceHistoryId) insertPayload.source_history_id = sourceHistoryId;

    let insertResult;

    try {
      insertResult = await supabase
        .from('exam_progress')
        .insert([insertPayload])
        .select(ATTEMPT_SELECT)
        .single();
    } catch (thrown) {
      await refundPracticeQuota(userId, feature, attemptId);
      throw thrown;
    }

    const { data, error } = insertResult;

    if (error) {
      await refundPracticeQuota(userId, feature, attemptId);

      if ((error as AnyObject).code === '23505') {
        const concurrent = await findInProgressPracticeAttempt(userId, mode, sourceHistoryId);

        if (concurrent) {
          return {
            started: true,
            resumed: true,
            mode,
            source_history_id: sourceHistoryId,
            available_count: counts.available,
            unavailable_count: counts.unavailable,
            total_count: counts.total,
            ...(counts.requested !== undefined ? { requested_count: counts.requested } : {}),
            attempt: toAttemptDto(concurrent, now),
          };
        }
      }

      throw new Error(error.message);
    }

    return {
      started: true,
      resumed: false,
      mode,
      source_history_id: sourceHistoryId,
      available_count: counts.available,
      unavailable_count: counts.unavailable,
      total_count: counts.total,
      ...(counts.requested !== undefined ? { requested_count: counts.requested } : {}),
      attempt: toAttemptDto(data, now),
    };
  });
};


const normalizePracticeExplanation = (
  value: unknown
): { bn: string; en: string } | null => {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    const text = value.trim();
    return text ? { bn: text, en: text } : null;
  }

  if (typeof value !== 'object') return null;

  const explanation = value as AnyObject;
  const bn = typeof explanation.bn === 'string' ? explanation.bn : '';
  const en = typeof explanation.en === 'string' ? explanation.en : '';

  return bn || en ? { bn, en } : null;
};

export class ExamPracticeService {
  static async getMistakePool(userId: string): Promise<{ available_count: number }> {
    if (!userId) throw new ExamAttemptError('Unauthorized', 401);

    const { data, error } = await supabase.rpc('count_mistake_pool', {
      p_user_id: userId,
    });

    if (error) mapPracticeRpcError(error, 'mistake_pool');

    const count = Number(data);
    return { available_count: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0 };
  }

  static async startRetake(
    userId: string,
    historyId: unknown,
    confirmPartial = false
  ): Promise<PracticeStartResult> {
    if (!userId) throw new ExamAttemptError('Unauthorized', 401);

    const normalizedHistoryId = normalizeId(historyId);
    if (!normalizedHistoryId) {
      throw new ExamAttemptError('History id is required', 400);
    }

    const [set, timeLimitSeconds] = await Promise.all([
      loadHistoryQuestionSet(userId, normalizedHistoryId),
      loadHistoryTimeLimit(userId, normalizedHistoryId),
    ]);

    if (set.available.length === 0) {
      return emptyResult(
        PRACTICE_MODES.RETAKE,
        normalizedHistoryId,
        { available: 0, unavailable: set.unavailable, total: set.total },
        'empty'
      );
    }

    if (set.unavailable > 0 && !confirmPartial) {
      return emptyResult(
        PRACTICE_MODES.RETAKE,
        normalizedHistoryId,
        { available: set.available.length, unavailable: set.unavailable, total: set.total },
        'confirm_partial'
      );
    }

    return insertPracticeAttempt({
      userId,
      mode: PRACTICE_MODES.RETAKE,
      sourceHistoryId: normalizedHistoryId,
      questionIds: set.available,
      counts: { available: set.available.length, unavailable: set.unavailable, total: set.total },
      now: Date.now(),
      timeLimitSeconds,
    });
  }

  static async startWrongFromHistory(
    userId: string,
    historyId: unknown
  ): Promise<PracticeStartResult> {
    if (!userId) throw new ExamAttemptError('Unauthorized', 401);

    const normalizedHistoryId = normalizeId(historyId);
    if (!normalizedHistoryId) {
      throw new ExamAttemptError('History id is required', 400);
    }

    const set = await loadHistoryWrongSet(userId, normalizedHistoryId);

    if (set.available.length === 0) {
      return emptyResult(
        PRACTICE_MODES.WRONG_FROM_HISTORY,
        normalizedHistoryId,
        { available: 0, unavailable: set.unavailable, total: set.total },
        'empty'
      );
    }

    return insertPracticeAttempt({
      userId,
      mode: PRACTICE_MODES.WRONG_FROM_HISTORY,
      sourceHistoryId: normalizedHistoryId,
      questionIds: set.available,
      counts: { available: set.available.length, unavailable: set.unavailable, total: set.total },
      now: Date.now(),
    });
  }

  static async startMistakePractice(
    userId: string,
    requestedCount: unknown,
    confirmReduced = false
  ): Promise<PracticeStartResult> {
    if (!userId) throw new ExamAttemptError('Unauthorized', 401);

    const count = Number(requestedCount);

    if (!Number.isInteger(count) || count < 1 || count > MAX_PRACTICE_QUESTIONS) {
      throw new ExamAttemptError('Practice question count must be between 1 and 100', 400, {
        code: 'INVALID_PRACTICE_REQUEST',
      });
    }

    const pool = await ExamPracticeService.getMistakePool(userId);
    const available = pool.available_count;

    if (available === 0) {
      return emptyResult(
        PRACTICE_MODES.WRONG_GLOBAL,
        null,
        { available: 0, unavailable: 0, total: 0, requested: count },
        'empty'
      );
    }

    if (count > available && !confirmReduced) {
      return emptyResult(
        PRACTICE_MODES.WRONG_GLOBAL,
        null,
        { available, unavailable: 0, total: available, requested: count },
        'confirm_reduced'
      );
    }

    const target = Math.min(count, available);
    const { data, error } = await supabase.rpc('pick_mistake_questions', {
      p_user_id: userId,
      p_count: target,
    });

    if (error) mapPracticeRpcError(error, 'mistake_pool');

    const questionIds = normalizeQuestionIds(
      (Array.isArray(data) ? data : []).map((row: AnyObject) => row.question_id)
    );

    if (questionIds.length === 0) {
      return emptyResult(
        PRACTICE_MODES.WRONG_GLOBAL,
        null,
        { available, unavailable: 0, total: available, requested: count },
        'empty'
      );
    }

    return insertPracticeAttempt({
      userId,
      mode: PRACTICE_MODES.WRONG_GLOBAL,
      sourceHistoryId: null,
      questionIds,
      counts: {
        available: questionIds.length,
        unavailable: 0,
        total: available,
        requested: count,
      },
      now: Date.now(),
    });
  }
  static async answerPracticeQuestion(
    userId: string,
    attemptId: unknown,
    questionId: unknown,
    selectedOption: unknown
  ) {
    if (!userId) throw new ExamAttemptError('Unauthorized', 401);

    const normalizedAttemptId = normalizeId(attemptId);
    const normalizedQuestionId = normalizeId(questionId);
    const normalizedOptionId = normalizeId(selectedOption);

    if (!normalizedAttemptId) throw new ExamAttemptError('Attempt id is required', 400);
    if (!normalizedQuestionId) throw new ExamAttemptError('Question id is required', 400);
    if (!normalizedOptionId) throw new ExamAttemptError('Selected option is required', 400);

    return withPracticeLock(`answer:${normalizedAttemptId}`, async () => {
      // The attempt and the question are independent reads; overlap them so
      // answering waits for one round trip instead of two.
      const [attempt, questionResult] = await Promise.all([
        ExamAttemptService.getAttempt(userId, normalizedAttemptId),
        supabase
          .from('questions')
          .select('id, options, explanation, is_active, status, deleted_at')
          .eq('id', normalizedQuestionId)
          .maybeSingle(),
      ]);

      if (!attempt) throw new ExamAttemptError('Attempt not found', 404);
      if (attempt.status !== ATTEMPT_STATUS.IN_PROGRESS) {
        throw new ExamAttemptError('Attempt is no longer in progress', 409);
      }
      if (!isQuizPracticeMode(attempt.practice_mode)) {
        throw new ExamAttemptError('This attempt does not support answer reveal', 409);
      }
      if (isAttemptExpiredForAttempt(attempt)) {
        await ExamAttemptService.expireAttempt(attempt.id);
        throw new ExamAttemptError('Attempt has expired', 409);
      }

      const questionIds = normalizeQuestionIds(attempt.question_ids);
      const questionIndex = questionIds.indexOf(normalizedQuestionId);

      if (questionIndex < 0) {
        throw new ExamAttemptError('Question does not belong to this attempt', 400);
      }

      const answersDraft =
        attempt.answers_draft &&
        typeof attempt.answers_draft === 'object' &&
        !Array.isArray(attempt.answers_draft)
          ? { ...attempt.answers_draft }
          : {};

      const existingAnswer = answersDraft[normalizedQuestionId];
      if (existingAnswer !== undefined && existingAnswer !== null && String(existingAnswer).trim() !== '') {
        throw new ExamAttemptError('This question has already been answered', 409);
      }

      const { data: question, error } = questionResult;

      if (error) throw new Error(error.message);

      if (
        !question ||
        question.is_active !== true ||
        question.status !== 'published' ||
        question.deleted_at !== null
      ) {
        throw new ExamAttemptError('Question is no longer available', 409);
      }

      const options: AnyObject[] = Array.isArray(question.options) ? question.options : [];
      const selected = findOptionById(options, normalizedOptionId);

      if (!selected) throw new ExamAttemptError('Selected option is invalid', 400);

      const correct = options.find((option) => isOptionCorrect(option)) ?? null;
      const isCorrect = isAnswerCorrect(options, normalizedOptionId);
      const now = Date.now();

      answersDraft[normalizedQuestionId] = normalizedOptionId;

      const { data: updated, error: updateError } = await supabase
        .from('exam_progress')
        .update({
          answers_draft: answersDraft,
          current_question_index: questionIndex,
          last_updated_at: toIso(now),
        })
        .eq('id', attempt.id)
        .eq('user_id', userId)
        .eq('status', ATTEMPT_STATUS.IN_PROGRESS)
        .select(ATTEMPT_SELECT);

      if (updateError) throw new Error(updateError.message);
      if (!updated || updated.length === 0) {
        throw new ExamAttemptError('Attempt is no longer in progress', 409);
      }

      return {
        is_correct: isCorrect,
        correct_option: correct
          ? {
              id: normalizeId(correct.id),
              text_bn: correct.text_bn ?? null,
              text_en: correct.text_en ?? null,
              image_url: correct.image_url ?? null,
            }
          : null,
        explanation: normalizePracticeExplanation(question.explanation),
      };
    });
  }

}
