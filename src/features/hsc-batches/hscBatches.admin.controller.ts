import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import * as HscBatchesService from './hscBatches.admin.service';
import { parseBatchYear, parseCreateBatchBody, parseUpdateBatchBody } from './hscBatches.validation';
import { HscBatchesError } from './hscBatches.types';

const actorOf = (req: Request): string => {
  const actorId = req.user?.id;
  if (!actorId) throw new HscBatchesError('Administrator identity is required', 401);
  return actorId;
};

export const getBatches = catchAsync(async (_req: Request, res: Response) => {
  const batches = await HscBatchesService.listBatches();
  sendResponse(res, 200, true, 'HSC batches retrieved', { batches });
});

export const createBatch = catchAsync(async (req: Request, res: Response) => {
  const input = parseCreateBatchBody(req.body);
  const batch = await HscBatchesService.createBatch(actorOf(req), input);
  sendResponse(res, 201, true, 'HSC batch created', batch);
});

export const updateBatch = catchAsync(async (req: Request, res: Response) => {
  const year = parseBatchYear(req.params.year);
  const patch = parseUpdateBatchBody(req.body);
  const batch = await HscBatchesService.updateBatch(actorOf(req), year, patch);
  sendResponse(res, 200, true, 'HSC batch updated', batch);
});
