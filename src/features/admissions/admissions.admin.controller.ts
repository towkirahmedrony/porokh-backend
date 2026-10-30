import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import { AdmissionAdminService } from './admissions.admin.service';
import {
  parseAdmissionId,
  parseAdmissionUnitStatus,
  parseCreateAdmissionUnit,
  parseUpdateAdmissionUnit,
} from './admissions.validation';

export const listUniversities = catchAsync(async (_req: Request, res: Response) => {
  const universities = await AdmissionAdminService.listUniversities();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Admission universities fetched successfully',
    data: universities,
  });
});

export const listUnits = catchAsync(async (req: Request, res: Response) => {
  const universityId = parseAdmissionId(req.params.universityId, 'university id');
  const result = await AdmissionAdminService.listUnits(universityId);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Admission units fetched successfully',
    data: result,
  });
});

export const createUnit = catchAsync(async (req: Request, res: Response) => {
  const universityId = parseAdmissionId(req.params.universityId, 'university id');
  const payload = parseCreateAdmissionUnit(req.body);
  const actorId = (req as any).user?.id;
  const unit = await AdmissionAdminService.createUnit(universityId, payload, actorId);

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Admission unit created successfully',
    data: unit,
  });
});

export const updateUnit = catchAsync(async (req: Request, res: Response) => {
  const unitId = parseAdmissionId(req.params.unitId, 'admission unit id');
  const payload = parseUpdateAdmissionUnit(req.body);
  const actorId = (req as any).user?.id;
  const unit = await AdmissionAdminService.updateUnit(unitId, payload, actorId);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Admission unit updated successfully',
    data: unit,
  });
});

export const setUnitStatus = catchAsync(async (req: Request, res: Response) => {
  const unitId = parseAdmissionId(req.params.unitId, 'admission unit id');
  const { is_active } = parseAdmissionUnitStatus(req.body);
  const actorId = (req as any).user?.id;
  const unit = await AdmissionAdminService.setUnitStatus(unitId, is_active, actorId);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: is_active ? 'Admission unit activated' : 'Admission unit deactivated',
    data: unit,
  });
});

export const deleteUnit = catchAsync(async (req: Request, res: Response) => {
  const unitId = parseAdmissionId(req.params.unitId, 'admission unit id');
  const actorId = (req as any).user?.id;
  const unit = await AdmissionAdminService.deleteUnit(unitId, actorId);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Admission unit deleted successfully',
    data: unit,
  });
});
