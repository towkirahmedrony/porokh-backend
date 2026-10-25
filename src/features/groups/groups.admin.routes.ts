import { Router } from 'express';
import * as controller from './groups.admin.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rbacGuard } from '../../middlewares/rbacGuard';
import { requirePermission } from '../../middlewares/requirePermission';
import { PERMISSIONS } from '../../middlewares/authorization';

const router = Router();

router.use(requireAuth);

// All group administration is Admin/Super Admin only. Moderators keep their
// community moderation surface but cannot create, archive or mutate groups.
router.use(rbacGuard(['admin']), requirePermission(PERMISSIONS.SETTINGS_MANAGE));

router.get('/', controller.getGroups);
router.get('/stats', controller.getGroupStats);
router.get('/users/search', controller.searchUsers);

router.post('/', controller.createGroup);

router.get('/:id', controller.getGroup);
router.patch('/:id', controller.updateGroup);
router.post('/:id/status', controller.setGroupStatus);

router.get('/:id/members', controller.getGroupMembers);
router.post('/:id/members', controller.addGroupMember);
router.patch('/:id/members/:userId', controller.updateGroupMemberRole);
router.delete('/:id/members/:userId', controller.removeGroupMember);

router.post('/:id/owner', controller.transferGroupOwnership);

export default router;
