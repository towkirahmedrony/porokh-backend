import { randomUUID } from 'crypto';
import { supabase } from '../../config/supabase';
import {
  ATTEMPT_KIND,
  ATTEMPT_STATUS,
  isAttemptExpired,
  resolvePracticeDeadline,
} from './exam.timing';
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
}): Promise<PracticeStartedResult> => {
  const { userId, mode, sourceHistoryId, questionIds, counts, now } = params;

  return withPracticeLock(`${userId}:${mode}:${sourceHistoryId ?? 'global'}`, async () => {
    const existing = await findInProgressPracticeAttempt(userId, mode, sourceHistoryId);

    if (existing) {
      if (!isAttemptExpired(existing.deadline_at, now)) {
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

    const durationMinutes = await loadPracticeDurationMinutes();
    const deadline = resolvePracticeDeadline(now, durationMinutes);

    const insertPayload: AnyObject = {
      id: attemptId,
      user_id: userId,
      exam_id: null,
      kind: ATTEMPT_KIND.PRACTICE,
      status: ATTEMPT_STATUS.IN_PROGRESS,
      practice_mode: mode,
      started_at: toIso(now),
      deadline_at: toIso(deadline),
      question_ids: questionIds,
      answers_draft: {},
      current_question_index: 0,
      time_remaining: Math.max(0, Math.ceil((deadline - now) / 1000)),
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

    const set = await loadHistoryQuestionSet(userId, normalizedHistoryId);

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
}
