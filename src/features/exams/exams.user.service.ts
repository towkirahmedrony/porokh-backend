import crypto from 'crypto';
import { supabase } from '../../config/supabase';
import { GenerateExamDTO, SubmitHistoryDTO } from './exams.types';
import { ATTEMPT_STATUS, isAttemptExpiredForAttempt } from './exam.timing';
import { ExamAttemptError, ExamAttemptService, loadUserAccess } from './exam.attempt.service';
import {
  findOptionById,
  isAnswerCorrect,
  isAnswerDisclosureAllowed,
  isOptionCorrect,
  normalizeOptionId,
  optionDisplayText,
} from './exam.grading';

type AnyObject = Record<string, any>;

type SubmitExamPayload = {
  exam_id?: string | null;
  session_id?: string | null;
  user_id: string;
  attempt_id?: string | null;
  answers?: Record<string, string | number | null | undefined>;
  question_ids?: string[];
  time_taken?: number;
};

const XP_RULES_CACHE_TTL_MS = 60_000;
let xpRulesCache: { rules: AnyObject; expiresAt: number } | null = null;

const loadXpRules = async (): Promise<AnyObject> => {
  if (xpRulesCache && xpRulesCache.expiresAt > Date.now()) {
    return xpRulesCache.rules;
  }

  const { data } = await supabase
    .from('app_configs')
    .select('value')
    .eq('key', 'xp_rules')
    .maybeSingle();

  const rules = (data?.value as AnyObject) || {};
  xpRulesCache = { rules, expiresAt: Date.now() + XP_RULES_CACHE_TTL_MS };

  return rules;
};

export const calculateExamXP = async (
  correctCount: number,
  totalQuestions: number
): Promise<number> => {
  const rules = await loadXpRules();

  let xp = 20;
  const perCorrect = Number(rules.per_correct_answer || 5);
  xp += correctCount * perCorrect;

  if (totalQuestions > 0) {
    const accuracy = correctCount / totalQuestions;

    if (accuracy === 1) {
      xp += 100;
    } else if (accuracy >= 0.8) {
      xp += 30;
    }
  }

  return Math.max(0, Math.floor(xp));
};

const normalizeId = (value: unknown): string => String(value ?? '').trim();

const toIso = (epochMs: number): string => new Date(epochMs).toISOString();

/**
 * Client-supplied idempotency key for a submission.
 *
 * Only a conservative shape is accepted. An unusable value is ignored (the
 * submission still works, it simply keeps no idempotency guarantee) so a
 * malformed key can never influence the persisted primary key.
 */
const normalizeSubmissionKey = (value: unknown): string | null => {
  const raw = String(value ?? '').trim();

  return /^[A-Za-z0-9_-]{8,128}$/.test(raw) ? raw : null;
};

/**
 * Derives the `exam_history` primary key from (user, submission key).
 *
 * `exam_history.id` is the only unique key that exists on every deployment, so
 * using it as the idempotency key makes a repeated submission collide with the
 * first one (unique violation) instead of writing a second result. Including the
 * user id keeps two students with the same key in separate rows.
 */
const deterministicHistoryId = (userId: string, submissionKey: string): string => {
  const digest = crypto
    .createHash('sha256')
    .update(`porokh-exam-submission:${userId}:${submissionKey}`)
    .digest('hex')
    .split('');

  // Present the digest as a well-formed v4-shaped UUID.
  digest[12] = '4';
  digest[16] = ((parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);

  const hex = digest.slice(0, 32).join('');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const MAX_TIME_TAKEN_SECONDS = 24 * 60 * 60;

/** Hard cap for an untracked (attempt-less) practice submission. */
const MAX_UNTRACKED_PRACTICE_QUESTIONS = 100;

/** Upper bound on the candidate pool for randomized question selection. */
const MAX_QUESTION_CANDIDATES = 500;

const MAX_GENERATE_TOPICS = 50;

const MIN_QUESTION_LIMIT = 1;
const MAX_QUESTION_LIMIT = 100;

/** Fisher-Yates shuffle; never mutates the caller's array. */
const shuffleInPlace = <T>(items: T[]): T[] => {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }

  return items;
};

const clampQuestionLimit = (value: unknown, fallback = 10): number => {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) return fallback;

  return Math.min(Math.max(Math.trunc(numeric), MIN_QUESTION_LIMIT), MAX_QUESTION_LIMIT);
};

/**
 * Question ids that belong to an exam paper. Used to stop an untracked practice
 * submission from harvesting the answer key of live/upcoming exam questions.
 */
const findExamPaperQuestionIds = async (questionIds: string[]): Promise<string[]> => {
  if (questionIds.length === 0) return [];

  const { data, error } = await supabase
    .from('exam_paper_questions')
    .select('question_id')
    .in('question_id', questionIds);

  if (error) throw new Error(error.message);

  return (data || [])
    .map((row: AnyObject) => normalizeId(row.question_id))
    .filter(Boolean);
};

/** Premium subject ids, used to keep non-premium modes free of locked content. */
const loadPremiumSubjectIds = async (): Promise<string[]> => {
  const { data, error } = await supabase.from('subjects').select('id').eq('is_premium', true);

  if (error) return [];

  return (data || []).map((row: AnyObject) => normalizeId(row.id)).filter(Boolean);
};

const userHasPremiumAccess = async (userId: string): Promise<boolean> => {
  try {
    const access = await loadUserAccess(userId);

    return access?.premium === true || access?.unlimited_all === true;
  } catch {
    return false;
  }
};

const clampTimeTaken = (value: unknown): number => {
  const number = Number(value);

  if (!Number.isFinite(number)) return 0;

  return Math.max(0, Math.min(Math.round(number), MAX_TIME_TAKEN_SECONDS));
};

/**
 * A PostgREST error raised because a column the code expects does not exist in
 * the connected database. This is an operational state (schema not migrated),
 * not a client error, so callers map it to a clear 503 instead of a 500.
 */
const isSchemaDriftError = (error: unknown): boolean => {
  const candidate = error as AnyObject;
  const code = String(candidate?.code ?? '');
  const message = String(candidate?.message ?? '');

  return (
    code === '42703' ||
    code === 'PGRST204' ||
    /column .* does not exist/i.test(message) ||
    /could not find the '.*' column/i.test(message)
  );
};

const isEmptyAnswer = (value: unknown): boolean => {
  return value === undefined || value === null || String(value).trim() === '';
};

const sanitizeOptions = (options: any, includeCorrectAnswers = false): any[] => {
  if (!Array.isArray(options)) return [];

  return options.map((opt: any) => {
    const sanitized: AnyObject = {
      id: opt.id,
      text_bn: opt.text_bn,
      text_en: opt.text_en,
      image_url: opt.image_url ?? null,
    };

    if (includeCorrectAnswers) {
      sanitized.isCorrect = isOptionCorrect(opt);
    }

    return sanitized;
  });
};

