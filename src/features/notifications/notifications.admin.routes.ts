import { Router } from 'express';
import * as NotificationAdminController from './notifications.admin.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rbacGuard } from '../../middlewares/rbacGuard';
import { requirePermission } from '../../middlewares/requirePermission';
import { PERMISSIONS } from '../../middlewares/authorization';

const router = Router();
router.use(requireAuth, rbacGuard(['admin']), requirePermission(PERMISSIONS.USER_MANAGE));

// Campaigns
router.post('/campaigns', NotificationAdminController.createCampaign);
router.get('/campaigns', NotificationAdminController.getCampaigns);
router.put('/campaigns/:id', NotificationAdminController.updateCampaign); // NEW: Edit
router.patch('/campaigns/:id/cancel', NotificationAdminController.cancelCampaign);
router.delete('/campaigns/:id', NotificationAdminController.deleteCampaign); // NEW: Delete

export default router;
