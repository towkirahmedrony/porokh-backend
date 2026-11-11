import { randomUUID } from 'crypto';
import { supabase } from '../../config/supabase';
import { createUserSupabaseClient } from '../../config/userSupabase';
import logger from '../../lib/utils/logger';
import { AutoFetchDTO, PunishUserDTO } from './exams.types';
import { ATTEMPT_STATUS, MINUTE_MS } from './exam.timing';
import {
  MAX_OVERVIEW_PAPERS,
  deriveExamStatus,
  type DerivedExamStatus,
  type ExamAdminListQuery,
  type ExamStatusInput,
} from './exams.admin.query';
import {
  ADMISSION_EXAM_MODES,
  EXAM_AUTHORING_CATEGORIES,
  MODEL_TEST_TRACKS,
  ExamAuthoringError,
  assertValidAdmissionState,
  assertValidExamSubject,
  assertValidExamTrack,
  assertValidExamWindow,
  parseExamCreatePayload,
  parseExamUpdatePayload,
  type AdmissionExamMode,
  type ExamAuthoringFields,
  type ExamAuthoringPatch,
} from './exam.authoring';

type AnyObject = Record<string, any>;

const RECOVER_MIN_MINUTES = 1;
const RECOVER_MAX_MINUTES = 60;

/** Columns the admin list and overview read. Kept lean so a page stays small. */
const PAPER_LIST_COLUMNS = [
  'id',
  'title',
  'title_en',
  'category',
  'track',
  'subject_id',
  'exam_type',
  'duration_min',
  'total_marks',
  'pass_mark',
  'is_published',
  'is_premium',
  'start_time',
  'end_time',
  'result_publish_time',
  'admission_unit_id',
  'meta_data',
  'created_at',
  'updated_at',
].join(', ');

/** Bounded reads used to enrich one list page without an N+1 query. */
const MAX_PAGE_QUESTION_ROWS = 5000;
const MAX_PAGE_RESULT_ROWS = 10000;
const MAX_OVERVIEW_QUESTION_ROWS = 20000;
const MAX_OVERVIEW_ATTEMPT_ROWS = 5000;

const countByExamId = (rows: AnyObject[] | null, key = 'exam_id'): Map<string, number> => {
  const counts = new Map<string, number>();

  for (const row of rows ?? []) {
    const examId = String(row?.[key] ?? '');

    if (!examId) continue;

    counts.set(examId, (counts.get(examId) ?? 0) + 1);
  }

  return counts;
};

const VERIFICATION_STAGES = ['answer', 'translation', 'final'] as const;
type VerificationStage = (typeof VERIFICATION_STAGES)[number];
type VerificationStageSummary = { verified: number; rejected: number; pending: number };
type ExamVerificationSummary = {
  completed_questions: number;
  verified_stages: number;
  total_stages: number;
  all_verified: boolean;
  answer: VerificationStageSummary;
  translation: VerificationStageSummary;
  final: VerificationStageSummary;
};

const emptyVerificationStage = (): VerificationStageSummary => ({ verified: 0, rejected: 0, pending: 0 });

const emptyVerificationSummary = (): ExamVerificationSummary => ({
  completed_questions: 0,
  verified_stages: 0,
  total_stages: 0,
  all_verified: false,
  answer: emptyVerificationStage(),
  translation: emptyVerificationStage(),
  final: emptyVerificationStage(),
});

const buildVerificationSummaries = async (
  links: AnyObject[]
): Promise<Map<string, ExamVerificationSummary>> => {
  const summaries = new Map<string, ExamVerificationSummary>();
  const questionIds = [...new Set(links.map((link) => String(link.question_id)).filter(Boolean))];
  if (questionIds.length === 0) return summaries;

  const [{ data: questions, error: questionsError }, { data: rows, error: rowsError }] = await Promise.all([
    supabase.from('questions').select('id, revision, content_fingerprint').in('id', questionIds),
    supabase
      .from('question_verifications')
      .select('question_id, stage, status, question_revision, content_fingerprint')
      .in('question_id', questionIds),
  ]);
  if (questionsError) throw new Error(questionsError.message);
  if (rowsError) throw new Error(rowsError.message);

  const currentQuestions = new Map(
    (questions ?? []).map((question: AnyObject) => [String(question.id), question])
  );
  const currentByQuestion = new Map<string, Map<string, string>>();
  (rows ?? []).forEach((row: AnyObject) => {
    const question = currentQuestions.get(String(row.question_id));
    if (!question) return;
    if (
      Number(row.question_revision) !== Number(question.revision) ||
      String(row.content_fingerprint) !== String(question.content_fingerprint)
    ) return;
    if (!VERIFICATION_STAGES.includes(row.stage as VerificationStage)) return;
    const stageMap = currentByQuestion.get(String(row.question_id)) ?? new Map<string, string>();
    stageMap.set(String(row.stage), String(row.status));
    currentByQuestion.set(String(row.question_id), stageMap);
  });

  const linksByExam = new Map<string, Set<string>>();
  links.forEach((link) => {
    const examQuestions = linksByExam.get(String(link.exam_id)) ?? new Set<string>();
    examQuestions.add(String(link.question_id));
    linksByExam.set(String(link.exam_id), examQuestions);
  });

  linksByExam.forEach((questionSet, examId) => {
    const summary: ExamVerificationSummary = {
      ...emptyVerificationSummary(),
      total_stages: questionSet.size * VERIFICATION_STAGES.length,
      all_verified: questionSet.size > 0,
    };
    questionSet.forEach((questionId) => {
      const stageMap = currentByQuestion.get(questionId) ?? new Map<string, string>();
      let complete = true;
      VERIFICATION_STAGES.forEach((stage) => {
        const status = stageMap.get(stage) ?? 'pending';
        if (status === 'verified') {
          summary[stage].verified += 1;
          summary.verified_stages += 1;
        } else if (status === 'rejected') {
          summary[stage].rejected += 1;
          complete = false;
        } else {
          summary[stage].pending += 1;
          complete = false;
        }
      });
      if (complete) summary.completed_questions += 1;
    });
    summary.all_verified = questionSet.size > 0 && summary.completed_questions === questionSet.size;
    summaries.set(examId, summary);
  });
  return summaries;
};

const auditExamAction = async (actorId: string | undefined, action: string, examId: string) => {
  const { error } = await supabase.from('audit_logs').insert({
    user_id: actorId ?? null,
    action,
    target_table: 'exam_papers',
    target_id: examId,
    details: {},
  });
  if (error) logger.error('[security-audit] exam event could not be recorded');
};

