import { Router } from 'express';
import { authController } from './auth.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rateLimit } from '../../middlewares/rateLimit';

const router = Router();

// Credential endpoints are rate limited to slow password/TOTP guessing.
const loginLimit = rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'admin-login' });
const usernameLoginLimit = rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'username-login' });
const registerLimit = rateLimit({ windowMs: 60_000, max: 5, keyPrefix: 'register' });

// Public Routes (genuine credential verification only)
router.post('/register', registerLimit, authController.register);
router.post('/username-login', usernameLoginLimit, authController.usernameLogin);
router.post('/admin/login', loginLimit, authController.adminLoginInit);
router.post('/admin/verify-2fa', loginLimit, authController.verify2FA);

// Protected Routes
router.use(requireAuth);
router.post('/logout', authController.logout);
router.post('/save-device', authController.saveDeviceInfo);
router.get('/profile', authController.getProfile);
router.get('/permissions', authController.getRoleAndPermissions);
router.post('/2fa/setup', authController.setup2FA);

export default router;
