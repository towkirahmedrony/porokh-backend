import { Router } from 'express';
import { 
  getAllExams, getExamDetails, deleteExam, togglePublish, 
  autoFetchQuestions, punishUser, getLiveProgress, 
  getLeaderboard, recoverSession, createExam, updateExam,
  getEligibleQuestions, getAuthoringOptions, getExamOverview
} from './exams.admin.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rbacGuard } from '../../middlewares/rbacGuard';
import { requirePermission } from '../../middlewares/requirePermission';
import { PERMISSIONS } from '../../middlewares/authorization';

const router = Router();

// প্রোডাকশনে যাওয়ার সময় এই মিডলওয়্যারগুলো আনকমেন্ট করে দেবেন
router.use(requireAuth, rbacGuard(['admin']), requirePermission(PERMISSIONS.EXAMS_MANAGE));

// জেনারেল রাউটস
router.get('/', getAllExams);
router.post('/', createExam);
router.post('/auto-fetch', autoFetchQuestions);
router.post('/punish', requirePermission(PERMISSIONS.USER_MANAGE), punishUser);
router.post('/recover-session', recoverSession);

// Static paths must be registered before `/:id`, otherwise Express would treat
// "eligible-questions" as an exam id.
router.get('/overview', getExamOverview);
router.get('/authoring-options', getAuthoringOptions);
router.get('/eligible-questions', getEligibleQuestions);

// ID নির্ভর রাউটস
router.get('/:id', getExamDetails);
router.patch('/:id', updateExam);
router.delete('/:id', deleteExam);
router.patch('/:id/publish', togglePublish);
router.get('/:id/live-progress', getLiveProgress);
router.get('/:id/leaderboard', getLeaderboard);

export const ExamAdminRoutes = router;