/** Admin-facing error carrying the HTTP status the handler should return. */
class ExamAdminError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ExamAdminError';
    this.status = status;
  }
}

const secondsRemaining = (deadlineAt: unknown, nowMs = Date.now()): number | null => {
  if (!deadlineAt) return null;

  const deadline = Date.parse(String(deadlineAt));

  if (Number.isNaN(deadline)) return null;

  return Math.max(0, Math.ceil((deadline - nowMs) / 1000));
};

/**
 * Server-managed paper columns. These are derived here and never accepted from
 * the browser (the authoring parser rejects them as unsupported fields).
 */
const PAPER_AUTHORED_COLUMNS = [
  'title',
  'title_en',
  'subject_id',
  'category',
  'track',
  'exam_type',
  'duration_min',
  'start_time',
  'end_time',
  'result_publish_time',
  'instructions',
  'instructions_en',
  'syllabus_details',
  'syllabus_details_en',
  'pass_mark',
  'default_negative_marks',
  'show_leaderboard',
  'is_premium',
  'admission_unit_id',
] as const;

/**
 * Questions are eligible for a paper only when a student could actually answer
 * and have them graded: active, not deleted, and published (the submission path
 * filters on `status = 'published'`, so anything else would be ungradeable).
 */
const requireEligibleQuestions = async (
  questionIds: string[],
  { subjectId }: { subjectId?: string | null } = {}
): Promise<string[]> => {
  const { data, error } = await supabase
    .from('questions')
    .select('id, status, is_active, deleted_at, subject_id')
    .in('id', questionIds);

  if (error) throw new Error(error.message);

  const byId = new Map<string, AnyObject>();
  (data || []).forEach((row: AnyObject) => byId.set(String(row.id), row));

  const missing = questionIds.filter((questionId) => !byId.has(questionId));
  const ineligible = questionIds.filter((questionId) => {
    const row = byId.get(questionId);

    if (!row) return false;

    return !(row.is_active === true && row.status === 'published' && (row.deleted_at ?? null) === null);
  });

  const incompatibleSubject = subjectId
    ? questionIds.filter((questionId) => {
        const row = byId.get(questionId);

        return row ? String(row.subject_id ?? '') !== subjectId : false;
      })
    : [];

  if (missing.length > 0 || ineligible.length > 0 || incompatibleSubject.length > 0) {
    throw new ExamAuthoringError(
      incompatibleSubject.length > 0
        ? 'Every question must belong to the selected subject'
        : 'One or more questions are not available for an exam',
      400,
      'VALIDATION_FAILED',
      {
        missing_question_ids: missing.slice(0, 25),
        ineligible_question_ids: ineligible.slice(0, 25),
        incompatible_subject_question_ids: incompatibleSubject.slice(0, 25),
      }
    );
  }

  return questionIds;
};

const assertSubjectExists = async (subjectId: string): Promise<void> => {
  const { data, error } = await supabase
    .from('subjects')
    .select('id')
    .eq('id', subjectId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new ExamAuthoringError('Subject not found');
};

/**
 * Resolves an admission unit and verifies its institution is a university.
 * When the wizard also sends the selected university, the unit must belong to
 * it. The university is deliberately not persisted: the unit owns that
 * relationship in the database.
 */
const assertAdmissionUnit = async (
  unitId: string,
  universityId?: string | null
): Promise<{ unitId: string; universityId: string }> => {
  const { data: unit, error } = await supabase
    .from('admission_units')
    .select('id, institution_id')
    .eq('id', unitId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (!unit) {
    throw new ExamAuthoringError(
      'Admission unit not found',
      400,
      'ADMISSION_UNIT_NOT_FOUND'
    );
  }

  const unitUniversityId = String(unit.institution_id ?? '');

  if (universityId && unitUniversityId !== universityId) {
    throw new ExamAuthoringError(
      'The selected unit does not belong to the selected university',
      400,
      'ADMISSION_UNIT_MISMATCH'
    );
  }

  const { data: institution, error: institutionError } = await supabase
    .from('institutions')
    .select('id, type')
    .eq('id', unitUniversityId)
    .maybeSingle();

  if (institutionError) throw new Error(institutionError.message);

  if (!institution || institution.type !== 'university') {
    throw new ExamAuthoringError(
      'The selected admission unit is not attached to a university',
      400,
      'ADMISSION_UNIT_INVALID_UNIVERSITY'
    );
  }

  return { unitId, universityId: unitUniversityId };
};

const readMetadataObject = (value: unknown): AnyObject =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as AnyObject) }
    : {};

const readMetadataString = (value: unknown, key: string): string | null => {
  const metadata = readMetadataObject(value);
  const raw = metadata[key];

  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
};

const readMetadataExamMode = (value: unknown): AdmissionExamMode | null => {
  const mode = readMetadataString(value, 'exam_mode');

  return mode && (ADMISSION_EXAM_MODES as readonly string[]).includes(mode)
    ? (mode as AdmissionExamMode)
    : null;
};

/**
 * Merges canonical admission keys into existing metadata. Legacy keys used by
 * the student adapter are preserved untouched.
 */
const buildAdmissionMetadata = (
  existing: unknown,
  category: string,
  mode: AdmissionExamMode | null,
  session: string | null
): AnyObject | null => {
  const metadata = readMetadataObject(existing);

  if (category === 'admission') {
    if (mode) metadata.exam_mode = mode;
    else delete metadata.exam_mode;

    if (session) metadata.admission_session = session;
    else delete metadata.admission_session;

    return metadata;
  }

  // Leaving admission must not leave a stale unit relationship behind, but all
  // unrelated/legacy metadata keys stay intact.
  delete metadata.exam_mode;
  delete metadata.admission_session;

  return Object.keys(metadata).length > 0 ? metadata : null;
};

const marksForQuestions = (
  questionIds: string[],
  questionMarks: Record<string, number> | null | undefined
): number[] => questionIds.map((questionId) => questionMarks?.[questionId] ?? 1);

const totalForMarks = (marks: number[]): number =>
  marks.reduce((total, mark) => total + mark, 0);

const countExamQuestions = async (examId: string): Promise<number> => {
  const { count, error } = await supabase
    .from('exam_paper_questions')
    .select('id', { count: 'exact', head: true })
    .eq('exam_id', examId);

  if (error) throw new Error(error.message);

  return count ?? 0;
};

