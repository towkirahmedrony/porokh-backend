import { randomUUID } from 'crypto';
import { supabase } from '../../config/supabase';
import { createUserSupabaseClient } from '../../config/userSupabase';
import logger from '../../lib/utils/logger';
import { AutoFetchDTO, PunishUserDTO } from './exams.types';
import { ATTEMPT_STATUS, MINUTE_MS } from './exam.timing';
import {
  EXAM_AUTHORING_CATEGORIES,
  MODEL_TEST_TRACKS,
  ExamAuthoringError,
  assertValidExamSubject,
  assertValidExamTrack,
  assertValidExamWindow,
  parseExamCreatePayload,
  parseExamUpdatePayload,
  type ExamAuthoringFields,
  type ExamAuthoringPatch,
} from './exam.authoring';

type AnyObject = Record<string, any>;

const RECOVER_MIN_MINUTES = 1;
const RECOVER_MAX_MINUTES = 60;

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
] as const;

/**
 * Questions are eligible for a paper only when a student could actually answer
 * and have them graded: active, not deleted, and published (the submission path
 * filters on `status = 'published'`, so anything else would be ungradeable).
 */
const requireEligibleQuestions = async (questionIds: string[]): Promise<string[]> => {
  const { data, error } = await supabase
    .from('questions')
    .select('id, status, is_active, deleted_at')
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

  if (missing.length > 0 || ineligible.length > 0) {
    throw new ExamAuthoringError(
      'One or more questions are not available for an exam',
      400,
      'VALIDATION_FAILED',
      {
        missing_question_ids: missing.slice(0, 25),
        ineligible_question_ids: ineligible.slice(0, 25),
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
  static async getAllExams() {
    const { data, error } = await supabase.from('exam_papers').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);

    const papers = data || [];
    const counts = new Map<string, number>();

    if (papers.length > 0) {
      const { data: links, error: linkError } = await supabase
        .from('exam_paper_questions')
        .select('exam_id')
        .in(
          'exam_id',
          papers.map((paper: AnyObject) => String(paper.id))
        );

      if (linkError) throw new Error(linkError.message);

      (links || []).forEach((link: AnyObject) => {
        const examId = String(link.exam_id);
        counts.set(examId, (counts.get(examId) ?? 0) + 1);
      });
    }

    return papers.map((paper: AnyObject) => ({
      ...paper,
      question_count: counts.get(String(paper.id)) ?? 0,
    }));
  }

  static async getExamDetails(id: string) {
    const { data, error } = await supabase
      .from('exam_papers')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Exam not found');

    return {
      ...data,
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

    const questionIds = await requireEligibleQuestions(parsed.question_ids);
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
      // Derived server-side: one mark per question.
      total_marks: questionIds.length,
      pass_mark: Math.min(parsed.pass_mark, questionIds.length),
      default_negative_marks: parsed.default_negative_marks,
      show_leaderboard: parsed.show_leaderboard,
      is_premium: parsed.is_premium,
      is_published: false,
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
        marks: 1,
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

    assertValidExamTrack(nextCategory, nextTrack);
    assertValidExamSubject(nextCategory, nextSubjectId);

    if (nextSubjectId && nextSubjectId !== existing.subject_id) {
      await assertSubjectExists(nextSubjectId);
    }

    assertValidExamWindow(
      patch.start_time ?? existing.start_time,
      patch.end_time ?? existing.end_time,
      'result_publish_time' in patch ? patch.result_publish_time : existing.result_publish_time
    );

    const replacingQuestions = Array.isArray(patch.question_ids);
    const nextQuestionIds = replacingQuestions
      ? await requireEligibleQuestions(patch.question_ids as string[])
      : null;

    if (replacingQuestions && (nextQuestionIds as string[]).length === 0) {
      throw new ExamAuthoringError('An exam must keep at least one question');
    }

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

    if (nextQuestionIds) {
      update.total_marks = nextQuestionIds.length;
      update.pass_mark = Math.min(Number(patch.pass_mark ?? existing.pass_mark ?? 0), nextQuestionIds.length);
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
          marks: 1,
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

    const now = Date.now();

    return (data || []).map((progress: AnyObject) => ({
      id: progress.id,
      user_id: progress.user_id,
      user_name: progress.profiles?.full_name || 'Unknown User',
      current_question_index: Number(progress.current_question_index ?? 0),
      status: progress.status,
      deadline_at: progress.deadline_at ?? null,
      seconds_remaining: secondsRemaining(progress.deadline_at, now),
      last_updated_at: progress.last_updated_at ?? null,
    }));
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
