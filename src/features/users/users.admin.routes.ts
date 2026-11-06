import { Router } from 'express';
import {
  adjustBalance,
  assignRole,
  exportUsers,
  forceLogout,
  getRiskAccount,
  getRiskAccounts,
  getRoleAuditLog,
  getRoles,
  getUser360,
  getUsersList,
  updateAccountStatus,
} from './users.admin.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rbacGuard } from '../../middlewares/rbacGuard';
import { requirePermission } from '../../middlewares/requirePermission';
import { PERMISSIONS } from '../../middlewares/authorization';

const router = Router();

router.use(requireAuth);
router.use(rbacGuard(['admin']), requirePermission(PERMISSIONS.USER_READ));

/**
 * Order matters: the literal paths are declared before `/:userId/...` so a user
 * whose id happened to be "export" could never shadow them.
 */
router.get('/', getUsersList);
router.get('/export', exportUsers);
router.get('/security/risk', getRiskAccounts);
router.get('/security/risk/:userId', getRiskAccount);
router.get('/roles', getRoles);
router.get('/roles/audit', getRoleAuditLog);

router.get('/:userId/360', getUser360);

router.post('/:userId/status', requirePermission(PERMISSIONS.USER_MANAGE), updateAccountStatus);
router.post('/:userId/force-logout', requirePermission(PERMISSIONS.USER_MANAGE), forceLogout);
router.post('/:userId/adjust-balance', requirePermission(PERMISSIONS.USER_MANAGE), adjustBalance);
router.post('/:userId/role', requirePermission(PERMISSIONS.ROLE_ASSIGN_STAFF), assignRole);

export default router;
