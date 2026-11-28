import { Router } from 'express';
import * as ReleaseController from './releases.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rbacGuard } from '../../middlewares/rbacGuard';
import { requirePermission } from '../../middlewares/requirePermission';
import { PERMISSIONS } from '../../middlewares/authorization';

/**
 * Public release surface. Read-only and unauthenticated on purpose: the APK is
 * a public download, and this endpoint is the only place that knows whether one
 * exists.
 */
const publicReleaseRoutes = Router();
publicReleaseRoutes.get('/latest', ReleaseController.getLatestRelease);

/**
 * Administrative surface. Same guards as the existing version/update-policy
 * routes: an Admin or Super Admin session plus the settings permission. The
 * backend enforces this; hiding the admin page is not the control.
 */
const adminReleaseRoutes = Router();
adminReleaseRoutes.use(
  requireAuth,
  rbacGuard(['admin', 'super_admin']),
  requirePermission(PERMISSIONS.SETTINGS_MANAGE)
);

adminReleaseRoutes.get('/apk', ReleaseController.getAdminRelease);
adminReleaseRoutes.post('/apk', ReleaseController.uploadRelease);
adminReleaseRoutes.delete('/apk', ReleaseController.deleteRelease);

export { publicReleaseRoutes, adminReleaseRoutes };
