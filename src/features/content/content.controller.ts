import { Request, Response } from 'express';
import * as contentService from './content.service';
import * as questionService from './question.service';
import * as questionImportService from './question.import.service';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import { AuditFilterParams } from './content.types';

interface AuthReq extends Request { user?: { id: string }; userRole?: string }

export const getStudyMaterials = catchAsync(async (req: AuthReq, res: Response) => {
  const materials = await contentService.getStudyMaterials(req.user?.id);
  sendResponse(res, { statusCode: 200, success: true, message: 'Study materials retrieved', data: materials });
});

export const getTaxonomySubjects = catchAsync(async (req: AuthReq, res: Response) => {
  const subjects = await contentService.getSubjects(req.user?.id);
  sendResponse(res, { statusCode: 200, success: true, message: 'Subjects retrieved', data: subjects });
});

export const getTaxonomyChapters = catchAsync(async (req: AuthReq, res: Response) => {
  const chapters = await contentService.getChapters(req.query.subjectId as string, req.user?.id);
  sendResponse(res, { statusCode: 200, success: true, message: 'Chapters retrieved', data: chapters });
});

export const getTaxonomyTopics = catchAsync(async (req: AuthReq, res: Response) => {
  const topics = await contentService.getTopics(req.query.chapterId as string, req.user?.id);
  sendResponse(res, { statusCode: 200, success: true, message: 'Topics retrieved', data: topics });
});

export const getCurriculumTree = catchAsync(async (req: AuthReq, res: Response) => {
  // The authenticated user decides the lock state of premium nodes.
  const tree = await contentService.buildCurriculumTree(req.user?.id);
  sendResponse(res, { statusCode: 200, success: true, message: 'Curriculum tree retrieved', data: tree });
});

export const manageCurriculum = catchAsync(async (req: Request, res: Response) => {
  const { action, nodeType, data, id } = req.body;
  const result = await contentService.manageCurriculumNode(action, nodeType, data, id);
  sendResponse(res, { statusCode: 200, success: true, message: `Curriculum node ${action}d successfully`, data: result });
});

export const createComprehension = catchAsync(async (req: Request, res: Response) => {
  const result = await contentService.createComprehension(req.body);
  sendResponse(res, { statusCode: 201, success: true, message: 'Comprehension created', data: result });
});

export const searchComprehensions = catchAsync(async (req: Request, res: Response) => {
  const result = await contentService.searchComprehensions(req.query.q as string);
  sendResponse(res, { statusCode: 200, success: true, message: 'Comprehensions retrieved', data: result });
});

export const createQuestion = catchAsync(async (req: AuthReq, res: Response) => {
  // The role comes from rbacGuard (user_roles), never from the request body,
  // and the service allow-lists the fields it persists.
  const newQuestion = await contentService.saveSmartQuestion(req.body, {
    role: req.userRole,
    userId: req.user?.id,
  });
  sendResponse(res, { statusCode: 201, success: true, message: 'Question saved', data: newQuestion });
});

export const bulkCreateQuestions = catchAsync(async (req: AuthReq, res: Response) => {
  const { questions } = req.body;
  
  if (!questions || !Array.isArray(questions) || questions.length === 0) {
    return sendResponse(res, { statusCode: 400, success: false, message: 'Invalid payload: Questions array is required' });
  }

  const result = await questionService.saveBulkQuestions(questions, req.user?.id, {
    role: req.userRole,
  });
  sendResponse(res, { statusCode: 201, success: true, message: `${result.length} questions uploaded successfully`, data: result });
});

/**
 * Question Importer batch endpoint.
 *
 * `dry_run: true` runs the same validation and duplicate detection without
 * writing, so the importer can show duplicates before anything is committed.
 * The author identity and role come from the verified token, never the body.
 */
export const importQuestions = catchAsync(async (req: AuthReq, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (!req.user?.id) {
    return sendResponse(res, { statusCode: 401, success: false, message: 'Unauthorized' });
  }

  const result = await questionImportService.importQuestions(body.questions, {
    userId: req.user.id,
    role: req.userRole,
    dryRun: body.dry_run === true,
    sourceLabel: typeof body.source_label === 'string' ? body.source_label : null,
    subjectLabels: Array.isArray(body.subject_labels)
      ? body.subject_labels.filter((label): label is string => typeof label === 'string')
      : [],
  });

  sendResponse(res, {
    statusCode: result.dry_run ? 200 : 201,
    success: true,
    message: result.dry_run
      ? 'Import pre-check completed'
      : `${result.counts.imported} of ${result.counts.total} questions imported`,
    data: result,
  });
});

