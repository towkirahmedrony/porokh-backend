import { Router } from 'express';
import { getActivity, getAnalytics, getHealth, getOverview } from './dashboard.admin.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rbacGuard } from '../../middlewares/rbacGuard';
import { requirePermission } from '../../middlewares/requirePermission';
import { PERMISSIONS } from '../../middlewares/authorization';

const router = Router();

// Every dashboard aggregate is served to admins only. Analytics permission is
// checked against role_permissions, and the audit feed additionally requires
// the audit-log permission so a limited admin never sees another admin's trail.
router.use(
  requireAuth,
  rbacGuard(['admin', 'super_admin']),
  requirePermission(PERMISSIONS.ANALYTICS_READ)
);

router.get('/overview', getOverview);
// Kept for older admin builds that still call the original stats path.
router.get('/stats', getOverview);
router.get('/analytics', getAnalytics);
router.get('/health', getHealth);
router.get('/activity', requirePermission(PERMISSIONS.AUDIT_LOGS_READ), getActivity);

export default router;
