import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import { AdmissionError } from './admissions.errors';
import { AdmissionStudentService } from './admissions.student.service';
import { parseAdmissionId, parseAdmissionPracticeInput } from './admissions.validation';

const getAuthUserId = (req: Request): string => {
  const userId = (req as any).user?.id;

  if (!userId) throw new AdmissionError('Unauthorized', 401);

  return userId;
};

/** Unit screen for the student app: past papers by session, model tests, subjects. */
export const getUnitContent = catchAsync(async (req: Request, res: Response) => {
  const unitId = parseAdmissionId(req.params.unitId, 'admission unit id');
  const content = await AdmissionStudentService.getUnitContent(unitId);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Admission unit content fetched successfully',
    data: content,
  });
});

/** Starts a repeatable subject practice attempt from the unit's own question pool. */
export const startSubjectPractice = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const unitId = parseAdmissionId(req.params.unitId, 'admission unit id');
  const payload = parseAdmissionPracticeInput(req.body);
  const attempt = await AdmissionStudentService.startSubjectPractice(userId, unitId, payload);

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Admission practice started successfully',
    data: attempt,
  });
});
