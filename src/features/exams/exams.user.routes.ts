import { Router } from 'express';
import {
  generateExam,
  submitExam,
  getArena,
  getExamResult,
  submitHistory,
  createGroupBattle,
  startAttempt,
  startPracticeAttempt,
  getAttemptState,
  saveAttemptAnswers,
  getAttemptQuestions,
  getMistakePool,
  startRetakePractice,
  startWrongPractice,
  startMistakePractice,
  answerPracticeQuestion,
} from './exams.user.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rateLimit } from '../../middlewares/rateLimit';

const router = Router();

// Question retrieval is limited per authenticated user to make bulk harvesting
// of the published question bank expensive even for a valid account.
const questionReadLimit = rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'exam-questions' });
const submissionLimit = rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'exam-submit' });
// Autosave must stay permissive enough for legitimate retries after a network
// drop, but it still cannot extend a deadline (see ExamAttemptService).
const answerSaveLimit = rateLimit({ windowMs: 60_000, max: 180, keyPrefix: 'exam-answers' });
const practiceAnswerLimit = rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'practice-answer' });

router.post('/generate', requireAuth, questionReadLimit, generateExam);
router.get('/arena', requireAuth, questionReadLimit, getArena);

// Authoritative attempt lifecycle. Start is idempotent and never resets the
// server-side deadline of an existing in-progress attempt.
router.post('/attempts/start', requireAuth, submissionLimit, startAttempt);
router.post('/attempts/practice', requireAuth, submissionLimit, startPracticeAttempt);

// Practice modes build their question set server-side from the student's own
// history. The source id is always scoped by requireAuth + the database RPC's
// p_user_id, never by a client-supplied user.
router.get('/practice/mistakes', requireAuth, questionReadLimit, getMistakePool);
router.post('/practice/retake', requireAuth, submissionLimit, startRetakePractice);
router.post('/practice/wrong', requireAuth, submissionLimit, startWrongPractice);
router.post('/practice/mistakes', requireAuth, submissionLimit, startMistakePractice);
router.post('/practice/:attemptId/answer', requireAuth, practiceAnswerLimit, answerPracticeQuestion);
router.get('/attempts/:id', requireAuth, getAttemptState);
router.get('/attempts/:id/questions', requireAuth, questionReadLimit, getAttemptQuestions);
router.patch('/attempts/:id/answers', requireAuth, answerSaveLimit, saveAttemptAnswers);

// Owner-scoped attempt review (question text/options resolved server-side)
router.get('/result/:id', requireAuth, getExamResult);

// Retired legacy route: client-supplied scores are no longer accepted (410).
router.post('/history', requireAuth, submissionLimit, submitHistory);

// Main secure submit route (requires a server-issued attempt id / exam attempt)
router.post('/submit', requireAuth, submissionLimit, submitExam);

router.post('/group-battle', requireAuth, submissionLimit, createGroupBattle);

export const ExamUserRoutes = router;
