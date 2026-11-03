import { Router } from 'express';
import { syncVectorIndex, chatWithAI, explainQuestion, getAiConfig, updateAiConfig, extractQuestions } from './ai.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rbacGuard } from '../../middlewares/rbacGuard';
import { requirePermission } from '../../middlewares/requirePermission';
import { PERMISSIONS } from '../../middlewares/authorization';
import { rateLimit } from '../../middlewares/rateLimit';

const router = Router();

// Config routes (Admin only)
router.get('/config', requireAuth, rbacGuard(['admin']), getAiConfig);
router.post('/config', requireAuth, rbacGuard(['admin']), updateAiConfig);

// Vector Sync (Admin only)
router.post('/sync-embeddings', requireAuth, rbacGuard(['admin']), syncVectorIndex);

// Chat (Any logged in user)
router.post('/chat', requireAuth, chatWithAI);
router.post('/explanation', requireAuth, explainQuestion);

// AI Question Importer: the same author roles and permission as the import
// endpoint, plus a per-user cap so one account cannot drain the free extraction
// provider's quota (a separate credential from the student Assistant Gemini).
// The importer batches up to 8 pages per request, so this covers a long PDF
// while still bounding the number of provider calls.
router.post(
  '/extract-questions',
  requireAuth,
  rbacGuard(['admin', 'editor', 'teacher']),
  requirePermission(PERMISSIONS.QUESTIONS_MANAGE),
  rateLimit({ windowMs: 10 * 60 * 1000, max: 20, keyPrefix: 'ai:extract' }),
  extractQuestions
);

export default router;
