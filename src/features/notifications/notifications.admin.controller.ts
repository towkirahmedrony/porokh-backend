import { Request, Response } from 'express';
import sendResponse from '../../lib/utils/response';
import * as NotificationAdminService from './notifications.admin.service';
import { NotificationAdminError } from './notifications.admin.rules';

/**
 * Admin notification endpoints.
 *
 * Errors are answered here rather than in the global handler so a validation
 * failure keeps its 400/404/409 status instead of becoming a 500.
 */
const handle = async (
  res: Response,
  work: () => Promise<unknown>,
  statusCode: number,
  message: string
): Promise<void> => {
  try {
    const data = await work();
    sendResponse(res, { statusCode, success: true, message, data });
  } catch (error) {
    const status = error instanceof NotificationAdminError ? error.statusCode : 500;
    if (status >= 500) {
      console.error('[notify:admin] request failed:', error);
    }
    sendResponse(res, {
      statusCode: status,
      success: false,
      message: error instanceof Error ? error.message : 'Notification request failed',
    });
  }
};

export const createCampaign = async (req: Request, res: Response): Promise<void> =>
  handle(
    res,
    () => NotificationAdminService.createCampaign(req.body, req.user!.id),
    201,
    'Notification created'
  );

export const listCampaigns = async (req: Request, res: Response): Promise<void> =>
  handle(
    res,
    () => NotificationAdminService.listCampaigns(req.query),
    200,
    'Notifications fetched successfully'
  );

export const getCampaign = async (req: Request, res: Response): Promise<void> =>
  handle(
    res,
    () => NotificationAdminService.getCampaignDetail(req.params.id),
    200,
    'Notification fetched successfully'
  );

export const updateCampaign = async (req: Request, res: Response): Promise<void> =>
  handle(
    res,
    () => NotificationAdminService.updateCampaign(req.params.id, req.body, req.user!.id),
    200,
    'Notification updated successfully'
  );

export const cancelCampaign = async (req: Request, res: Response): Promise<void> =>
  handle(
    res,
    () => NotificationAdminService.cancelCampaign(req.params.id, req.user!.id),
    200,
    'Notification cancelled successfully'
  );

export const sendCampaign = async (req: Request, res: Response): Promise<void> =>
  handle(
    res,
    () => NotificationAdminService.sendCampaign(req.params.id, req.user!.id),
    200,
    'Notification sent'
  );

export const retryCampaign = async (req: Request, res: Response): Promise<void> =>
  handle(
    res,
    () => NotificationAdminService.retryCampaign(req.params.id, req.user!.id),
    200,
    'Notification retried'
  );

export const deleteCampaign = async (req: Request, res: Response): Promise<void> =>
  handle(
    res,
    () => NotificationAdminService.deleteCampaign(req.params.id, req.user!.id),
    200,
    'Notification deleted'
  );

export const previewAudience = async (req: Request, res: Response): Promise<void> =>
  handle(
    res,
    () => NotificationAdminService.previewAudience(req.body),
    200,
    'Audience preview generated'
  );

export const getStats = async (req: Request, res: Response): Promise<void> =>
  handle(
    res,
    () => NotificationAdminService.getStats(req.query),
    200,
    'Notification analytics fetched successfully'
  );
