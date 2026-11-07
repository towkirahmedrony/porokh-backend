import { Router } from 'express';
import * as SupportAdminController from './support.admin.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rbacGuard } from '../../middlewares/rbacGuard';
import { requirePermission } from '../../middlewares/requirePermission';
import { PERMISSIONS } from '../../middlewares/authorization';

const router = Router();

router.use(
  requireAuth,
  rbacGuard(['admin', 'super_admin']),
  requirePermission(PERMISSIONS.USER_MANAGE)
);

router.get('/', SupportAdminController.listTickets);
router.get('/stats', SupportAdminController.getStats);
router.get('/agents', SupportAdminController.listAgents);
router.get('/:id', SupportAdminController.getTicket);
router.post('/:id/replies', SupportAdminController.replyToTicket);
router.patch('/:id/status', SupportAdminController.updateStatus);
router.patch('/:id/priority', SupportAdminController.updatePriority);
router.patch('/:id/assignment', SupportAdminController.updateAssignment);

export default router;
