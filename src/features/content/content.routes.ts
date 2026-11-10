import { Router, Request, Response } from 'express';
import * as contentController from './content.controller';
import { parseQuestionTextHandler } from './question.textparse.controller';
import { importQuestionTextHandler } from './question.textimport.controller';
import * as institutionController from './institution.controller';
import * as institutionService from './institution.service';
import { requireAuth } from '../../middlewares/requireAuth';
import { rbacGuard } from '../../middlewares/rbacGuard';
import { requirePermission } from '../../middlewares/requirePermission';
import { PERMISSIONS } from '../../middlewares/authorization';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';

const router = Router();

router.use(requireAuth);
router.get('/study-materials', contentController.getStudyMaterials);

// ==========================================
// 🚀 ADDED: Institutions Route
// ==========================================
router.get('/institutions', rbacGuard(['admin', 'moderator', 'teacher']), catchAsync(async (req: Request, res: Response) => {
  const institutions = await institutionService.getInstitutions();
  sendResponse(res, { statusCode: 200, success: true, message: 'Institutions retrieved', data: institutions });
}));

router.get('/institutions/:id/admission-units', rbacGuard(['admin', 'moderator', 'editor', 'teacher']), institutionController.getInstitutionAdmissionUnits);

router.post('/institutions', rbacGuard(['admin']), requirePermission(PERMISSIONS.QUESTIONS_MANAGE), institutionController.createInstitution);
router.put('/institutions/:id', rbacGuard(['admin']), requirePermission(PERMISSIONS.QUESTIONS_MANAGE), institutionController.updateInstitution);
router.delete('/institutions/:id', rbacGuard(['admin']), requirePermission(PERMISSIONS.QUESTIONS_MANAGE), institutionController.deleteInstitution);

router.get('/curriculum', contentController.getCurriculumTree);
router.get('/taxonomy/subjects', contentController.getTaxonomySubjects);
router.get('/taxonomy/chapters', contentController.getTaxonomyChapters);
router.get('/taxonomy/topics', contentController.getTaxonomyTopics);

router.post('/curriculum/manage', rbacGuard(['admin']), requirePermission(PERMISSIONS.QUESTIONS_MANAGE), contentController.manageCurriculum);

router.post('/comprehensions', rbacGuard(['admin', 'editor', 'teacher']), requirePermission(PERMISSIONS.QUESTIONS_MANAGE), contentController.createComprehension);
router.get('/comprehensions/search', rbacGuard(['admin', 'editor', 'teacher']), requirePermission(PERMISSIONS.QUESTIONS_MANAGE), contentController.searchComprehensions);

router.get('/questions/audit', rbacGuard(['admin', 'moderator']), requirePermission(PERMISSIONS.QUESTIONS_REVIEW), contentController.getQuestionsForAudit);
router.patch('/questions/:id/status', rbacGuard(['admin', 'moderator']), requirePermission(PERMISSIONS.QUESTIONS_REVIEW), contentController.updateAuditQuestionStatus);
router.get('/questions/:id/verifications', rbacGuard(['admin', 'moderator']), requirePermission(PERMISSIONS.QUESTIONS_REVIEW), contentController.getQuestionVerifications);
router.patch('/questions/:id/verifications/:stage', rbacGuard(['admin', 'moderator']), requirePermission(PERMISSIONS.QUESTIONS_REVIEW), contentController.updateQuestionVerification);

// ==========================================
// Question Bank Routes
// ==========================================
router.get('/questions', rbacGuard(['admin', 'moderator']), requirePermission(PERMISSIONS.QUESTIONS_REVIEW), contentController.getQuestionsBank);
router.delete('/questions/:id/hard', rbacGuard(['admin']), requirePermission(PERMISSIONS.QUESTIONS_MANAGE), contentController.hardDeleteQuestion);

router.post('/questions', rbacGuard(['admin', 'editor', 'teacher']), requirePermission(PERMISSIONS.QUESTIONS_MANAGE), contentController.createQuestion);
router.post('/questions/bulk', rbacGuard(['admin', 'editor', 'teacher']), requirePermission(PERMISSIONS.QUESTIONS_MANAGE), contentController.bulkCreateQuestions);

// AI Question Importer: duplicate-aware batch import and its history.
// Same author roles and permission as the admin panel's bulk upload.
router.post('/questions/import', rbacGuard(['admin', 'editor', 'teacher']), requirePermission(PERMISSIONS.QUESTIONS_MANAGE), contentController.importQuestions);
router.get('/questions/import-history', rbacGuard(['admin', 'editor', 'teacher']), requirePermission(PERMISSIONS.QUESTIONS_MANAGE), contentController.getQuestionImportHistory);

// Plain text -> question JSON preview for the importer (no database writes).
router.post('/questions/parse-text', rbacGuard(['admin', 'editor', 'teacher']), requirePermission(PERMISSIONS.QUESTIONS_MANAGE), parseQuestionTextHandler);

// Final approved plain text -> database. The importer never sends question JSON.
router.post('/questions/import-text', rbacGuard(['admin', 'editor', 'teacher']), requirePermission(PERMISSIONS.QUESTIONS_MANAGE), importQuestionTextHandler);
router.put('/questions/:id', rbacGuard(['admin', 'editor', 'teacher']), requirePermission(PERMISSIONS.QUESTIONS_MANAGE), contentController.updateQuestion);
router.delete('/questions/:id', rbacGuard(['admin', 'moderator']), requirePermission(PERMISSIONS.MODERATION_ACTION), contentController.deleteQuestion); // Soft Delete

router.get('/ai-review-queue', rbacGuard(['admin', 'moderator']), requirePermission(PERMISSIONS.QUESTIONS_REVIEW), contentController.getAiReviewQueue);
router.post('/ai-review-queue/:id/review', rbacGuard(['admin', 'moderator']), requirePermission(PERMISSIONS.QUESTIONS_REVIEW), contentController.reviewQuestion);

router.post('/search-index/sync', rbacGuard(['admin']), requirePermission(PERMISSIONS.QUESTIONS_MANAGE), contentController.syncSearchIndex);

export default router;