const normalizeExplanation = (value: unknown): { bn: string; en: string } | null => {
  if (value === null || value === undefined) return null;

  if (typeof value === 'object') {
    const explanation = value as AnyObject;
    const bn = typeof explanation.bn === 'string' ? explanation.bn : '';
    const en = typeof explanation.en === 'string' ? explanation.en : '';
    return bn || en ? { bn, en } : null;
  }

  return null;
};

const sanitizeMedia = (media: AnyObject | null | undefined) => {
  if (!media) return null;

  return {
    id: media.id,
    file_name: media.file_name,
    file_type: media.file_type,
    file_url: media.file_url,
  };
};

export const sanitizeQuestionForClient = (
  q: AnyObject,
  options: { includeCorrectAnswers?: boolean } = {}
) => ({
  id: q.id,
  subject_id: q.subject_id,
  chapter_id: q.chapter_id,
  topic_id: q.topic_id,
  comprehension_id: q.comprehension_id,
  type: q.type,
  difficulty_level: q.difficulty_level,

  body: q.body
    ? {
        text_bn: q.body.text_bn,
        text_en: q.body.text_en,
        image_url: q.body.image_url ?? null,
      }
    : null,

  options: sanitizeOptions(q.options, options.includeCorrectAnswers === true),

  media_id: q.media_id ?? null,
  media_library: sanitizeMedia(q.media_library),

  comprehension: q.comprehension
    ? {
        id: q.comprehension.id,
        body: q.comprehension.body,
        sequence: q.comprehension.sequence ?? null,
        media_id: q.comprehension.media_id ?? null,
        media_library: sanitizeMedia(q.comprehension.media_library),
      }
    : null,

  category: q.category ?? undefined,
});

export const sanitizeQuestionsForClient = (questions: AnyObject[] = []) => {
  return questions.map((question) => sanitizeQuestionForClient(question));
};

const EXAM_QUESTION_SELECT_QUERY = `
  id,
  subject_id,
  chapter_id,
  topic_id,
  comprehension_id,
  type,
  difficulty_level,
  body,
  options,
  media_id,
  media_library!questions_media_id_fkey(
    id,
    file_name,
    file_type,
    file_url
  ),
  comprehension:comprehensions!questions_comprehension_id_fkey(
    id,
    body,
    sequence,
    media_id,
    media_library!comprehensions_media_id_fkey(
      id,
      file_name,
      file_type,
      file_url
    )
  )
`;

const EXAM_REVIEW_QUESTION_SELECT_QUERY = `${EXAM_QUESTION_SELECT_QUERY.trim()}, explanation`;

const buildQuestionIds = (
  questionIdsFromPayload: unknown,
  answers: Record<string, unknown>
): string[] => {
  const fromPayload = Array.isArray(questionIdsFromPayload)
    ? questionIdsFromPayload.map(normalizeId)
    : [];

  const fromAnswers = Object.keys(answers || {}).map(normalizeId);

  return Array.from(new Set([...fromPayload, ...fromAnswers])).filter(Boolean);
};

const buildQuestionSnapshot = (question: AnyObject, includeCorrectAnswers: boolean) => ({
  ...sanitizeQuestionForClient(question, { includeCorrectAnswers }),
  explanation: includeCorrectAnswers ? normalizeExplanation(question.explanation) : null,
});

const parseDetailsJson = (raw: unknown): AnyObject => {
  if (raw === null || raw === undefined) return {};

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as AnyObject) : {};
    } catch {
      return {};
    }
  }

  return typeof raw === 'object' ? (raw as AnyObject) : {};
};

/**
 * Explicit allowlist for a single student-facing answer detail. Historical
 * details_json rows may contain extra fields (including answer-key data) from
 * older deployments, so we never spread a stored detail into a response.
 */
const sanitizeDetailForClient = (
  detail: AnyObject,
  question: AnyObject | undefined,
  includeCorrectAnswers: boolean
) => {
  const options: AnyObject[] = Array.isArray(question?.options) ? question!.options : [];
  const selectedOption = findOptionById(options, detail?.selected_option);
  const correctOption = options.find((option) => isOptionCorrect(option)) ?? null;

  const sanitized: AnyObject = {
    question_id: normalizeId(detail?.question_id),
    selected_option: detail?.selected_option ?? null,
    selected_option_text:
      detail?.selected_option_text ?? optionDisplayText(selectedOption),
    is_correct: typeof detail?.is_correct === 'boolean' ? detail.is_correct : null,
    marks_awarded: typeof detail?.marks_awarded === 'number' ? detail.marks_awarded : 0,
    status: typeof detail?.status === 'string' ? detail.status : 'unknown',
  };

  if (typeof detail?.time_spent === 'number') {
    sanitized.time_spent = detail.time_spent;
  }

  if (includeCorrectAnswers) {
    sanitized.correct_option_id =
      detail?.correct_option_id ?? (correctOption ? normalizeOptionId(correctOption.id) : null);
    sanitized.correct_option_text =
      detail?.correct_option_text ?? optionDisplayText(correctOption);
  }

  return sanitized;
};

/**
 * Stored question snapshots are treated as untrusted legacy data. Rebuild the
 * student-facing shape from the allowlisted fields instead of returning the
 * stored object verbatim.
 */
const sanitizeStoredQuestionSnapshot = (
  question: AnyObject,
  includeCorrectAnswers: boolean
) => {
  const sanitized = sanitizeQuestionForClient(question, { includeCorrectAnswers });

  return {
    ...sanitized,
    explanation: includeCorrectAnswers ? normalizeExplanation(question?.explanation) : null,
  };
};

const sanitizeAnswerMap = (
  answers: Record<string, unknown>,
  allowedQuestionIds: Set<string>
): Record<string, string | null> => {
  const sanitized: Record<string, string | null> = {};

  Object.entries(answers || {}).forEach(([questionId, value]) => {
    const normalizedQuestionId = normalizeId(questionId);

    if (!normalizedQuestionId || !allowedQuestionIds.has(normalizedQuestionId)) return;
    if (value !== null && typeof value === 'object') return;

    const normalizedValue = isEmptyAnswer(value) ? null : String(value).trim();
    sanitized[normalizedQuestionId] = normalizedValue;
  });

  return sanitized;
};

const buildStudentFacingDetailsJson = (
  detailsJson: AnyObject,
  payload: {
    answers: Record<string, string | null>;
    details: AnyObject[];
    questions: AnyObject[];
    includeCorrectAnswers: boolean;
    bookmarkedIds?: unknown;
  }
) => ({
  session_id: detailsJson?.session_id ?? null,
  answers: payload.answers,
  details: payload.details,
  questions: payload.questions,
  correct_answers_revealed: payload.includeCorrectAnswers,
  bookmarked_ids: Array.isArray(payload.bookmarkedIds) ? payload.bookmarkedIds : [],
});

