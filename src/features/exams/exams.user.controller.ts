import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import { ExamUserService } from './exams.user.service';
import { ExamAttemptError, ExamAttemptService } from './exam.attempt.service';
import { ExamPracticeService } from './exam.practice.service';
import { incrementStreakOnExamSubmit } from '../growth/streak.service';
import { awardGroupXpToActiveGroups } from '../groups/groups.xp';

const getAuthUserId = (req: Request): string => {
  const userId = (req as any).user?.id;

  if (!userId) {
    throw new ExamAttemptError('Unauthorized', 401);
  }

  return userId;
};

export const generateExam = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const result = await ExamUserService.generateExam(userId, req.body);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Exam generated',
    data: result,
  });
});

export const getArena = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 100);
  const subjectSlug = req.query.subjectSlug as string | undefined;

  const result = await ExamUserService.getArenaQuestions(userId, limit, subjectSlug);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Arena questions fetched',
    data: result,
  });
});

/**
 * Legacy endpoint, retired (410 Gone).
 * Client-supplied scores are never persisted; use POST /exams/user/submit.
 */
export const submitHistory = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  await ExamUserService.submitHistory(userId, req.body);

  sendResponse(res, {
    statusCode: 410,
    success: false,
    message: 'Legacy exam history submission is retired',
    data: null,
  });
});

/** Starts (or resumes) the authoritative server-side attempt for an exam. */
export const startAttempt = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const result = await ExamAttemptService.startExamAttempt(userId, req.body?.exam_id);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Exam attempt started',
    data: result,
  });
});

/** Starts an untracked-content practice attempt with a server-side deadline. */
export const startPracticeAttempt = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const result = await ExamAttemptService.startPracticeAttempt(
    userId,
    req.body?.question_ids
  );

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Practice attempt started',
    data: result,
  });
});

export const getAttemptState = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const result = await ExamAttemptService.getAttemptState(userId, req.params.id);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Attempt state fetched',
    data: result,
  });
});

export const saveAttemptAnswers = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const result = await ExamAttemptService.saveDraftAnswers(
    userId,
    req.params.id,
    req.body?.answers,
    req.body?.current_question_index
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Draft answers saved',
    data: result,
  });
});

export const getAttemptQuestions = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const result = await ExamUserService.getAttemptQuestions(userId, req.params.id);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Attempt questions fetched',
    data: result,
  });
});

/** Reveals one answer immediately for an untimed wrong+skipped quiz attempt. */
export const answerPracticeQuestion = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const result = await ExamPracticeService.answerPracticeQuestion(
    userId,
    req.params.attemptId,
    req.body?.question_id,
    req.body?.selected_option
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Answer revealed',
    data: result,
  });
});

/** Available unique wrong questions across the student's history. */
export const getMistakePool = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const result = await ExamPracticeService.getMistakePool(userId);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Mistake pool fetched',
    data: result,
  });
});

/** Starts/resumes a retake of one historical result. */
export const startRetakePractice = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const result = await ExamPracticeService.startRetake(
    userId,
    req.body?.history_id,
    req.body?.confirm_partial === true
  );

  sendResponse(res, {
    statusCode: result.started ? 201 : 200,
    success: true,
    message: result.started ? 'Retake started' : 'Retake preview',
    data: result,
  });
});

/** Starts/resumes practice of the wrong questions in one historical result. */
export const startWrongPractice = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const result = await ExamPracticeService.startWrongFromHistory(
    userId,
    req.body?.history_id
  );

  sendResponse(res, {
    statusCode: result.started ? 201 : 200,
    success: true,
    message: result.started ? 'Wrong-question practice started' : 'Wrong-question preview',
    data: result,
  });
});

/** Starts/resumes global mistake practice from the student's unique mistake pool. */
export const startMistakePractice = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const result = await ExamPracticeService.startMistakePractice(
    userId,
    req.body?.count,
    req.body?.confirm_reduced === true
  );

  sendResponse(res, {
    statusCode: result.started ? 201 : 200,
    success: true,
    message: result.started ? 'Mistake practice started' : 'Mistake practice preview',
    data: result,
  });
});

export const submitExam = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);

  const result = await ExamUserService.submitExamResult({
    ...req.body,
    user_id: userId,
  });

  // A duplicate submission is not a new study event and must not extend the
  // user's streak. The result is already persisted at this point, so a streak
  // failure must never turn a successful submission into a 500: it is logged
  // (without tokens or answer data) and the saved result is returned.
  if (!(result as any)?.duplicate) {
    // Streak/XP side effects are not part of the submission result. Run them
    // after the response path so a first study session of the day (which may
    // perform several writes) never delays the student's result.
    void incrementStreakOnExamSubmit(userId).catch((streakError) => {
      console.error('[exam:streak] failed to update streak after a saved result', {
        userId,
        message: streakError instanceof Error ? streakError.message : 'unknown error',
      });
    });

    // Mirror the exact XP that was saved into every active group. This is
    // fire-and-forget: group XP must never fail or delay an exam submission.
    const earnedXp = Number((result as any)?.earned_xp ?? 0);
    if (earnedXp > 0) {
      void awardGroupXpToActiveGroups(userId, earnedXp);
    }
  }

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Exam submitted',
    data: result,
  });
});

export const getExamResult = catchAsync(async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const result = await ExamUserService.getExamResult(userId, req.params.id);

  if (!result) {
    res.status(404).json({
      success: false,
      message: 'Exam result not found',
      data: null,
    });
    return;
  }

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Exam result fetched',
    data: result,
  });
});

export const createGroupBattle = catchAsync(async (req: Request, res: Response) => {
  const challengerId = getAuthUserId(req);
  const { opponentId, ...examData } = req.body;

  if (!opponentId) {
    throw new ExamAttemptError('অপোনেন্টের আইডি প্রয়োজন!', 400);
  }

  const result = await ExamUserService.createGroupBattleExam(challengerId, opponentId, examData);

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'ব্যাটল এক্সাম সফলভাবে তৈরি হয়েছে',
    data: result,
  });
});
