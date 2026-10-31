import { Request, Response } from 'express';
import * as institutionService from './institution.service';
import { parseAdmissionId } from '../admissions/admissions.validation';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';

export const createInstitution = catchAsync(async (req: Request, res: Response) => {
  const result = await institutionService.createInstitution(req.body);
  sendResponse(res, { statusCode: 201, success: true, message: 'Institution created successfully', data: result });
});

export const updateInstitution = catchAsync(async (req: Request, res: Response) => {
  const result = await institutionService.updateInstitution(req.params.id, req.body);
  sendResponse(res, { statusCode: 200, success: true, message: 'Institution updated successfully', data: result });
});

export const deleteInstitution = catchAsync(async (req: Request, res: Response) => {
  await institutionService.deleteInstitution(req.params.id);
  sendResponse(res, { statusCode: 200, success: true, message: 'Institution deleted successfully' });
});

export const getInstitutionAdmissionUnits = catchAsync(async (req: Request, res: Response) => {
  const institutionId = parseAdmissionId(req.params.id, 'institution id');
  const units = await institutionService.getInstitutionAdmissionUnits(institutionId);
  sendResponse(res, { statusCode: 200, success: true, message: 'Admission units retrieved', data: units });
});