/**
 * True when at least one student has started or completed this paper. The
 * admin UI uses this only to warn before replacing a question set; it never
 * blocks the edit.
 */
const examHasAttempts = async (examId: string): Promise<boolean> => {
  const { count: attemptCount, error: attemptError } = await supabase
    .from('exam_progress')
    .select('id', { count: 'exact', head: true })
    .eq('exam_id', examId);

  if (attemptError) throw new Error(attemptError.message);
  if ((attemptCount ?? 0) > 0) return true;

  const { count: historyCount, error: historyError } = await supabase
    .from('exam_history')
    .select('id', { count: 'exact', head: true })
    .eq('exam_id', examId);

  if (historyError) throw new Error(historyError.message);

  return (historyCount ?? 0) > 0;
};

export class ExamAdminService {
  /**
   * Adds the derived status and the operational counters one list page needs.
   *
   * Counters are read for the page's ids only, so the query count stays
   * constant while the catalog grows. A page that hits a read cap reports the
   * truncation instead of quietly showing a smaller number.
   */
  private static async decoratePapers(
    papers: AnyObject[],
    nowMs: number = Date.now()
  ): Promise<{ items: AnyObject[]; truncated: string[] }> {
    if (papers.length === 0) return { items: [], truncated: [] };

    const ids = papers.map((paper) => String(paper.id));
    const truncated: string[] = [];

    const [linksResult, resultsResult, liveAttemptsResult] = await Promise.all([
      supabase
        .from('exam_paper_questions')
        .select('exam_id, question_id')
        .in('exam_id', ids)
        .limit(MAX_PAGE_QUESTION_ROWS),
      supabase
        .from('exam_history')
        .select('exam_id')
        .in('exam_id', ids)
        .limit(MAX_PAGE_RESULT_ROWS),
      supabase
        .from('exam_progress')
        .select('exam_id')
        .in('exam_id', ids)
        .eq('status', ATTEMPT_STATUS.IN_PROGRESS)
        .limit(MAX_PAGE_RESULT_ROWS),
    ]);

    if (linksResult.error) throw new Error(linksResult.error.message);
    if (resultsResult.error) throw new Error(resultsResult.error.message);
    if (liveAttemptsResult.error) throw new Error(liveAttemptsResult.error.message);

    if ((linksResult.data ?? []).length >= MAX_PAGE_QUESTION_ROWS) truncated.push('question_count');
    if ((resultsResult.data ?? []).length >= MAX_PAGE_RESULT_ROWS) truncated.push('participant_count');
    if ((liveAttemptsResult.data ?? []).length >= MAX_PAGE_RESULT_ROWS) {
      truncated.push('active_attempt_count');
    }

    const questionCounts = countByExamId(linksResult.data as AnyObject[] | null);
    const participantCounts = countByExamId(resultsResult.data as AnyObject[] | null);
    const activeCounts = countByExamId(liveAttemptsResult.data as AnyObject[] | null);
    let verificationSummaries = new Map<string, ExamVerificationSummary>();
    let verificationAvailable = true;
    try {
      verificationSummaries = await buildVerificationSummaries((linksResult.data ?? []) as AnyObject[]);
    } catch (verificationError) {
      verificationAvailable = false;
      logger.warn('[exam-admin] verification summary unavailable', {
        error: verificationError instanceof Error ? verificationError.message : String(verificationError),
      });
    }

    return {
      items: papers.map((paper) => ({
        ...paper,
        status: deriveExamStatus(paper as ExamStatusInput, nowMs),
        question_count: questionCounts.get(String(paper.id)) ?? 0,
        participant_count: participantCounts.get(String(paper.id)) ?? 0,
        active_attempt_count: activeCounts.get(String(paper.id)) ?? 0,
        verification_available: verificationAvailable,
        verification_summary: verificationSummaries.get(String(paper.id)) ?? emptyVerificationSummary(),
      })),
      truncated,
    };
  }

  /**
   * Paginated, searched and filtered exam catalog.
   *
   * `live` and `open` depend on the current time in a way PostgREST cannot
   * filter without duplicating the status rules, so those two statuses are
   * resolved from a bounded read and paged in memory. Every other status is a
   * plain SQL filter with an exact count, and all filters use the same
   * `deriveExamStatus` that the list rows report.
   */
  static async getAllExams(query: ExamAdminListQuery) {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const wantsInMemoryStatus = query.status === 'live' || query.status === 'open';
    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;

    let baseQuery = supabase
      .from('exam_papers')
      .select(PAPER_LIST_COLUMNS, wantsInMemoryStatus ? undefined : { count: 'exact' });

    if (query.category) baseQuery = baseQuery.eq('category', query.category);
    if (query.track) baseQuery = baseQuery.eq('track', query.track);

    if (query.status === 'draft') {
      baseQuery = baseQuery.eq('is_published', false);
    } else if (query.status === 'scheduled') {
      baseQuery = baseQuery.eq('is_published', true).gt('start_time', nowIso);
    } else if (query.status === 'completed') {
      baseQuery = baseQuery.eq('is_published', true).lt('end_time', nowIso);
    } else if (query.status !== 'all' && !wantsInMemoryStatus) {
      baseQuery = baseQuery.eq('is_published', true);
    }

    if (query.q) {
      baseQuery = baseQuery.or(
        `title.ilike.%${query.q}%,title_en.ilike.%${query.q}%,id.ilike.%${query.q}%`
      );
    }

    const ordered = baseQuery
      .order(query.sort, { ascending: query.direction === 'asc', nullsFirst: false })
      .order('id', { ascending: true });

    if (!wantsInMemoryStatus) {
      const { data, count, error } = await ordered.range(from, to);

      if (error) throw new Error(error.message);

      const { items, truncated } = await ExamAdminService.decoratePapers(
        (data ?? []) as AnyObject[],
        now
      );
      const total = count ?? items.length;

      return {
        items,
        page: query.page,
        page_size: query.page_size,
        total,
        total_pages: Math.max(1, Math.ceil(total / query.page_size)),
        truncated,
      };
    }

    const { data, error } = await ordered.limit(MAX_OVERVIEW_PAPERS);

    if (error) throw new Error(error.message);

    const matching = ((data ?? []) as AnyObject[]).filter(
      (paper) => deriveExamStatus(paper as ExamStatusInput, now) === query.status
    );
    const pageRows = matching.slice(from, from + query.page_size);
    const { items, truncated } = await ExamAdminService.decoratePapers(pageRows, now);

    return {
      items,
      page: query.page,
      page_size: query.page_size,
      total: matching.length,
      total_pages: Math.max(1, Math.ceil(matching.length / query.page_size)),
      truncated,
    };
  }