const loadQuestionSnapshotMap = async (
  questionIds: string[]
): Promise<Map<string, AnyObject>> => {
  if (questionIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from('questions')
    .select(EXAM_REVIEW_QUESTION_SELECT_QUERY)
    .in('id', questionIds);

  if (error) throw new Error(error.message);

  const questionMap = new Map<string, AnyObject>();
  (data || []).forEach((question: AnyObject) => {
    questionMap.set(normalizeId(question.id), question);
  });

  return questionMap;
};

const loadResultPublishTime = async (examId: string | null): Promise<string | null> => {
  if (!examId) return null;

  const { data, error } = await supabase
    .from('exam_papers')
    .select('result_publish_time')
    .eq('id', examId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return data?.result_publish_time ?? null;
};

/**
 * Returns the authoritative question set for an exam. This relationship is the
 * only source of truth for which question ids may be graded or snapshotted.
 */
const loadExamQuestionIds = async (examId: string): Promise<string[]> => {
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


type GroupBattleRequest = {
  exam_id?: string;
  id?: string;
  subject_id?: string;
  chapter_id?: string;
  question_count?: number;
  limit?: number;
  group_id?: string;
  title?: string;
};

const loadBattleParticipant = async (userId: string) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, current_group_id')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return data ?? null;
};

/**
 * Both participants must belong to the battle's group. Membership is read from
 * `group_members`; when that read is unavailable the profile's
 * `current_group_id` is used as a conservative equivalent check.
 */
const assertSharedGroupMembership = async (
  groupId: string,
  challengerId: string,
  opponentId: string
): Promise<void> => {
  const membershipOf = async (userId: string): Promise<boolean | null> => {
    const { data, error } = await supabase
      .from('group_members')
      .select('id, status')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) return null;

    return Boolean(data) && data?.status !== 'left' && data?.status !== 'banned';
  };

  const [challengerMember, opponentMember] = await Promise.all([
    membershipOf(challengerId),
    membershipOf(opponentId),
  ]);

  if (challengerMember === null || opponentMember === null) {
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, current_group_id')
      .in('id', [challengerId, opponentId]);

    if (error) throw new Error(error.message);

    const byId = new Map((profiles || []).map((row: AnyObject) => [normalizeId(row.id), row]));

    const challengerGroup = normalizeId(byId.get(challengerId)?.current_group_id);
    const opponentGroup = normalizeId(byId.get(opponentId)?.current_group_id);

    if (challengerGroup !== groupId) {
      throw new ExamAttemptError('You are not a member of this group', 403);
    }

    if (opponentGroup !== groupId) {
      throw new ExamAttemptError('Opponent is not a member of this group', 403);
    }

    return;
  }

  if (!challengerMember) {
    throw new ExamAttemptError('You are not a member of this group', 403);
  }

  if (!opponentMember) {
    throw new ExamAttemptError('Opponent is not a member of this group', 403);
  }
};

/**
 * Random published, non-premium question ids for a battle paper. The candidate
 * pool is bounded, shuffled in memory and then truncated.
 */
export const selectGroupBattleQuestionIds = async (params: {
  subjectId: string | null;
  chapterId: string | null;
  count: number;
  userId: string;
}): Promise<string[]> => {
  let query = supabase
    .from('questions')
    .select('id')
    .eq('is_active', true)
    .eq('status', 'published')
    .is('deleted_at', null)
    .limit(MAX_QUESTION_CANDIDATES);

  if (params.subjectId) query = query.eq('subject_id', params.subjectId);

  if (params.chapterId) query = query.eq('chapter_id', params.chapterId);

  if (!(await userHasPremiumAccess(params.userId))) {
    const premiumSubjectIds = await loadPremiumSubjectIds();

    if (premiumSubjectIds.length > 0) {
      query = query.not(
        'subject_id',
        'in',
        `(${premiumSubjectIds.map((id) => `"${id}"`).join(',')})`
      );
    }
  }

  const { data, error } = await query;

  if (error) throw new Error(error.message);

  const ids = (data || []).map((row: AnyObject) => normalizeId(row.id)).filter(Boolean);

  return shuffleInPlace(ids).slice(0, params.count);
};

/**
 * Loads the published questions for a group battle, including answer keys.
 *
 * Only the backend calls this. The public projection is produced separately
 * with `sanitizeQuestionsForClient`, so keys never leave the server before
 * submission.
 */
export const loadGroupBattleQuestions = async (questionIds: string[]): Promise<AnyObject[]> => {
  if (questionIds.length === 0) return [];

  const { data, error } = await supabase
    .from('questions')
    .select(EXAM_REVIEW_QUESTION_SELECT_QUERY)
    .in('id', questionIds)
    .eq('is_active', true)
    .eq('status', 'published')
    .is('deleted_at', null);

  if (error) throw new Error(error.message);

  const byId = new Map<string, AnyObject>(
    (data || []).map((question: AnyObject) => [normalizeId(question.id), question])
  );

  return questionIds
    .map((id) => byId.get(normalizeId(id)))
    .filter((question): question is AnyObject => Boolean(question));
};

export class ExamUserService {
  static async generateExam(userId: string, payload: GenerateExamDTO) {
    if (!userId) throw new ExamAttemptError('Unauthorized', 401);

    const { topics, limit } = (payload ?? {}) as { topics?: unknown; limit?: unknown };

    if (!Array.isArray(topics) || topics.length === 0) {
      throw new ExamAttemptError('Topic list is required', 400);
    }

    if (topics.length > MAX_GENERATE_TOPICS) {
      throw new ExamAttemptError(`At most ${MAX_GENERATE_TOPICS} topics may be requested`, 400);
    }

    const normalizedTopics = Array.from(
      new Set(topics.map((topic) => normalizeId(topic)))
    ).filter(Boolean);

    if (normalizedTopics.length !== topics.length) {
      throw new ExamAttemptError('Topic list must contain valid topic ids', 400);
    }

    const safeLimit = clampQuestionLimit(limit, 10);

    // A bounded candidate pool is shuffled in memory and then truncated. The
    // pool is deliberately larger than the requested count so repeated requests
    // do not always return the same first N rows, but never unbounded.
    let query = supabase
      .from('questions')
      .select(EXAM_QUESTION_SELECT_QUERY)
      .in('topic_id', normalizedTopics)
      .eq('is_active', true)
      .eq('status', 'published')
      .is('deleted_at', null)
      .limit(MAX_QUESTION_CANDIDATES);

    // Arena/model-test generation is non-premium content: a student without
    // access must never be served a locked question. Fetch the access state and
    // subject list concurrently; neither depends on the other.
    const [hasPremiumAccess, premiumSubjectIds] = await Promise.all([
      userHasPremiumAccess(userId),
      loadPremiumSubjectIds(),
    ]);

    if (!hasPremiumAccess) {
      if (premiumSubjectIds.length > 0) {
        query = query.not(
          'subject_id',
          'in',
          `(${premiumSubjectIds.map((id) => `"${id}"`).join(',')})`
        );
      }
    }

    const { data: questions, error } = await query;

    if (error) throw new Error(error.message);

    const candidates = sanitizeQuestionsForClient(questions || []);

    return shuffleInPlace(candidates).slice(0, safeLimit);
  }

  static async getArenaQuestions(userId: string, limit: number, subjectSlug?: string) {
    if (!userId) throw new ExamAttemptError('Unauthorized', 401);

    const safeLimit = clampQuestionLimit(limit, 10);
    let subjectId: string | null = null;

    if (subjectSlug) {
      const { data: subjectData, error: subjectError } = await supabase
        .from('subjects')
        .select('id')
        .eq('slug', subjectSlug)
        .maybeSingle();

      if (subjectError) {
        throw new Error(subjectError.message);
      }

      subjectId = subjectData?.id ?? null;
    }

    const { data, error } = await supabase.rpc('get_mixed_adaptive_questions', {
      p_user_id: userId,
      p_limit: safeLimit,
      p_subject_id: subjectId,
    });

    if (error) {
      console.error('Adaptive RPC Error:', error);

      let fallbackQuery = supabase
        .from('questions')
        .select(EXAM_QUESTION_SELECT_QUERY)
        .eq('is_active', true)
        .eq('status', 'published')
        .is('deleted_at', null)
        .limit(MAX_QUESTION_CANDIDATES);

      if (subjectId) {
        fallbackQuery = fallbackQuery.eq('subject_id', subjectId);
      }

      const { data: fallbackData, error: fallbackError } = await fallbackQuery;

      if (fallbackError) {
        throw new Error(fallbackError.message);
      }

      // Shuffle the bounded candidate pool before truncating so the arena does
      // not return the same leading rows on every request.
      return shuffleInPlace(sanitizeQuestionsForClient(fallbackData || [])).slice(0, safeLimit);
    }

    return sanitizeQuestionsForClient(data || []);
  }

  /**
   * Legacy write endpoint, retired.
   *
   * It accepted client-supplied score/correctness/pass values and persisted them
   * as authoritative results. Grading now only happens in `submitExamResult`
   * against the server-side answer key, so this route no longer writes anything.
   * Clients must use POST /api/v1/exams/user/submit with a server-issued
   * attempt id. The response is an intentional, documented 410.
   */
  static async submitHistory(userId: string, _payload: SubmitHistoryDTO): Promise<never> {
    if (!userId) throw new ExamAttemptError('Unauthorized', 401);

    throw new ExamAttemptError(
      'This legacy endpoint no longer accepts client-calculated results. Submit through /api/v1/exams/user/submit with a server-issued attempt id.',
      410
    );
  }

  static async submitExamResult(payload: SubmitExamPayload) {
    const { session_id, user_id, attempt_id } = payload;

    if (!user_id) throw new ExamAttemptError('Unauthorized', 401);

    const normalizedExamId = payload.exam_id ? normalizeId(payload.exam_id) : null;
    const answers =
      payload.answers && typeof payload.answers === 'object' && !Array.isArray(payload.answers)
        ? payload.answers
        : {};

    const requestedQuestionIds = buildQuestionIds(payload.question_ids, answers);
    const normalizedAttemptId = normalizeId(attempt_id);
    const submissionKey = normalizeSubmissionKey(session_id);

    // Resolve the authoritative attempt. An exam submission must reuse an
    // attempt the server already started; a server-issued attempt id wins.
    let attempt: AnyObject | null = null;

    try {
      if (normalizedAttemptId) {
        attempt = await ExamAttemptService.getAttempt(user_id, normalizedAttemptId);
        if (!attempt) throw new ExamAttemptError('Attempt not found', 404);
      } else if (normalizedExamId) {
        attempt = await ExamAttemptService.findActiveExamAttempt(user_id, normalizedExamId);
        if (!attempt) {
          throw new ExamAttemptError(
            'An exam attempt must be started before submitting',
            409
          );
        }
      }
    } catch (error) {
      if (isSchemaDriftError(error)) {
        throw new ExamAttemptError(
          'Examination attempt tracking is not available on this deployment',
          503
        );
      }

      throw error;
    }

    // Untracked practice submissions (no exam paper, no attempt) keep feedback
    // grading for compatibility, but never award XP and never reveal keys.
    const untrackedPractice = !attempt;

    const attemptQuestionIds =
      attempt && Array.isArray(attempt.question_ids)
        ? attempt.question_ids.map(normalizeId).filter(Boolean)
        : [];

    const examId = attempt?.exam_id ? normalizeId(attempt.exam_id) : normalizedExamId;

    if (normalizedExamId && examId && normalizedExamId !== examId) {
      throw new ExamAttemptError('Submitted exam does not match the attempt', 400);
    }

    let questionIds: string[];

    if (untrackedPractice) {
      if (normalizedExamId) {
        throw new ExamAttemptError('An exam attempt must be started before submitting', 409);
      }
      if (requestedQuestionIds.length === 0) {
        throw new ExamAttemptError('No questions submitted', 400);
      }

      if (requestedQuestionIds.length > MAX_UNTRACKED_PRACTICE_QUESTIONS) {
        throw new ExamAttemptError(
          `An untracked practice submission may contain at most ${MAX_UNTRACKED_PRACTICE_QUESTIONS} questions`,
          400
        );
      }

      // An untracked submission has no attempt-scoped question set, so it must
      // not be usable to grade (and therefore reveal the key of) questions that
      // belong to an exam paper. This runs before any grading or response.
      const examQuestionIds = await findExamPaperQuestionIds(requestedQuestionIds);

      if (examQuestionIds.length > 0) {
        throw new ExamAttemptError(
          'Exam paper questions cannot be submitted outside a tracked attempt',
          403,
          { blocked_question_ids: examQuestionIds.slice(0, 10) }
        );
      }

      questionIds = requestedQuestionIds;
    } else {
      if (attemptQuestionIds.length === 0) {
        throw new ExamAttemptError('Attempt has no question set', 409);
      }

      // The attempt's frozen question set is authoritative; client ids may only
      // be a subset of it.
      const allowedQuestionIds = new Set(attemptQuestionIds);
      const unauthorizedQuestionIds = requestedQuestionIds.filter(
        (questionId) => !allowedQuestionIds.has(questionId)
      );

      if (unauthorizedQuestionIds.length > 0) {
        throw new ExamAttemptError('Submitted question does not belong to this attempt', 400);
      }

      questionIds = attemptQuestionIds;
    }

    // Atomically claim the attempt before any reward is written. A losing
    // concurrent/duplicate submission returns the existing result and earns no
    // additional XP.
    let historyId: string | null = null;

    if (attempt) {
      historyId = crypto.randomUUID();

      const claim = await ExamAttemptService.claimAttemptForSubmission(
        user_id,
        attempt.id,
        historyId
      );

      if (!claim.claimed) {
        const existing = await ExamAttemptService.findHistoryByAttempt(attempt.id);

        if (existing) {
          return ExamUserService.buildDuplicateSubmissionResponse(user_id, attempt.id, existing.id);
        }

        throw new ExamAttemptError('Attempt already submitted', 409);
      }
    } else if (submissionKey) {
      // Practice submissions are not attempt-bound, so the deterministic
      // primary key is what makes a retry or refresh idempotent.
      historyId = deterministicHistoryId(user_id, submissionKey);
    }

    let defaultNegativeMarks = 0.25;
    let examTotalMarks: number | null = null;
    let resultPublishTime: string | null = null;

    if (examId) {
      const { data: examData, error: examError } = await supabase
        .from('exam_papers')
        .select('id, default_negative_marks, total_marks, result_publish_time, is_published')
        .eq('id', examId)
        .maybeSingle();

      if (examError) {
        if (attempt && historyId) await ExamAttemptService.releaseClaim(attempt.id);
        throw new Error(examError.message);
      }

      if (!examData || examData.is_published !== true) {
        if (attempt && historyId) await ExamAttemptService.releaseClaim(attempt.id);
        throw new ExamAttemptError(
          examData ? 'Exam is not available' : 'Exam not found',
          examData ? 403 : 404
        );
      }

      defaultNegativeMarks = Number(examData.default_negative_marks ?? 0.25);
      examTotalMarks = Number(examData.total_marks ?? 0);
      resultPublishTime = examData.result_publish_time ?? null;
    }

    const { data: questions, error: questionsError } = await supabase
      .from('questions')
      .select(EXAM_REVIEW_QUESTION_SELECT_QUERY)
      .in('id', questionIds)
      .eq('is_active', true)
      .eq('status', 'published')
      .is('deleted_at', null);

    if (questionsError) {
      if (attempt && historyId) await ExamAttemptService.releaseClaim(attempt.id);
      throw new Error(questionsError.message);
    }

    const questionMap = new Map<string, AnyObject>();
    (questions || []).forEach((q: AnyObject) => {
      questionMap.set(normalizeId(q.id), q);
    });

    // A submission without an exam paper is a practice/arena result, whether or
    // not it was bound to a server-side attempt. There is no scheduled exam key
    // to protect, and the untracked path already refuses exam-paper questions.
    const isPracticeAttempt =
      examId === null || Boolean(attempt?.practice_mode);
    const includeCorrectAnswers =
      isPracticeAttempt || isAnswerDisclosureAllowed(examId, resultPublishTime);

    // For normal exams, questions without a submitted answer never reveal their
    // correct option, even when review is permitted. A practice result is owned
    // by the student and may reveal every question in that attempt.
    const answeredQuestionIds = new Set(
      questionIds.filter((questionId) => !isEmptyAnswer(answers[questionId]))
    );
    const revealKeys =
      includeCorrectAnswers && (isPracticeAttempt || answeredQuestionIds.size > 0);

    let correct = 0;
    let wrong = 0;
    let skipped = 0;
    let totalScore = 0;

    const details = questionIds.map((questionId) => {
      const q = questionMap.get(questionId);
      const selectedOptionId = answers[questionId];
      const selectedId = isEmptyAnswer(selectedOptionId) ? null : normalizeOptionId(selectedOptionId);

      if (!q) {
        skipped++;
        return sanitizeDetailForClient(
          {
            question_id: questionId,
            selected_option: selectedId,
            selected_option_text: null,
            is_correct: null,
            marks_awarded: 0,
            status: 'question_not_found',
          },
          undefined,
          false
        );
      }

      const optionsArray: AnyObject[] = Array.isArray(q.options) ? q.options : [];
      const selectedOption = findOptionById(optionsArray, selectedId);

      if (!selectedId) {
        skipped++;
        return sanitizeDetailForClient(
          {
            question_id: questionId,
            selected_option: null,
            selected_option_text: null,
            is_correct: null,
            marks_awarded: 0,
            status: 'skipped',
          },
          q,
          revealKeys && isPracticeAttempt
        );
      }

      const isCorrect = isAnswerCorrect(optionsArray, selectedId);

      if (isCorrect) {
        correct++;
        totalScore += 1;
      } else {
        wrong++;
        totalScore -= defaultNegativeMarks;
      }

      return sanitizeDetailForClient(
        {
          question_id: questionId,
          selected_option: selectedId,
          selected_option_text: optionDisplayText(selectedOption),
          is_correct: isCorrect,
          marks_awarded: isCorrect ? 1 : -defaultNegativeMarks,
          status: isCorrect ? 'correct' : 'wrong',
        },
        q,
        revealKeys
      );
    });

    const questionSnapshots = questionIds
      .map((questionId) => ({ questionId, question: questionMap.get(questionId) }))
      .filter((entry): entry is { questionId: string; question: AnyObject } =>
        Boolean(entry.question)
      )
      .map(({ questionId, question }) =>
        buildQuestionSnapshot(
          question,
          revealKeys && (isPracticeAttempt || answeredQuestionIds.has(questionId))
        )
      );

    const sanitizedAnswers = sanitizeAnswerMap(
      answers as Record<string, unknown>,
      new Set(questionIds)
    );

    const totalQuestions = questionIds.length;
    const finalScore = Math.max(0, Number(totalScore.toFixed(2)));

    const detailsJson = buildStudentFacingDetailsJson(
      { session_id: session_id || null },
      {
        answers: sanitizedAnswers,
        details,
        questions: questionSnapshots,
        includeCorrectAnswers: revealKeys,
      }
    );

    // Timing is derived from the persisted attempt when there is one. Practice
    // submissions have no server-side start, so the reported duration is used
    // but clamped to a sane range.
    const nowMs = Date.now();
    const startedAtMs = attempt?.started_at ? Date.parse(String(attempt.started_at)) : NaN;
    const timeTakenSeconds = Number.isFinite(startedAtMs)
      ? clampTimeTaken((nowMs - startedAtMs) / 1000)
      : clampTimeTaken(payload.time_taken);

    const submittedAt = new Date(nowMs).toISOString();
    const resultPayload: AnyObject = {
      exam_id: examId,
      user_id,
      score: finalScore,
      total_marks: examTotalMarks || totalQuestions,
      correct_count: correct,
      wrong_count: wrong,
      skipped_count: skipped,
      time_taken: timeTakenSeconds,
      details_json: detailsJson,
      submitted_at: submittedAt,
    };

    // Only write attempt_id when an attempt actually exists. Writing an
    // explicit null requires the column to exist, which would make every
    // submission fail on a database that has not applied the attempt
    // lifecycle migration. Omitting the key is equivalent for legacy rows,
    // whose attempt_id is null anyway.
    if (attempt) resultPayload.attempt_id = attempt.id;

    // Practice attempts carry provenance so history can label the result and
    // offer the same mode again. These columns only exist once the practice
    // mode migration is applied; normal exam/legacy submissions omit them.
    if (attempt?.practice_mode) resultPayload.practice_mode = attempt.practice_mode;
    if (attempt?.source_history_id) {
      resultPayload.source_history_id = attempt.source_history_id;
    }

    // The history row id is fixed at claim time (attempts) or derived from the
    // submission key (practice) so a duplicate can only observe one record.
    if (historyId) resultPayload.id = historyId;

    const { data: result, error: submitError } = await supabase
      .from('exam_history')
      .insert([resultPayload])
      .select()
      .single();

    if (submitError) {
      // A duplicate submission (concurrent request, retry, or a response lost
      // after the row was written) collides with an existing unique key. Return
      // that authoritative result instead of creating a second one.
      if ((submitError as AnyObject).code === '23505') {
        const existing = attempt
          ? await ExamAttemptService.findHistoryByAttempt(attempt.id)
          : historyId
            ? (
                await supabase
                  .from('exam_history')
                  .select('id, user_id')
                  .eq('id', historyId)
                  .eq('user_id', user_id)
                  .maybeSingle()
              ).data
            : null;

        if (existing?.id) {
          return ExamUserService.buildDuplicateSubmissionResponse(
            user_id,
            attempt?.id ?? null,
            normalizeId(existing.id)
          );
        }
      }

      if (attempt) await ExamAttemptService.releaseClaim(attempt.id);

      if (isSchemaDriftError(submitError)) {
        throw new ExamAttemptError(
          'Examination storage is not provisioned on this deployment',
          503
        );
      }

      throw new Error(submitError.message);
    }

    if (!result?.id) {
      if (attempt) await ExamAttemptService.releaseClaim(attempt.id);
      throw new Error('Failed to persist exam result');
    }

    const detailRows = details
      .filter((item) => item.status !== 'question_not_found')
      .map((item) => ({
        exam_history_id: result.id,
        question_id: item.question_id,
        selected_option: item.selected_option,
        is_correct: item.is_correct,
        marks_awarded: item.marks_awarded,
        created_at: new Date().toISOString(),
      }));

    // XP is computed on the trustworthy side from authoritative grading and is
    // only awarded for a tracked *exam* attempt this request atomically
    // claimed. Practice attempts, untracked submissions, duplicates and empty
    // submissions earn nothing (an empty submission must not collect the base
    // XP award).
    const answeredCount = answeredQuestionIds.size;
    const xpEligible =
      Boolean(attempt) &&
      attempt?.kind === 'exam' &&
      !attempt?.practice_mode &&
      answeredCount > 0;

    // The detail snapshot and the XP rules lookup are independent, so overlap
    // them instead of paying for two serial round trips.
    const [detailsResult, earnedXP] = await Promise.all([
      detailRows.length > 0
        ? supabase.from('exam_history_details').insert(detailRows)
        : Promise.resolve({ error: null }),
      xpEligible ? calculateExamXP(correct, totalQuestions) : Promise.resolve(0),
    ]);

    if (detailsResult.error) {
      console.error('Exam history details insert error:', detailsResult.error);
    }
    let xpAwarded = false;

    if (earnedXP > 0) {
      const { error: progressError } = await supabase.rpc('update_user_progress', {
        p_user_id: user_id,
        p_coins: 0,
        p_xp: earnedXP,
      });

      if (progressError) {
        // The attempt is already claimed and its single history row exists, so
        // a retry still cannot re-award XP. Log for operator follow-up.
        console.error('Update user progress error:', progressError);
      } else {
        xpAwarded = true;
      }
    }

    if (attempt) {
      // Record only XP that was actually persisted, so the audit column never
      // claims a reward the user did not receive.
      await ExamAttemptService.finalizeAttempt(attempt.id, historyId, xpAwarded ? earnedXP : 0);
    }

    // Explicit response DTO: never spread the database row (which may contain
    // grading-only fields in future schema versions).
    return {
      id: result.id,
      attempt_id: attempt?.id ?? null,
      exam_id: result.exam_id ?? examId,
      user_id: result.user_id ?? user_id,
      score: Number(result.score ?? finalScore),
      total_marks: Number(result.total_marks ?? (examTotalMarks || totalQuestions)),
      correct_count: Number(result.correct_count ?? correct),
      wrong_count: Number(result.wrong_count ?? wrong),
      skipped_count: Number(result.skipped_count ?? skipped),
      time_taken: Number(result.time_taken ?? timeTakenSeconds),
      submitted_at: result.submitted_at ?? submittedAt,
      created_at: result.created_at ?? null,
      practice_mode: attempt?.practice_mode ?? null,
      source_history_id: attempt?.source_history_id ?? null,
      details_json: detailsJson,
      earned_xp: earnedXP > 0 && xpAwarded ? earnedXP : 0,
      duplicate: false,
      computed_result: {
        score: finalScore,
        total_questions: totalQuestions,
        correct_count: correct,
        wrong_count: wrong,
        skipped_count: skipped,
      },
    };
  }

  /**
   * Response for a repeated submission of an attempt that was already claimed.
   * It returns the existing result without re-grading, re-writing or re-awarding
   * XP, so retries and concurrent duplicates are idempotent.
   */
  static async buildDuplicateSubmissionResponse(
    userId: string,
    attemptId: string | null,
    historyId: string
  ) {
    // Reuse the owner-scoped result reader: it applies the same sanitisation
    // and answer-disclosure rules as a first submission, so the returning
    // student sees the authoritative review data rather than an empty page.
    const existing = await ExamUserService.getExamResult(userId, historyId);

    if (existing) {
      return {
        ...existing,
        attempt_id: attemptId,
        earned_xp: 0,
        duplicate: true,
        message: 'This attempt has already been submitted',
      };
    }

    // Defensive fallback: the row is visible as a unique conflict but is not
    // readable for this user (or was deleted concurrently). Never invent a new
    // result row for it.
    return {
      id: historyId,
      attempt_id: attemptId,
      exam_id: null,
      user_id: userId,
      score: 0,
      total_marks: 0,
      correct_count: 0,
      wrong_count: 0,
      skipped_count: 0,
      time_taken: 0,
      submitted_at: null,
      created_at: null,
      practice_mode: null,
      source_history_id: null,
      details_json: null,
      earned_xp: 0,
      duplicate: true,
      message: 'This attempt has already been submitted',
    };
  }

  /**
   * Returns the protected question content for an in-progress attempt.
   *
   * This is a security-sensitive read: an expired, submitted or finalized
   * attempt never receives exam content, and the answer key is never included.
   */
  static async getAttemptQuestions(userId: string, attemptId: string) {
    if (!userId) throw new ExamAttemptError('Unauthorized', 401);

    const attempt = await ExamAttemptService.getAttempt(userId, attemptId);

    if (!attempt) throw new ExamAttemptError('Attempt not found', 404);

    if (
      attempt.status !== ATTEMPT_STATUS.IN_PROGRESS ||
      isAttemptExpiredForAttempt(attempt)
    ) {
      if (attempt.status === ATTEMPT_STATUS.IN_PROGRESS) {
        await ExamAttemptService.expireAttempt(attempt.id);
      }

      throw new ExamAttemptError('Exam attempt is no longer active', 409);
    }

    const questionIds = Array.isArray(attempt.question_ids)
      ? attempt.question_ids.map(normalizeId).filter(Boolean)
      : [];

    if (questionIds.length === 0) {
      throw new ExamAttemptError('Attempt has no question set', 409);
    }

    const { data, error } = await supabase
      .from('questions')
      .select(EXAM_QUESTION_SELECT_QUERY)
      .in('id', questionIds)
      .eq('is_active', true)
      .eq('status', 'published')
      .is('deleted_at', null);

    if (error) throw new Error(error.message);

    const byId = new Map<string, AnyObject>();
    (data || []).forEach((question: AnyObject) => byId.set(normalizeId(question.id), question));

    // Preserve the frozen attempt order and drop anything that is no longer
    // available rather than leaking an unpublished question.
    const ordered = questionIds
      .map((questionId) => byId.get(questionId))
      .filter((question): question is AnyObject => Boolean(question));

    return {
      attempt_id: attempt.id,
      exam_id: attempt.exam_id ?? null,
      started_at: attempt.started_at ?? null,
      deadline_at: attempt.deadline_at ?? null,
      server_time: new Date().toISOString(),
      questions: sanitizeQuestionsForClient(ordered),
    };
  }

  /**
   * Returns a single submitted attempt for the authenticated owner.
   * Attempts submitted after the secure grading migration already carry the
   * question snapshot; older attempts are resolved from exam_history_details
   * and the current questions table so their review page keeps working.
   */
  static async getExamResult(userId: string, historyId: string) {
    if (!userId) throw new Error('Unauthorized');

    const normalizedHistoryId = normalizeId(historyId);

    if (!normalizedHistoryId) throw new ExamAttemptError('Result id is required', 400);

    const { data: record, error } = await supabase
      .from('exam_history')
      .select('*')
      .eq('id', normalizedHistoryId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!record) return null;

    const detailsJson = parseDetailsJson(record.details_json);
    const storedQuestions: AnyObject[] = Array.isArray(detailsJson.questions)
      ? detailsJson.questions
      : [];
    const storedDetails: AnyObject[] = Array.isArray(detailsJson.details)
      ? detailsJson.details
      : [];

    const storedAnswers =
      detailsJson.answers &&
      typeof detailsJson.answers === 'object' &&
      !Array.isArray(detailsJson.answers)
        ? detailsJson.answers
        : detailsJson.userAnswers &&
            typeof detailsJson.userAnswers === 'object' &&
            !Array.isArray(detailsJson.userAnswers)
          ? detailsJson.userAnswers
          : {};

    const examId = record.exam_id ? normalizeId(record.exam_id) : null;

    // Both lookups depend only on examId, so fetch them concurrently.
    const [resultPublishTime, authorizedIds] = await Promise.all([
      loadResultPublishTime(examId),
      examId ? loadExamQuestionIds(examId) : Promise.resolve<string[] | null>(null),
    ]);

    // Legacy/current arena submissions have no exam paper and therefore no
    // scheduled result release. They are practice results owned by this user and
    // must be reviewable even when the row predates attempt tracking.
    const isPracticeResult = examId === null || Boolean(record.practice_mode);
    const includeCorrectAnswers =
      isPracticeResult || isAnswerDisclosureAllowed(examId, resultPublishTime);

    // Legacy attempts may have been written through the trust-based history
    // endpoint, so their stored question ids are untrusted. When an exam is set,
    // only questions in that exam's authoritative question set are reviewable.
    const authorizedQuestionIds = authorizedIds ? new Set(authorizedIds) : null;

    const storedQuestionIds = (
      storedQuestions.length > 0
        ? storedQuestions.map((question) => question?.id)
        : storedDetails.map((detail) => detail?.question_id)
    )
      .map(normalizeId)
      .filter(Boolean);

    const questionIds = authorizedQuestionIds
      ? storedQuestionIds.filter((questionId) => authorizedQuestionIds.has(questionId))
      : storedQuestionIds;

    const reviewableDetails = authorizedQuestionIds
      ? storedDetails.filter((detail) =>
          authorizedQuestionIds.has(normalizeId(detail?.question_id))
        )
      : storedDetails;

    const answeredQuestionIds = new Set(
      Object.entries(storedAnswers as Record<string, unknown>)
        .filter(([, value]) => !isEmptyAnswer(value))
        .map(([questionId]) => normalizeId(questionId))
        .filter((questionId) => questionIds.includes(questionId))
    );
    const revealKeys = includeCorrectAnswers && (isPracticeResult || answeredQuestionIds.size > 0);

    const questionMap =
      questionIds.length > 0
        ? await loadQuestionSnapshotMap(questionIds)
        : new Map<string, AnyObject>();

    const storedQuestionMap = new Map<string, AnyObject>();
    storedQuestions.forEach((question) => {
      storedQuestionMap.set(normalizeId(question?.id), question);
    });

    const questions: AnyObject[] = questionIds
      .map((questionId): AnyObject | null => {
        const revealForQuestion =
          revealKeys && (isPracticeResult || answeredQuestionIds.has(questionId));
        const currentQuestion = questionMap.get(questionId);

        if (currentQuestion) {
          return buildQuestionSnapshot(currentQuestion, revealForQuestion);
        }

        const storedQuestion = storedQuestionMap.get(questionId);

        return storedQuestion
          ? sanitizeStoredQuestionSnapshot(storedQuestion, revealForQuestion)
          : null;
      })
      .filter((question): question is AnyObject => question !== null);

    const details = reviewableDetails.map((detail) =>
      sanitizeDetailForClient(
        detail,
        questionMap.get(normalizeId(detail?.question_id)),
        revealKeys && (isPracticeResult || !isEmptyAnswer(detail?.selected_option))
      )
    );

    const answers = sanitizeAnswerMap(
      storedAnswers as Record<string, unknown>,
      new Set(questionIds)
    );

    return {
      id: record.id,
      exam_id: record.exam_id ?? null,
      user_id: record.user_id ?? null,
      score: Number(record.score ?? 0),
      total_marks: Number(record.total_marks ?? 0),
      correct_count: Number(record.correct_count ?? 0),
      wrong_count: Number(record.wrong_count ?? 0),
      skipped_count: Number(record.skipped_count ?? 0),
      time_taken: Number(record.time_taken ?? 0),
      submitted_at: record.submitted_at ?? null,
      created_at: record.created_at ?? null,
      status: record.status ?? null,
      practice_mode: record.practice_mode ?? null,
      source_history_id: record.source_history_id ?? null,
      details_json: buildStudentFacingDetailsJson(detailsJson, {
        answers,
        details,
        questions,
        includeCorrectAnswers: revealKeys,
        bookmarkedIds: detailsJson.bookmarked_ids,
      }),
    };
  }

  /**
   * Creates a group battle between two students.
   *
   * The battle is authored server-side: the challenger is taken from the
   * verified token, the opponent must exist and differ from the challenger,
   * both participants must share the group when a group is in scope, and the
   * question set is selected from published, non-premium questions. Exam
   * papers, their question rows and the battle row are written with the
   * service-role client; browsers cannot write them directly.
   *
   * Supabase offers no client-side transaction here, so the steps use explicit
   * compensation: if the battle row cannot be written, the paper and its
   * question rows are deleted again. A crash between the final write and the
   * response can therefore leave a published paper without a battle; such a
   * paper is inert (no student is enrolled in it) and is reported as a known
   * limitation rather than claimed as atomic.
   */
  static async createGroupBattleExam(
    challengerId: string,
    opponentId: string,
    request: GroupBattleRequest = {}
  ) {
    if (!challengerId) throw new ExamAttemptError('Unauthorized', 401);

    const normalizedOpponentId = normalizeId(opponentId);

    if (!normalizedOpponentId) {
      throw new ExamAttemptError('অপোনেন্টের আইডি প্রয়োজন!', 400);
    }

    if (challengerId === normalizedOpponentId) {
      throw new ExamAttemptError('আপনি নিজেকে নিজে চ্যালেঞ্জ দিতে পারবেন না!', 400);
    }

    const [challenger, opponent] = await Promise.all([
      loadBattleParticipant(challengerId),
      loadBattleParticipant(normalizedOpponentId),
    ]);

    if (!opponent) {
      throw new ExamAttemptError('Opponent not found', 404);
    }

    const requestedGroupId = normalizeId(request?.group_id);
    // A battle may be scoped to the challenger's current group implicitly; in
    // that case membership is already established by the profile itself. When
    // the client names a group explicitly, both participants must belong to it.
    const groupId = requestedGroupId || normalizeId(challenger?.current_group_id);

    if (requestedGroupId) {
      await assertSharedGroupMembership(requestedGroupId, challengerId, normalizedOpponentId);
    }

    const requestedQuestionCount = clampQuestionLimit(
      request?.question_count ?? request?.limit,
      10
    );

    const requestedExamId = normalizeId(request?.exam_id ?? request?.id);
    const createdPaperByBattle = !requestedExamId;
    let examId = requestedExamId;
    let questionIds: string[] = [];

    if (requestedExamId) {
      // Existing paper: it must be published and every question in it must
      // still satisfy the publication and premium rules.
      const { data: exam, error: examError } = await supabase
        .from('exam_papers')
        .select('id, is_published, is_premium, category')
        .eq('id', requestedExamId)
        .maybeSingle();

      if (examError) throw new Error(examError.message);
      if (!exam || exam.is_published !== true) {
        throw new ExamAttemptError('Exam is not available', 403);
      }

      questionIds = await loadExamQuestionIds(requestedExamId);

      if (questionIds.length === 0) {
        throw new ExamAttemptError('Exam question set is not configured', 400);
      }
    } else {
      const subjectId = normalizeId(request?.subject_id);

      if (!subjectId) {
        throw new ExamAttemptError('Subject is required to create a battle', 400);
      }

      questionIds = await selectGroupBattleQuestionIds({
        subjectId,
        chapterId: normalizeId(request?.chapter_id) || null,
        count: requestedQuestionCount,
        userId: challengerId,
      });

      if (questionIds.length < requestedQuestionCount) {
        throw new ExamAttemptError(
          'Not enough published non-premium questions for this selection',
          400,
          { requested: requestedQuestionCount, available: questionIds.length }
        );
      }

      const now = Date.now();
      const windowEnd = now + 24 * 60 * 60 * 1000;
      const paperId = crypto.randomUUID();
      const paperTitle =
        normalizeId(request?.title) ||
        `Group battle: ${challenger?.full_name || 'Challenger'} vs ${opponent.full_name || 'Opponent'}`;

      const { error: paperError } = await supabase.from('exam_papers').insert([
        {
          id: paperId,
          title: paperTitle,
          subject_id: subjectId,
          category: 'group_battle',
          is_premium: false,
          is_published: true,
          total_marks: questionIds.length,
          pass_mark: 0,
          duration_min: 15,
          default_negative_marks: 0,
          start_time: toIso(now),
          end_time: toIso(windowEnd),
        },
      ]);

      if (paperError) throw new Error(paperError.message);

      examId = paperId;

      const { error: questionsError } = await supabase.from('exam_paper_questions').insert(
        questionIds.map((questionId, index) => ({
          exam_id: paperId,
          question_id: questionId,
          sequence: index + 1,
          marks: 1,
        }))
      );

      if (questionsError) {
        // Compensating cleanup: never leave a half-built paper behind.
        await supabase.from('exam_papers').delete().eq('id', paperId);
        throw new Error(questionsError.message);
      }
    }

    const now = Date.now();

    const { data: battle, error: battleError } = await supabase
      .from('group_battles')
      .insert({
        exam_id: examId,
        group_id: groupId || null,
        initiated_by: challengerId,
        status: 'pending',
        scores_snapshot: {
          [challengerId]: 0,
          [normalizedOpponentId]: 0,
        },
        start_time: toIso(now),
        end_time: toIso(now + 24 * 60 * 60 * 1000),
      })
      .select()
      .single();

    if (battleError) {
      if (createdPaperByBattle && examId) {
        await supabase.from('exam_paper_questions').delete().eq('exam_id', examId);
        await supabase.from('exam_papers').delete().eq('id', examId);
      }

      throw new Error(battleError.message);
    }

    return {
      ...battle,
      exam_id: examId,
      opponent_id: normalizedOpponentId,
      question_count: questionIds.length,
      expires_at: battle?.end_time ?? toIso(now + 24 * 60 * 60 * 1000),
    };
  }
}