export const getQuestionImportHistory = catchAsync(async (req: AuthReq, res: Response) => {
  if (!req.user?.id) {
    return sendResponse(res, { statusCode: 401, success: false, message: 'Unauthorized' });
  }

  const history = await questionImportService.getQuestionImportHistory(
    req.user.id,
    Number(req.query.limit) || 50
  );

  sendResponse(res, { statusCode: 200, success: true, message: 'Import history retrieved', data: history });
});

export const updateQuestion = catchAsync(async (req: AuthReq, res: Response) => {
  const result = await contentService.updateQuestion(req.params.id, req.body, {
    role: req.userRole,
    userId: req.user?.id,
  });
  sendResponse(res, { statusCode: 200, success: true, message: 'Question updated', data: result });
});

export const deleteQuestion = catchAsync(async (req: Request, res: Response) => {
  await contentService.deleteQuestion(req.params.id);
  sendResponse(res, { statusCode: 200, success: true, message: 'Question soft deleted successfully' });
});

export const getAiReviewQueue = catchAsync(async (req: Request, res: Response) => {
  const queue = await contentService.fetchAiQueue();
  sendResponse(res, { statusCode: 200, success: true, message: 'AI review queue fetched', data: queue });
});

export const reviewQuestion = catchAsync(async (req: AuthReq, res: Response) => {
  const result = await contentService.reviewQuestion(req.params.id, req.body.status, req.user?.id!);
  sendResponse(res, { statusCode: 200, success: true, message: `Question marked as ${req.body.status}`, data: result });
});

export const syncSearchIndex = catchAsync(async (req: Request, res: Response) => {
  const { type } = req.body;
  if (!['vector', 'global'].includes(type)) {
    return sendResponse(res, { statusCode: 400, success: false, message: 'Invalid sync type provided' });
  }
  await contentService.refreshSearchIndex(type);
  sendResponse(res, { statusCode: 200, success: true, message: `${type} search index refresh initiated` });
});

export const getQuestionsForAudit = catchAsync(async (req: Request, res: Response) => {
    const filters: AuditFilterParams = {
        status: req.query.status as string,
        difficulty: req.query.difficulty as string,
        subject_id: req.query.subject_id as string,
        search: req.query.search as string
    };

    const questions = await contentService.getAuditQuestions(filters);
    sendResponse(res, { statusCode: 200, success: true, message: 'Audit queue fetched', data: questions });
});

export const updateAuditQuestionStatus = catchAsync(async (req: AuthReq, res: Response) => {
    const { id } = req.params;
    const { status, notes } = req.body;

    if (!['approved', 'rejected', 'flagged'].includes(status)) {
        return sendResponse(res, { statusCode: 400, success: false, message: 'Invalid status for audit update' });
    }

    const result = await contentService.updateQuestionAuditStatus(id, status, notes, req.user?.id!);
    sendResponse(res, { statusCode: 200, success: true, message: `Question audit status updated to ${status}`, data: result });
});

export const getQuestionsBank = catchAsync(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  
  const filters = {
    subject_id: req.query.subject_id as string,
    chapter_id: req.query.chapter_id as string,
    topic_id: req.query.topic_id as string,
    difficulty: req.query.difficulty as string,
    type: req.query.type as string,
    status: req.query.status as string,
    search: req.query.search as string,
    institution_type: req.query.institution_type as string, // 🚀 Added
    institution_id: req.query.institution_id as string,
    year: req.query.year as string,
  };

  const result = await questionService.getFilteredQuestions(filters, page, limit);
  sendResponse(res, { statusCode: 200, success: true, message: 'Question bank fetched successfully', data: result });
});

export const hardDeleteQuestion = catchAsync(async (req: Request, res: Response) => {
  await contentService.hardDeleteQuestion(req.params.id, (req as any).user?.id);
  sendResponse(res, { statusCode: 200, success: true, message: 'Question permanently deleted' });
});