  /**
   * Operational overview for the exam hub: real counts, the papers that need
   * attention, what is scheduled next and the latest submissions.
   *
   * Everything here is derived from the same columns the student engine reads,
   * so the numbers match what a student sees. Reads are bounded and grouped
   * (no per-exam query).
   */
  static async getOverview() {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const last24hIso = new Date(now - 24 * 60 * MINUTE_MS).toISOString();

    const [papersResult, linksResult, attemptsResult, recentResult, attemptsLast24h] =
      await Promise.all([
        supabase
          .from('exam_papers')
          .select(PAPER_LIST_COLUMNS)
          .order('created_at', { ascending: false })
          .limit(MAX_OVERVIEW_PAPERS),
        supabase
          .from('exam_paper_questions')
          .select('exam_id')
          .limit(MAX_OVERVIEW_QUESTION_ROWS),
        supabase
          .from('exam_progress')
          .select('exam_id, last_updated_at')
          .eq('status', ATTEMPT_STATUS.IN_PROGRESS)
          .limit(MAX_OVERVIEW_ATTEMPT_ROWS),
        supabase
          .from('exam_history')
          .select('id, exam_id, user_id, score, total_marks, time_taken, status, submitted_at, profiles(full_name)')
          .order('submitted_at', { ascending: false })
          .limit(10),
        supabase
          .from('exam_history')
          .select('id', { count: 'exact', head: true })
          .gte('submitted_at', last24hIso),
      ]);

    for (const [label, result] of [
      ['papers', papersResult],
      ['questions', linksResult],
      ['attempts', attemptsResult],
      ['recent results', recentResult],
      ['results in the last 24h', attemptsLast24h],
    ] as const) {
      if (result.error) throw new Error(`${label}: ${result.error.message}`);
    }

    const papers = (papersResult.data ?? []) as AnyObject[];
    const questionCounts = countByExamId(linksResult.data as AnyObject[] | null);
    const activeAttempts = countByExamId(attemptsResult.data as AnyObject[] | null);
    const titleById = new Map(papers.map((paper) => [String(paper.id), String(paper.title ?? '')]));

    const counts = {
      total: papers.length,
      draft: 0,
      scheduled: 0,
      live: 0,
      completed: 0,
      open: 0,
    };

    const decorated: AnyObject[] = papers.map((paper) => {
      const status = deriveExamStatus(paper as ExamStatusInput, now);
      counts[status] += 1;

      return {
        ...paper,
        status,
        question_count: questionCounts.get(String(paper.id)) ?? 0,
        active_attempts: activeAttempts.get(String(paper.id)) ?? 0,
      };
    });

    const byStatus = (status: DerivedExamStatus) =>
      decorated.filter((paper) => paper.status === status);

    const upcoming = byStatus('scheduled')
      .slice()
      .sort((a, b) => Date.parse(String(a.start_time)) - Date.parse(String(b.start_time)))
      .slice(0, 6)
      .map((paper) => ({
        id: paper.id,
        title: paper.title,
        title_en: paper.title_en ?? null,
        category: paper.category ?? null,
        track: paper.track ?? null,
        is_premium: paper.is_premium === true,
        start_time: paper.start_time,
        end_time: paper.end_time,
        question_count: paper.question_count,
      }));

    const live = byStatus('live')
      .slice()
      .sort((a, b) => (b.active_attempts as number) - (a.active_attempts as number))
      .slice(0, 6)
      .map((paper) => ({
        id: paper.id,
        title: paper.title,
        start_time: paper.start_time,
        end_time: paper.end_time,
        question_count: paper.question_count,
        active_attempts: paper.active_attempts,
      }));

    const draftsWithoutQuestions = decorated.filter(
      (paper) => paper.status === 'draft' && paper.question_count === 0
    );
    const publishedWithoutQuestions = decorated.filter(
      (paper) => paper.status !== 'draft' && paper.question_count === 0
    );
    const endingSoon = byStatus('live').filter((paper) => {
      const end = paper.end_time ? Date.parse(String(paper.end_time)) : Number.NaN;

      return Number.isFinite(end) && end - now <= MINUTE_MS * 60 && end >= now;
    });
    const startingSoon = byStatus('scheduled').filter((paper) => {
      const start = Date.parse(String(paper.start_time));

      return Number.isFinite(start) && start - now <= MINUTE_MS * 60;
    });

    const alerts: Array<{
      code: string;
      severity: 'critical' | 'warning' | 'info';
      title: string;
      description: string;
    }> = [];

    if (publishedWithoutQuestions.length > 0) {
      alerts.push({
        code: 'PUBLISHED_WITHOUT_QUESTIONS',
        severity: 'critical',
        title: `${publishedWithoutQuestions.length} published exam(s) have no questions`,
        description: 'Students cannot start these papers. Unpublish or add questions.',
      });
    }

    if (draftsWithoutQuestions.length > 0) {
      alerts.push({
        code: 'DRAFT_WITHOUT_QUESTIONS',
        severity: 'warning',
        title: `${draftsWithoutQuestions.length} draft exam(s) have no questions yet`,
        description: 'A draft needs at least one question before it can be published.',
      });
    }

    if (startingSoon.length > 0) {
      alerts.push({
        code: 'STARTS_WITHIN_HOUR',
        severity: 'info',
        title: `${startingSoon.length} exam(s) start within the next hour`,
        description: 'Check the question sets and instructions before students open them.',
      });
    }

    if (endingSoon.length > 0) {
      alerts.push({
        code: 'ENDS_WITHIN_HOUR',
        severity: endingSoon.some((paper) => (paper.active_attempts as number) > 0)
          ? 'warning'
          : 'info',
        title: `${endingSoon.length} exam window(s) close within the next hour`,
        description: 'Open live monitoring to extend an attempt that is about to expire.',
      });
    }

    const needsAttention = [...publishedWithoutQuestions, ...draftsWithoutQuestions]
      .slice(0, 5)
      .map((paper) => ({
        id: paper.id,
        title: paper.title,
        status: paper.status,
      }));

    const recentResults = ((recentResult.data ?? []) as AnyObject[]).map((row) => ({
      id: row.id,
      exam_id: row.exam_id ?? null,
      exam_title: titleById.get(String(row.exam_id ?? '')) ?? null,
      user_name: row.profiles?.full_name || 'Unknown User',
      score: Number(row.score ?? 0),
      total_marks: Number(row.total_marks ?? 0),
      time_taken: Number(row.time_taken ?? 0),
      status: row.status ?? null,
      submitted_at: row.submitted_at ?? null,
    }));

    return {
      generated_at: nowIso,
      counts,
      active_attempts: (attemptsResult.data ?? []).length,
      results_last_24h: attemptsLast24h.count ?? 0,
      live,
      upcoming,
      alerts,
      needs_attention: needsAttention,
      recent_results: recentResults,
    };
  }

