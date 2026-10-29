import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import * as NoticeService from './notices.service';
import { parseNoticeId, parseNoticeListQuery } from './notices.validation';

export const listNotices = catchAsync(async (req: Request, res: Response) => {
  const query = parseNoticeListQuery(req.query);
  const result = await NoticeService.listNoticesForUser(req.user!.id, {
    limit: query.limit,
    offset: query.offset,
    priority: query.priority,
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Notices fetched successfully',
    data: result,
  });
});

export const getUnreadCount = catchAsync(async (req: Request, res: Response) => {
  const count = await NoticeService.getUnreadNoticeCount(req.user!.id);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Unread notice count fetched successfully',
    data: { count },
  });
});

export const getUrgentNotice = catchAsync(async (req: Request, res: Response) => {
  const notice = await NoticeService.getUrgentNoticeForUser(req.user!.id);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Urgent notice fetched successfully',
    data: notice,
  });
});

export const getNotice = catchAsync(async (req: Request, res: Response) => {
  const noticeId = parseNoticeId(req.params.id);
  const notice = await NoticeService.getNoticeForUser(req.user!.id, noticeId);

  if (!notice) {
    return sendResponse(res, {
      statusCode: 404,
      success: false,
      message: 'Notice not found',
      data: null,
    });
  }

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Notice fetched successfully',
    data: notice,
  });
});

export const markRead = catchAsync(async (req: Request, res: Response) => {
  const noticeId = parseNoticeId(req.params.id);
  await NoticeService.markNoticeRead(req.user!.id, noticeId);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Notice marked as read',
  });
});

export const dismiss = catchAsync(async (req: Request, res: Response) => {
  const noticeId = parseNoticeId(req.params.id);
  await NoticeService.dismissNotice(req.user!.id, noticeId);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Notice dismissed',
  });
});
