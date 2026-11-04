import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import * as NotificationService from './notifications.service';

const getClientIp = (req: Request): string | null => {
  const forwardedFor = req.headers['x-forwarded-for'];

  if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    return forwardedFor.split(',')[0].trim();
  }

  const realIp = req.headers['x-real-ip'];

  if (typeof realIp === 'string' && realIp.length > 0) {
    return realIp;
  }

  return req.ip || req.socket.remoteAddress || null;
};

export const removeDeviceToken = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const deviceId = req.body?.device_id ?? req.query?.device_id ?? req.params?.deviceId;

  await NotificationService.deactivateUserDeviceToken(userId, String(deviceId ?? ''));

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Device token removed successfully',
  });
});

export const updateDeviceToken = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const ipAddress = getClientIp(req);

  await NotificationService.saveUserDeviceToken(userId, {
    ...req.body,
    ip_address: ipAddress,
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Device token updated successfully',
    data: { ip_address: ipAddress },
  });
});
