import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import * as NotificationAdminService from './notifications.admin.service';

// --- Campaigns ---
export const createCampaign = catchAsync(async (req: Request, res: Response) => {
  const adminId = req.user!.id; 
  const campaign = await NotificationAdminService.createCampaign(req.body, adminId);
  sendResponse(res, { statusCode: 201, success: true, message: 'Campaign deployed successfully', data: campaign });
});
export const getCampaigns = catchAsync(async (req: Request, res: Response) => {
  const campaigns = await NotificationAdminService.getCampaigns();
  sendResponse(res, { statusCode: 200, success: true, message: 'Campaigns fetched successfully', data: campaigns });
});
export const cancelCampaign = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  const campaign = await NotificationAdminService.cancelCampaign(id);
  sendResponse(res, { statusCode: 200, success: true, message: 'Campaign cancelled successfully', data: campaign });
});
export const updateCampaign = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  const campaign = await NotificationAdminService.updateCampaign(id, req.body);
  sendResponse(res, { statusCode: 200, success: true, message: 'Campaign updated successfully', data: campaign });
});
export const deleteCampaign = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  const campaign = await NotificationAdminService.deleteCampaign(id);
  sendResponse(res, { statusCode: 200, success: true, message: 'Campaign deleted successfully', data: campaign });
});
