import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import * as levelService from './question.level.service';
import { LevelFilterValidationError, parseLevelFilter } from './question.level';

const actorId = (req: Request): string | undefined => (req as any).user?.id;

const readTrackList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

/**
 * Resolves the level and track a question list request asked for. Exported
 * because the list handler needs the same answer, and a second copy of this
 * parsing is how two screens drift apart.
 */
export const resolveLevelFilter = (query: Request['query']) =>
  parseLevelFilter(query.level, query.track);

export const getQuestionLevelReport = catchAsync(async (_req: Request, res: Response) => {
  const report = await levelService.getLevelReport();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Question level report retrieved',
    data: report,
  });
});

export const getQuestionTracks = catchAsync(async (req: Request, res: Response) => {
  const [tracks] = await levelService.getQuestionTracks([req.params.id]);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Question tracks retrieved',
    data: tracks ?? { questionId: req.params.id, tracks: [] },
  });
});

export const updateQuestionTracks = catchAsync(async (req: Request, res: Response) => {
  const questionId = req.params.id;
  const add = readTrackList(req.body?.add ?? req.body?.tracks);
  const remove = readTrackList(req.body?.remove);

  const result = await levelService.setQuestionTracksBulk([questionId], add, remove);

  await levelService.recordLevelAudit(actorId(req), 'question.tracks.set', questionId, {
    add: result.added,
    remove: result.removed,
  });

  const [tracks] = await levelService.getQuestionTracks([questionId]);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Question tracks updated',
    data: tracks ?? { questionId, tracks: [] },
  });
});

export const bulkUpdateQuestionTracks = catchAsync(async (req: Request, res: Response) => {
  const questionIds = readTrackList(req.body?.questionIds);
  const add = readTrackList(req.body?.add);
  const remove = readTrackList(req.body?.remove);

  if (questionIds.length === 0) {
    throw new LevelFilterValidationError('questionIds must contain at least one id.');
  }

  const result = await levelService.setQuestionTracksBulk(questionIds, add, remove);

  await levelService.recordLevelAudit(actorId(req), 'question.tracks.bulk_set', null, {
    count: result.questionIds.length,
    add: result.added,
    remove: result.removed,
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Question tracks updated',
    data: result,
  });
});
