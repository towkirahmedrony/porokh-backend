import { Router } from 'express';
import * as NoticeAdminController from './notices.admin.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rbacGuard } from '../../middlewares/rbacGuard';
import { requirePermission } from '../../middlewares/requirePermission';
import { PERMISSIONS } from '../../middlewares/authorization';

const router = Router();

// Same admin surface as the existing notifications admin routes.
router.use(
  requireAuth,
  rbacGuard(['admin', 'super_admin']),
  requirePermission(PERMISSIONS.USER_MANAGE)
);

router.get('/', NoticeAdminController.listNotices);
router.post('/', NoticeAdminController.createNotice);
router.get('/:id', NoticeAdminController.getNotice);
router.put('/:id', NoticeAdminController.updateNotice);
router.post('/:id/publish', NoticeAdminController.publishNotice);
router.post('/:id/expire', NoticeAdminController.expireNotice);
router.patch('/:id/status', NoticeAdminController.setNoticeStatus);
router.delete('/:id', NoticeAdminController.deleteNotice);

export default router;
