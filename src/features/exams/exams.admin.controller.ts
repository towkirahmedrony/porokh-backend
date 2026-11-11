import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import { ExamAdminService } from './exams.admin.service';
import { parseExamAdminQuery } from './exams.admin.query';

export const getAllExams = catchAsync(async (req: Request, res: Response) => {
  const query = parseExamAdminQuery(req.query as Record<string, unknown>);
  const result = await ExamAdminService.getAllExams(query);
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Exams fetched',
    data: result,
  });
});

/**
 * Operational overview for the exam hub: status counts, live and upcoming
 * papers, submissions and the papers that block publication.
 */
export const getExamOverview = catchAsync(async (_req: Request, res: Response) => {
  const result = await ExamAdminService.getOverview();
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Exam overview fetched',
    data: result,
  });
});

export const getExamDetails = catchAsync(async (req: Request, res: Response) => {
  const result = await ExamAdminService.getExamDetails(req.params.id);
  sendResponse(res, { statusCode: 200, success: true, data: result });
});

export const deleteExam = catchAsync(async (req: Request, res: Response) => {
  const result = await ExamAdminService.deleteExam(req.params.id, (req as any).user?.id);
  sendResponse(res, { statusCode: 200, success: true, message: 'Exam deleted', data: result });
});

export const togglePublish = catchAsync(async (req: Request, res: Response) => {
  const result = await ExamAdminService.togglePublish(req.params.id, (req as any).user?.id);
  sendResponse(res, { statusCode: 200, success: true, message: 'Status updated', data: result });
});

export const autoFetchQuestions = catchAsync(async (req: Request, res: Response) => {
  const result = await ExamAdminService.autoFetchQuestions(req.body);
  sendResponse(res, { statusCode: 200, success: true, data: result });
});

/**
 * Creates an exam paper and its question set.
 *
 * Authorisation is enforced by the router (`requireAuth` + `rbacGuard(['admin'])`).
 * Every security-sensitive field (publication state, total marks, question
 * associations) is derived server-side by ExamAdminService.
 */
export const createExam = catchAsync(async (req: Request, res: Response) => {
  const adminId = (req as any).user?.id;
  const result = await ExamAdminService.createExam(req.body, adminId);

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: result.is_published ? 'Exam created and published' : 'Exam created as a draft',
    data: result,
  });
});

export const updateExam = catchAsync(async (req: Request, res: Response) => {
  const adminId = (req as any).user?.id;
  const result = await ExamAdminService.updateExam(req.params.id, req.body, adminId);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Exam updated',
    data: result,
  });
});

export const getAuthoringOptions = catchAsync(async (_req: Request, res: Response) => {
  const result = await ExamAdminService.listAuthoringOptions();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Exam authoring options fetched',
    data: result,
  });
});

export const getEligibleQuestions = catchAsync(async (req: Request, res: Response) => {
  const result = await ExamAdminService.listEligibleQuestions({
    subjectId: req.query.subject_id,
    chapterId: req.query.chapter_id,
    limit: req.query.limit,
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Eligible questions fetched',
    data: result,
  });
});

export const punishUser = catchAsync(async (req: Request, res: Response) => {
  const adminId = (req as any).user?.id;
  const result = await ExamAdminService.punishUser(req.body, adminId, (req as any).accessToken);
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: `User punished: ${req.body?.action}`,
    data: result,
  });
});

export const getLiveProgress = catchAsync(async (req: Request, res: Response) => {
  const result = await ExamAdminService.getLiveProgress(req.params.id);
  sendResponse(res, { statusCode: 200, success: true, data: result });
});

export const getLeaderboard = catchAsync(async (req: Request, res: Response) => {
  const result = await ExamAdminService.getLeaderboard(req.params.id);
  sendResponse(res, { statusCode: 200, success: true, data: result });
});

export const recoverSession = catchAsync(async (req: Request, res: Response) => {
  const adminId = (req as any).user?.id;
  const progressId = req.body?.progressId ?? req.body?.progress_id ?? req.params?.id;
  const extendMinutes = req.body?.extend_minutes ?? req.body?.extendMinutes;

  const result = await ExamAdminService.recoverSession(progressId, extendMinutes, adminId);
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Attempt extended',
    data: result,
  });
});
