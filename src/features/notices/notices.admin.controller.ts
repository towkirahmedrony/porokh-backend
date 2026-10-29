import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import * as NoticeService from './notices.service';
import {
  parseNoticeCreate,
  parseNoticeId,
  parseNoticePublish,
  parseNoticeStatus,
  parseNoticeUpdate,
} from './notices.validation';
import { NoticeWritePayload } from './notices.types';

export const listNotices = catchAsync(async (_req: Request, res: Response) => {
  const notices = await NoticeService.listAllNotices();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'All notices fetched successfully',
    data: notices,
  });
});

export const getNotice = catchAsync(async (req: Request, res: Response) => {
  const noticeId = parseNoticeId(req.params.id);
  const notice = await NoticeService.getNoticeById(noticeId);

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

export const createNotice = catchAsync(async (req: Request, res: Response) => {
  const payload = parseNoticeCreate(req.body) as NoticeWritePayload;
  const notice = await NoticeService.createNotice(payload, req.user!.id);

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Notice created successfully',
    data: notice,
  });
});

export const updateNotice = catchAsync(async (req: Request, res: Response) => {
  const noticeId = parseNoticeId(req.params.id);
  const payload = parseNoticeUpdate(req.body) as NoticeWritePayload;
  const notice = await NoticeService.updateNotice(noticeId, payload);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Notice updated successfully',
    data: notice,
  });
});

export const publishNotice = catchAsync(async (req: Request, res: Response) => {
  const noticeId = parseNoticeId(req.params.id);
  const payload = parseNoticePublish(req.body);
  const notice = await NoticeService.publishNotice(
    noticeId,
    payload.published_at,
    payload.also_notify === true
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Notice published successfully',
    data: notice,
  });
});

export const expireNotice = catchAsync(async (req: Request, res: Response) => {
  const noticeId = parseNoticeId(req.params.id);
  const notice = await NoticeService.expireNotice(noticeId);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Notice expired successfully',
    data: notice,
  });
});

export const setNoticeStatus = catchAsync(async (req: Request, res: Response) => {
  const noticeId = parseNoticeId(req.params.id);
  const payload = parseNoticeStatus(req.body);
  const notice = await NoticeService.setNoticeActive(noticeId, payload.is_active);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: payload.is_active ? 'Notice activated' : 'Notice deactivated',
    data: notice,
  });
});

export const deleteNotice = catchAsync(async (req: Request, res: Response) => {
  const noticeId = parseNoticeId(req.params.id);
  await NoticeService.deleteNotice(noticeId);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Notice deleted successfully',
  });
});
