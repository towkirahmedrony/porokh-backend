import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import * as NotificationUserService from './notifications.user.service';
import * as NotificationService from './notifications.service';

export const getUserNotifications = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const page = await NotificationUserService.getUserNotifications(userId, {
    limit: req.query.limit,
    before: req.query.before,
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Notifications fetched successfully',
    data: { items: page.items, next_cursor: page.next_cursor },
  });
});

export const getUnreadCount = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const count = await NotificationUserService.getUnreadCount(userId);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Unread notification count fetched successfully',
    data: { count },
  });
});

export const markAsRead = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const notificationId = req.body.notification_id ?? req.params.id;
  const isClicked = Boolean(req.body.is_clicked);
  const platform = req.body.platform ?? req.body.device_platform ?? null;

  await NotificationUserService.markNotificationAsRead(
    userId,
    notificationId,
    isClicked,
    platform
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Notification marked as read',
  });
});

export const markAsClicked = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const notificationId = req.params.id ?? req.body.notification_id;
  const platform = req.body?.platform ?? req.body?.device_platform ?? null;

  await NotificationUserService.markNotificationAsRead(userId, notificationId, true, platform);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Notification marked as clicked',
  });
});

export const markAllAsRead = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const updated = await NotificationService.markAllNotificationsAsRead(userId);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'All notifications marked as read',
    data: { updated },
  });
});

export const getPreferences = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const preferences = await NotificationService.getNotificationPreferences(userId);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Notification preferences fetched successfully',
    data: preferences,
  });
});

export const updatePreferences = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const preferences = await NotificationService.updateNotificationPreferences(userId, req.body);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Notification preferences updated successfully',
    data: preferences,
  });
});
