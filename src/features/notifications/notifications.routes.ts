import { Router } from 'express';
import * as NotificationUserController from './notifications.user.controller';
import { removeDeviceToken, updateDeviceToken } from './notifications.controller';
import adminRoutes from './notifications.admin.routes';
import { requireAuth } from '../../middlewares/requireAuth';
import rateLimit from '../../middlewares/rateLimit';

const router = Router();

const writeLimiter = rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'notifications:write' });

// --- User Routes (Requires Authentication) ---
router.get('/', requireAuth, NotificationUserController.getUserNotifications);
router.get('/unread-count', requireAuth, NotificationUserController.getUnreadCount);
router.get('/preferences', requireAuth, NotificationUserController.getPreferences);
router.put('/preferences', requireAuth, writeLimiter, NotificationUserController.updatePreferences);
router.post('/read', requireAuth, writeLimiter, NotificationUserController.markAsRead);
router.post('/read-all', requireAuth, writeLimiter, NotificationUserController.markAllAsRead);
router.post('/:id/read', requireAuth, writeLimiter, NotificationUserController.markAsRead);
router.post('/:id/click', requireAuth, writeLimiter, NotificationUserController.markAsClicked);

// Device registration. `/device-token` stays for APKs already in the wild; the
// `/devices` paths are the documented ones.
router.post('/device-token', requireAuth, writeLimiter, updateDeviceToken);
router.delete('/device-token', requireAuth, writeLimiter, removeDeviceToken);
router.post('/devices', requireAuth, writeLimiter, updateDeviceToken);
router.delete('/devices/:deviceId', requireAuth, writeLimiter, removeDeviceToken);

// --- Admin Routes (Campaigns & Notices) ---
// Note: Auth and RBAC guards are already handled inside notifications.admin.routes.ts
router.use('/', adminRoutes);

export default router;
