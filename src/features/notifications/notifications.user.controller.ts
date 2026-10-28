import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import * as NotificationUserService from './notifications.user.service';
import * as NotificationService from './notifications.service';

export const getUserNotifications = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const notifications = await NotificationUserService.getUserNotifications(userId);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Notifications fetched successfully',
    data: notifications,
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

  await NotificationUserService.markNotificationAsRead(userId, notificationId, isClicked);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Notification marked as read',
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
