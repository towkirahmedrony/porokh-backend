import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import {
  BookmarkError,
  getBookmarkQuestionIds,
  setBookmark,
} from './exam.bookmark.service';

const getAuthUserId = (req: Request): string => {
  const userId = (req as any).user?.id;

  if (!userId) {
    throw new BookmarkError('Unauthorized', 401);
  }

  return userId;
};

export const getBookmarks = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const questionIds = await getBookmarkQuestionIds(
    userId,
    req.query.questionIds
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Bookmarks fetched',
    data: { question_ids: questionIds },
  });
});

export const updateBookmark = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const result = await setBookmark(
    userId,
    req.body?.questionId,
    req.body?.bookmarked
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: result.bookmarked ? 'Bookmark saved' : 'Bookmark removed',
    data: result,
  });
});
