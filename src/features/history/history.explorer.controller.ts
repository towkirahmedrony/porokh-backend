import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import * as explorerService from './history.explorer.service';
import { loadReviewQuestions } from './history.service';
import { ExamPracticeService } from '../exams/exam.practice.service';

const currentUserId = (req: Request): string => (req as any).user.id;

export const getExplorer = catchAsync(async (req: Request, res: Response) => {
  const source = explorerService.parseExplorerSource(req.query.source);
  const filters = explorerService.parseExplorerFilters(req.query.filters);
  const sort = explorerService.parseExplorerSort(req.query.sort);
  const limit = Number(req.query.limit ?? explorerService.EXPLORER_PAGE_SIZE);
  const offset = Number(req.query.offset ?? 0);

  const page = await explorerService.getExplorerPage({
    userId: currentUserId(req),
    source,
    filters,
    sort,
    limit,
    offset,
    loadQuestions: loadReviewQuestions,
  });

  res.status(200).json({ success: true, data: page });
});

export const getExplorerFacets = catchAsync(async (req: Request, res: Response) => {
  const source = explorerService.parseExplorerSource(req.query.source);
  const filters = explorerService.parseExplorerFilters(req.query.filters);

  const facets = await explorerService.getExplorerFacets(
    currentUserId(req),
    source,
    filters
  );

  res.status(200).json({ success: true, data: { facets } });
});

export const getExplorerCount = catchAsync(async (req: Request, res: Response) => {
  const source = explorerService.parseExplorerSource(req.query.source);
  const filters = explorerService.parseExplorerFilters(req.query.filters);

  const count = await explorerService.countExplorerQuestions(
    currentUserId(req),
    source,
    filters
  );

  res.status(200).json({ success: true, data: count });
});

export const startExplorerPractice = catchAsync(async (req: Request, res: Response) => {
  const source = explorerService.parseExplorerSource(req.body?.source);
  const filters = explorerService.parseExplorerFilters(req.body?.filters);

  const result = await ExamPracticeService.startExplorerPractice(
    currentUserId(req),
    source,
    filters as Record<string, unknown>,
    req.body?.count,
    Boolean(req.body?.confirm_reduced)
  );

  res.status(200).json({ success: true, data: result });
});

export const getDismissedMistakes = catchAsync(async (req: Request, res: Response) => {
  const rows = await explorerService.getDismissedMistakes(currentUserId(req));
  res.status(200).json({ success: true, data: rows });
});

export const restoreDismissedMistakes = catchAsync(
  async (req: Request, res: Response) => {
    const ids = Array.isArray(req.body?.question_ids) ? req.body.question_ids : [];
    const restored = await explorerService.restoreDismissedMistakes(
      currentUserId(req),
      ids
    );

    res.status(200).json({ success: true, data: { restored } });
  }
);

export const updateBookmarkNote = catchAsync(async (req: Request, res: Response) => {
  const note = await explorerService.updateBookmarkNote(
    currentUserId(req),
    req.params.id,
    req.body?.note
  );

  res.status(200).json({ success: true, data: note });
});

export const createBookmark = catchAsync(async (req: Request, res: Response) => {
  const bookmark = await explorerService.recreateBookmark(
    currentUserId(req),
    req.body?.question_id,
    req.body?.note
  );

  res.status(200).json({ success: true, data: bookmark });
});
