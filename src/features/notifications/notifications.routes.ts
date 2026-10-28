import { Router } from 'express';
import * as NotificationUserController from './notifications.user.controller';
import { updateDeviceToken } from './notifications.controller';
import adminRoutes from './notifications.admin.routes';
import { requireAuth } from '../../middlewares/requireAuth';

const router = Router();

// --- User Routes (Requires Authentication) ---
router.get('/', requireAuth, NotificationUserController.getUserNotifications);
router.get('/unread-count', requireAuth, NotificationUserController.getUnreadCount);
router.get('/preferences', requireAuth, NotificationUserController.getPreferences);
router.put('/preferences', requireAuth, NotificationUserController.updatePreferences);
router.post('/read', requireAuth, NotificationUserController.markAsRead);
router.post('/read-all', requireAuth, NotificationUserController.markAllAsRead);
router.post('/:id/read', requireAuth, NotificationUserController.markAsRead);
router.post('/device-token', requireAuth, updateDeviceToken);

// --- Admin Routes (Campaigns & Notices) ---
// Note: Auth and RBAC guards are already handled inside notifications.admin.routes.ts
router.use('/', adminRoutes);

export default router;