  static async getExamDetails(id: string) {
    const { data, error } = await supabase
      .from('exam_papers')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Exam not found');

    let admissionUniversityId: string | null = null;

    if (data.admission_unit_id) {
      const { data: unit, error: unitError } = await supabase
        .from('admission_units')
        .select('institution_id')
        .eq('id', data.admission_unit_id)
        .maybeSingle();

      if (unitError) throw new Error(unitError.message);
      admissionUniversityId = unit?.institution_id ?? null;
    }

    return {
      ...data,
      admission_university_id: admissionUniversityId,
      question_count: await countExamQuestions(id),
      has_attempts: await examHasAttempts(id),
    };
  }

  static async deleteExam(id: string, adminId?: string) {
    const { data, error } = await supabase.from('exam_papers').delete().eq('id', id).select();
    if (error) throw new Error(error.message);
    if (data?.length) await auditExamAction(adminId, 'exam.deleted', id);
    return data;
  }

  /**
   * Admin-only publication toggle. Publishing validates that the paper is a
   * complete exam (question set + authoritative duration) so an incomplete or
   * unauthorized paper cannot enter the published catalog. This is the ONLY
   * path that may set is_published to true.
   */
  static async togglePublish(id: string, adminId?: string) {
    const exam = await ExamAdminService.getExamDetails(id);

    if (!exam) throw new Error('Exam not found');

    const nextPublished = !exam.is_published;

    if (nextPublished) {
      const duration = Number(exam.duration_min);

      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error('Cannot publish an exam without a valid duration');
      }

      const { count, error: countError } = await supabase
        .from('exam_paper_questions')
        .select('id', { count: 'exact', head: true })
        .eq('exam_id', id);

      if (countError) throw new Error(countError.message);

      if (!count) {
        throw new ExamAuthoringError(
          'Cannot publish an exam without questions',
          400,
          'EXAM_HAS_NO_QUESTIONS'
        );
      }
    }

    const { data, error } = await supabase
      .from('exam_papers')
      .update({ is_published: nextPublished })
      .eq('id', id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    await auditExamAction(adminId, nextPublished ? 'exam.published' : 'exam.unpublished', id);
    return data;
  }

  static async autoFetchQuestions(payload: AutoFetchDTO) {
    let query = supabase.from('questions').select('id, body');
    if (payload.mode === 'custom') {
      query = query.eq('chapter_id', payload.chapter_id);
    } else {
      query = query.contains('exam_references', [{ type: payload.reference_type, year: payload.year }]);
    }
    const limitCount = (payload.easy_count || 0) + (payload.medium_count || 0) + (payload.hard_count || 0);
    if (limitCount > 0) query = query.limit(limitCount);
    
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data;
  }

  /**
   * Reference data for the exam wizard: the subjects a paper may belong to and
   * the categories the create endpoint accepts. Keeping both server-side stops
   * the UI from offering a subject/category the API will reject.
   */
  static async listAuthoringOptions() {
    const { data, error } = await supabase
      .from('subjects')
      .select('id, name_bn, name_en, is_premium')
      .eq('is_active', true)
      .order('sequence', { ascending: true });

    if (error) throw new Error(error.message);

    return {
      subjects: (data || []).map((row: AnyObject) => ({
        id: row.id,
        name_bn: row.name_bn ?? null,
        name_en: row.name_en ?? null,
        is_premium: row.is_premium ?? false,
      })),
      categories: [...EXAM_AUTHORING_CATEGORIES],
      tracks: [...MODEL_TEST_TRACKS],
      admission_modes: [...ADMISSION_EXAM_MODES],
    };
  }

  /**
   * Published, active questions an administrator may add to a paper.
   *
   * This is the authoring view (not the student RPC): it returns the ids the
   * create/update endpoints will accept, so the wizard cannot offer an
   * ineligible question and then fail on submit.
   */
  static async listEligibleQuestions(params: {
    subjectId?: unknown;
    chapterId?: unknown;
    limit?: unknown;
  }) {
    const subjectId = typeof params?.subjectId === 'string' ? params.subjectId.trim() : '';

    const requestedLimit = Number(params?.limit);
    const limit =
      Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 500) : 100;

    let query = supabase
      .from('questions')
      .select('id, body, difficulty_level, type, topic_id, chapter_id, subject_id')
      .eq('is_active', true)
      .eq('status', 'published')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(limit);

    // A full model test spans subjects, so the filter is optional: no
    // `subject_id` means "all subjects the admin may pick from".
    if (subjectId) query = query.eq('subject_id', subjectId);

    const chapterId = typeof params?.chapterId === 'string' ? params.chapterId.trim() : '';

    if (chapterId) query = query.eq('chapter_id', chapterId);

    const { data, error } = await query;

    if (error) throw new Error(error.message);

