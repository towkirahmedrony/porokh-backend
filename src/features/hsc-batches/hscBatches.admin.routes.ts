import { Router } from 'express';
import { createBatch, getBatches, updateBatch } from './hscBatches.admin.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rbacGuard } from '../../middlewares/rbacGuard';
import { requirePermission } from '../../middlewares/requirePermission';
import { PERMISSIONS } from '../../middlewares/authorization';
import { rateLimit } from '../../middlewares/rateLimit';

const router = Router();

router.use(requireAuth);
router.use(rbacGuard(['admin', 'super_admin']), requirePermission(PERMISSIONS.SETTINGS_MANAGE));

const readLimit = rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'hsc-batches-read' });
const writeLimit = rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'hsc-batches-write' });

router.get('/', readLimit, getBatches);
router.post('/', writeLimit, createBatch);
router.patch('/:year', writeLimit, updateBatch);

export default router;
