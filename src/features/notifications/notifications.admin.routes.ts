import { Router } from 'express';
import * as NotificationAdminController from './notifications.admin.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rbacGuard } from '../../middlewares/rbacGuard';
import { requirePermission } from '../../middlewares/requirePermission';
import { PERMISSIONS } from '../../middlewares/authorization';

const router = Router();

// Every notification admin surface uses the existing Porokh RBAC: an admin
// (or super admin) role plus the staff-management permission. No parallel
// authorization system is introduced.
router.use(requireAuth, rbacGuard(['admin']), requirePermission(PERMISSIONS.USER_MANAGE));

// Dashboard
router.get('/stats', NotificationAdminController.getStats);
router.post('/audience/preview', NotificationAdminController.previewAudience);

// Notifications (called campaigns by the existing admin panel)
router.get('/campaigns', NotificationAdminController.listCampaigns);
router.post('/campaigns', NotificationAdminController.createCampaign);
router.get('/campaigns/:id', NotificationAdminController.getCampaign);
router.put('/campaigns/:id', NotificationAdminController.updateCampaign);
router.patch('/campaigns/:id/cancel', NotificationAdminController.cancelCampaign);
router.post('/campaigns/:id/send', NotificationAdminController.sendCampaign);
router.post('/campaigns/:id/retry', NotificationAdminController.retryCampaign);
router.delete('/campaigns/:id', NotificationAdminController.deleteCampaign);

export default router;