    return (data || []).map((row: AnyObject) => ({
      id: row.id,
      body: row.body ?? null,
      difficulty_level: row.difficulty_level ?? null,
      type: row.type ?? null,
      topic_id: row.topic_id ?? null,
      chapter_id: row.chapter_id ?? null,
      subject_id: row.subject_id ?? null,
    }));
  }

  /**
   * Creates one exam paper with its question associations.
   *
   * The paper is inserted unpublished, its questions are linked next, and only
   * then is `is_published` flipped. If the association insert fails the paper is
   * deleted again, so no partially-built (or published-but-empty) exam can be
   * left behind. Supabase exposes no client transaction here, which is why the
   * compensation step is explicit.
   */
  static async createExam(payload: unknown, adminId?: string) {
    const parsed: ExamAuthoringFields = parseExamCreatePayload(payload);

    if (parsed.subject_id) await assertSubjectExists(parsed.subject_id);

    const admission =
      parsed.category === 'admission'
        ? await assertAdmissionUnit(
            parsed.admission_unit_id as string,
            parsed.admission_university_id
          )
        : null;

    const questionIds = await requireEligibleQuestions(parsed.question_ids, {
      subjectId:
        parsed.category === 'admission' && parsed.exam_mode === 'subject_practice'
          ? parsed.subject_id
          : null,
    });
    const questionMarks = marksForQuestions(questionIds, parsed.question_marks);
    const totalMarks = totalForMarks(questionMarks);
    const metadata =
      parsed.category === 'admission'
        ? buildAdmissionMetadata(
            null,
            parsed.category,
            parsed.exam_mode,
            parsed.admission_session
          )
        : null;
    const paperId = randomUUID();

    const paperRow: AnyObject = {
      id: paperId,
      title: parsed.title,
      title_en: parsed.title_en,
      subject_id: parsed.subject_id,
      category: parsed.category,
      track: parsed.track,
      exam_type: parsed.exam_type,
      duration_min: parsed.duration_min,
      start_time: parsed.start_time,
      end_time: parsed.end_time,
      result_publish_time: parsed.result_publish_time,
      instructions: parsed.instructions,
      instructions_en: parsed.instructions_en,
      syllabus_details: parsed.syllabus_details,
      syllabus_details_en: parsed.syllabus_details_en,
      // Derived server-side from the verified question set and per-question marks.
      total_marks: totalMarks,
      pass_mark: Math.min(parsed.pass_mark, totalMarks),
      default_negative_marks: parsed.default_negative_marks,
      show_leaderboard: parsed.show_leaderboard,
      is_premium: parsed.is_premium,
      is_published: false,
      admission_unit_id: admission?.unitId ?? null,
      ...(metadata ? { meta_data: metadata } : {}),
    };

    const { data: created, error: paperError } = await supabase
      .from('exam_papers')
      .insert([paperRow])
      .select()
      .single();

    if (paperError) throw new Error(paperError.message);

    const { error: linkError } = await supabase.from('exam_paper_questions').insert(
      questionIds.map((questionId, index) => ({
        exam_id: paperId,
        question_id: questionId,
        sequence: index + 1,
        marks: questionMarks[index],
      }))
    );

    if (linkError) {
      const { error: cleanupError } = await supabase.from('exam_papers').delete().eq('id', paperId);

      logger.error('[exam-admin] exam creation rolled back', {
        paperId,
        adminId: adminId ?? null,
        message: linkError.message,
        cleanupError: cleanupError?.message ?? null,
      });

      throw new ExamAdminError(
        'The exam questions could not be saved, so the exam was not created.',
        500
      );
    }

    if (parsed.is_published) {
      const { error: publishError } = await supabase
        .from('exam_papers')
        .update({ is_published: true })
        .eq('id', paperId);

      if (publishError) {
        logger.error('[exam-admin] exam created as draft; publish failed', {
          paperId,
          adminId: adminId ?? null,
          message: publishError.message,
        });

        throw new ExamAdminError(
          'The exam was saved as a draft because publishing failed. Publish it again from the exam list.',
          500
        );
      }
    }

    logger.info('[exam-admin] exam created', {
      paperId,
      adminId: adminId ?? null,
      questionCount: questionIds.length,
      published: parsed.is_published,
    });

    return {
      ...(created ?? paperRow),
      is_published: parsed.is_published,
      question_count: questionIds.length,
    };
  }

  /**
   * Updates a paper's authored fields and, when `question_ids` is supplied,
   * replaces its question set.
   *
   * Existing associations are captured before the swap so a failed replacement
   * can be rolled back instead of leaving the paper without questions.
   */
  static async updateExam(examId: string, payload: unknown, adminId?: string) {
    const id = typeof examId === 'string' ? examId.trim() : '';

    if (!id) throw new ExamAdminError('Exam id is required', 400);

    const patch: ExamAuthoringPatch = parseExamUpdatePayload(payload);

    const { data: existing, error: readError } = await supabase
      .from('exam_papers')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (readError) throw new Error(readError.message);
    if (!existing) throw new ExamAdminError('Exam not found', 404);

    const nextCategory = patch.category ?? existing.category ?? 'model_test';
    const nextTrack = 'track' in patch ? patch.track ?? null : existing.track ?? null;
    const nextSubjectId =
      'subject_id' in patch ? patch.subject_id ?? null : existing.subject_id ?? null;
    const nextExamMode =
      nextCategory === 'admission'
        ? 'exam_mode' in patch
          ? patch.exam_mode ?? null
          : readMetadataExamMode(existing.meta_data)
        : null;
    const nextAdmissionSession =
      nextCategory === 'admission'
        ? 'admission_session' in patch
          ? patch.admission_session ?? null
          : readMetadataString(existing.meta_data, 'admission_session')
        : null;
    const nextAdmissionUnitId =
      nextCategory === 'admission'
        ? 'admission_unit_id' in patch
          ? patch.admission_unit_id ?? null
          : existing.admission_unit_id ?? null
        : null;
    const nextAdmissionUniversityId =
      'admission_university_id' in patch ? patch.admission_university_id ?? null : null;

    const admissionTouched =
      nextCategory === 'admission' &&
      (existing.category !== 'admission' ||
        'category' in patch ||
        'admission_unit_id' in patch ||
        'admission_university_id' in patch ||
        'exam_mode' in patch ||
        'admission_session' in patch ||
        'subject_id' in patch);

    if (
      nextCategory !== 'admission' &&
      ('admission_unit_id' in patch ||
        'admission_university_id' in patch ||
        'exam_mode' in patch ||
        'admission_session' in patch)
    ) {
      throw new ExamAuthoringError(
        'Admission fields are only allowed when category is admission'
      );
    }

    assertValidExamTrack(nextCategory, nextTrack);
    assertValidExamSubject(nextCategory, nextSubjectId, nextExamMode);
    assertValidAdmissionState(
      nextCategory,
      {
        unitId: nextAdmissionUnitId,
        universityId: nextAdmissionUniversityId,
        examMode: nextExamMode,
        admissionSession: nextAdmissionSession,
        subjectId: nextSubjectId,
      },
      {
        enforce: admissionTouched,
        requireMode: nextCategory === 'admission' && existing.category !== 'admission',
      }
    );

    if (nextSubjectId && nextSubjectId !== existing.subject_id) {
      await assertSubjectExists(nextSubjectId);
    }

    if (nextCategory === 'admission' && admissionTouched && nextAdmissionUnitId) {
      await assertAdmissionUnit(nextAdmissionUnitId, nextAdmissionUniversityId);
    }

    assertValidExamWindow(
      patch.start_time ?? existing.start_time,
      patch.end_time ?? existing.end_time,
      'result_publish_time' in patch ? patch.result_publish_time : existing.result_publish_time
    );

    const replacingQuestions = Array.isArray(patch.question_ids);
    const nextQuestionIds = replacingQuestions
      ? await requireEligibleQuestions(patch.question_ids as string[], {
          subjectId:
            nextCategory === 'admission' && nextExamMode === 'subject_practice'
              ? nextSubjectId
              : null,
        })
      : null;

    if (replacingQuestions && (nextQuestionIds as string[]).length === 0) {
      throw new ExamAuthoringError('An exam must keep at least one question');
    }

    const nextQuestionMarks = nextQuestionIds
      ? marksForQuestions(nextQuestionIds, patch.question_marks)
      : null;
    const nextTotalMarks = nextQuestionMarks ? totalForMarks(nextQuestionMarks) : null;

    const nextDuration = Number(patch.duration_min ?? existing.duration_min);
    const nextPublished = patch.is_published ?? existing.is_published === true;

    if (nextPublished) {
      const finalCount = nextQuestionIds ? nextQuestionIds.length : await countExamQuestions(id);

      if (!Number.isFinite(nextDuration) || nextDuration <= 0) {
        throw new ExamAdminError('Cannot publish an exam without a valid duration', 400);
      }

      if (finalCount === 0) {
        throw new ExamAuthoringError(
          'Cannot publish an exam without questions',
          400,
          'EXAM_HAS_NO_QUESTIONS'
        );
      }
    }

    const update: AnyObject = {};

    for (const column of PAPER_AUTHORED_COLUMNS) {
      if (column in patch) update[column] = (patch as unknown as AnyObject)[column];
    }

    if (
      nextCategory !== 'admission' &&
      existing.category === 'admission' &&
      'category' in patch
    ) {
      update.admission_unit_id = null;
    }

    if (nextQuestionIds && nextTotalMarks !== null) {
      update.total_marks = nextTotalMarks;
      update.pass_mark = Math.min(
        Number(patch.pass_mark ?? existing.pass_mark ?? 0),
        nextTotalMarks
      );
    }

    const shouldUpdateMetadata =
      nextCategory === 'admission'
        ? existing.category !== 'admission' ||
          'exam_mode' in patch ||
          'admission_session' in patch
        : existing.category === 'admission' && 'category' in patch;

    if (shouldUpdateMetadata) {
      update.meta_data = buildAdmissionMetadata(
        existing.meta_data,
        nextCategory,
        nextExamMode,
        nextAdmissionSession
      );
    }

    update.is_published = nextPublished;

    let previousLinks: AnyObject[] = [];

    if (nextQuestionIds) {
      const { data: links, error: linkReadError } = await supabase
        .from('exam_paper_questions')
        .select('exam_id, question_id, sequence, marks')
        .eq('exam_id', id);

      if (linkReadError) throw new Error(linkReadError.message);

      previousLinks = links || [];

      const { error: deleteError } = await supabase
        .from('exam_paper_questions')
        .delete()
        .eq('exam_id', id);

      if (deleteError) throw new Error(deleteError.message);

      const { error: insertError } = await supabase.from('exam_paper_questions').insert(
        nextQuestionIds.map((questionId, index) => ({
          exam_id: id,
          question_id: questionId,
          sequence: index + 1,
          marks: nextQuestionMarks?.[index] ?? 1,
        }))
      );

      if (insertError) {
        if (previousLinks.length > 0) {
          const { error: restoreError } = await supabase
            .from('exam_paper_questions')
            .insert(previousLinks);

          if (restoreError) {
            logger.error('[exam-admin] question restore failed after update', {
              examId: id,
              message: restoreError.message,
            });
          }
        }

        throw new ExamAdminError(
          'The new question set could not be saved. The previous questions were kept.',
          500
        );
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from('exam_papers')
      .update(update)
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      if (nextQuestionIds && previousLinks.length > 0) {
        await supabase.from('exam_paper_questions').delete().eq('exam_id', id);
        const { error: restoreError } = await supabase
          .from('exam_paper_questions')
          .insert(previousLinks);

        if (restoreError) {
          logger.error('[exam-admin] question restore failed after paper update', {
            examId: id,
            message: restoreError.message,
          });
        }
      }

      throw new Error(updateError.message);
    }

    logger.info('[exam-admin] exam updated', {
      examId: id,
      adminId: adminId ?? null,
      replacedQuestions: Boolean(nextQuestionIds),
      published: nextPublished,
    });

    return {
      ...updated,
      question_count: nextQuestionIds ? nextQuestionIds.length : await countExamQuestions(id),
      has_attempts: await examHasAttempts(id),
    };
  }

  /**
   * Applies a moderation action to one user.
   *
   * `zero_marks` is always scoped to a single exam: without an exam id it would
   * previously zero every result the user ever recorded. Unknown actions are a
   * client error rather than a silent no-op.
   */
  static async punishUser(payload: PunishUserDTO & { exam_id?: string }, adminId?: string, accessToken?: string) {
    const userId = typeof payload?.userId === 'string' ? payload.userId.trim() : '';

    if (!userId) {
      throw new ExamAdminError('userId is required', 400);
    }

    const action = payload?.action;

    if (action === 'zero_marks') {
      const examId =
        typeof payload?.examId === 'string' && payload.examId.trim()
          ? payload.examId.trim()
          : typeof payload?.exam_id === 'string' && payload.exam_id.trim()
            ? payload.exam_id.trim()
            : '';

      if (!examId) {
        throw new ExamAdminError('examId is required for the zero_marks action', 400);
      }

      const { data, error } = await supabase
        .from('exam_history')
        .update({ score: 0, status: 'fraud_detected' })
        .eq('user_id', userId)
        .eq('exam_id', examId)
        .select('id');

      if (error) throw new Error(error.message);
      if (!data || data.length === 0) {
        throw new ExamAdminError('No exam result found for this user and exam', 404);
      }

      logger.warn('[exam-admin] zeroed exam result', {
        adminId: adminId ?? null,
        userId,
        examId,
        affected: data.length,
      });

      const { error: auditError } = await supabase.from('audit_logs').insert({
        user_id: adminId ?? null,
        action: 'exam_history.zero_marks',
        target_table: 'exam_history',
        target_id: userId,
        details: { exam_id: examId, affected_rows: data.length },
      });
      if (auditError) logger.error('[security-audit] exam result action could not be recorded');

      return { success: true, action, userId, examId, affected: data.length };
    }

    if (action === 'suspend_account') {
      if (!accessToken) throw new ExamAdminError('Authorization session unavailable', 401);
      const { error } = await createUserSupabaseClient(accessToken).rpc('set_user_account_status', {
        p_target_user_id: userId,
        p_status: 'suspended',
      });
      if (error) throw new ExamAdminError('Account status change was not authorized', 403);

      logger.warn('[exam-admin] suspended user account', { adminId: adminId ?? null, userId });

      return { success: true, action, userId };
    }

    throw new ExamAdminError(`Unsupported action: ${String(action)}`, 400);
  }

  /**
   * Live view of an exam: only attempts that are still in progress.
   *
   * `time_remaining` is not maintained after attempt creation, so remaining
   * time is always derived from the authoritative `deadline_at`.
   */
  static async getLiveProgress(examId: string) {
    if (!examId) throw new ExamAdminError('Exam id is required', 400);

    const { data, error } = await supabase
      .from('exam_progress')
      .select('id, user_id, current_question_index, status, deadline_at, last_updated_at, profiles(full_name)')
      .eq('exam_id', examId)
      .eq('status', ATTEMPT_STATUS.IN_PROGRESS)
      .order('last_updated_at', { ascending: false });

    if (error) throw new Error(error.message);

    // The question total turns the saved index into a real progress figure.
    const questionTotal = await countExamQuestions(examId);
    const now = Date.now();

    return (data || []).map((progress: AnyObject) => {
      const index = Number(progress.current_question_index ?? 0);

      return {
        id: progress.id,
        user_id: progress.user_id,
        user_name: progress.profiles?.full_name || 'Unknown User',
        current_question_index: index,
        question_total: questionTotal,
        progress_percent:
          questionTotal > 0
            ? Math.min(100, Math.round(((index + 1) / questionTotal) * 100))
            : null,
        status: progress.status,
        deadline_at: progress.deadline_at ?? null,
        seconds_remaining: secondsRemaining(progress.deadline_at, now),
        last_updated_at: progress.last_updated_at ?? null,
      };
    });
  }

  static async getLeaderboard(examId: string) {
    const { data, error } = await supabase
      .from('exam_history')
      .select('id, user_id, score, total_marks, time_taken, device_type, status, profiles(full_name)')
      .eq('exam_id', examId)
      .order('score', { ascending: false })
      .order('time_taken', { ascending: true });
    if (error) throw new Error(error.message);

    return data.map((entry: any) => ({
      ...entry,
      user_name: entry.profiles?.full_name || 'Unknown User'
    }));
  }

  /**
   * Extends an eligible attempt.
   *
   * Recovery is a real extension: it only applies to an attempt that is still
   * `in_progress` or already `expired`, it refuses once a result exists, and it
   * moves the deadline to `max(now, deadline_at) + extend_minutes`. The update
   * is conditional so a concurrent submission or expiry cannot be reopened.
   */
  static async recoverSession(progressId: string, extendMinutes: unknown, adminId?: string) {
    const attemptId = typeof progressId === 'string' ? progressId.trim() : '';

    if (!attemptId) throw new ExamAdminError('progressId is required', 400);

    const minutes = Number(extendMinutes);

    if (
      !Number.isInteger(minutes) ||
      minutes < RECOVER_MIN_MINUTES ||
      minutes > RECOVER_MAX_MINUTES
    ) {
      throw new ExamAdminError(
        `extend_minutes must be a whole number between ${RECOVER_MIN_MINUTES} and ${RECOVER_MAX_MINUTES}`,
        400
      );
    }

    const { data: attempt, error: readError } = await supabase
      .from('exam_progress')
      .select('id, user_id, exam_id, kind, status, deadline_at, exam_history_id')
      .eq('id', attemptId)
      .maybeSingle();

    if (readError) throw new Error(readError.message);
    if (!attempt) throw new ExamAdminError('Attempt not found', 404);

    if (
      attempt.status !== ATTEMPT_STATUS.IN_PROGRESS &&
      attempt.status !== ATTEMPT_STATUS.EXPIRED
    ) {
      throw new ExamAdminError(
        `Attempt cannot be recovered from status '${attempt.status}'`,
        409
      );
    }

    const { data: existingResult, error: historyError } = await supabase
      .from('exam_history')
      .select('id')
      .eq('attempt_id', attemptId)
      .maybeSingle();

    if (historyError) throw new Error(historyError.message);

    if (existingResult || attempt.exam_history_id) {
      throw new ExamAdminError('A result already exists for this attempt', 409);
    }

    const now = Date.now();
    const currentDeadline = Date.parse(String(attempt.deadline_at));
    const base = Number.isFinite(currentDeadline) ? Math.max(now, currentDeadline) : now;
    const nextDeadline = new Date(base + minutes * MINUTE_MS);
    const remaining = secondsRemaining(nextDeadline.toISOString(), now);

    const { data: updated, error } = await supabase
      .from('exam_progress')
      .update({
        status: ATTEMPT_STATUS.IN_PROGRESS,
        deadline_at: nextDeadline.toISOString(),
        time_remaining: remaining,
        last_updated_at: new Date().toISOString(),
      })
      .eq('id', attemptId)
      .in('status', [ATTEMPT_STATUS.IN_PROGRESS, ATTEMPT_STATUS.EXPIRED])
      .is('exam_history_id', null)
      .select()
      .single();

    if (error) throw new Error(error.message);

    logger.warn('[exam-admin] attempt extended', {
      adminId: adminId ?? null,
      attemptId,
      userId: attempt.user_id ?? null,
      examId: attempt.exam_id ?? null,
      extendMinutes: minutes,
      deadlineAt: updated?.deadline_at ?? nextDeadline.toISOString(),
    });

    // Best-effort audit trail; a failure here must not undo the extension.
    try {
      await supabase.from('audit_logs').insert({
        user_id: adminId ?? null,
        action: 'exam_attempt_recovered',
        target_table: 'exam_progress',
        target_id: attemptId,
        details: {
          extend_minutes: minutes,
          previous_deadline_at: attempt.deadline_at ?? null,
          deadline_at: updated?.deadline_at ?? nextDeadline.toISOString(),
        },
      });
    } catch {
      // ignore audit failures
    }

    return {
      ...updated,
      seconds_remaining: secondsRemaining(updated?.deadline_at, now),
      extended_by_minutes: minutes,
    };
  }
}
