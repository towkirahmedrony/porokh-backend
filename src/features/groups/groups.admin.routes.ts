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

// Static moderation/settings paths must be declared before `/:id`.
router.get('/moderation', controller.getModerationQueue);
router.post('/moderation/:flagId/ignore', controller.ignoreModerationFlag);
router.post('/moderation/:flagId/warn', controller.warnModerationFlag);
router.post('/moderation/:flagId/delete', controller.deleteModerationFlag);
router.post('/moderation/:flagId/ban', controller.banModerationFlag);

router.get('/dictionary', controller.getDictionary);
router.post('/dictionary', controller.createDictionary);
router.patch('/dictionary/:entryId', controller.updateDictionary);
router.delete('/dictionary/:entryId', controller.deleteDictionary);

router.get('/settings', controller.getSettings);
router.patch('/settings', controller.updateSettings);

router.get('/leaderboard', controller.getLeaderboard);
router.post('/leaderboard/refresh', controller.refreshLeaderboard);

router.post('/', controller.createGroup);

router.get('/:id', controller.getGroup);
router.patch('/:id', controller.updateGroup);
router.post('/:id/status', controller.setGroupStatus);

router.get('/:id/members', controller.getGroupMembers);
router.post('/:id/members', controller.addGroupMember);
router.patch('/:id/members/:userId', controller.updateGroupMemberRole);
router.delete('/:id/members/:userId', controller.removeGroupMember);
router.post('/:id/members/:userId/kick', controller.kickGroupMember);

router.post('/:id/owner', controller.transferGroupOwnership);

router.get('/:id/messages', controller.getGroupMessages);
router.delete('/:id/messages/:messageId', controller.deleteGroupMessage);
router.get('/:id/flags', controller.getGroupFlags);
router.post('/:id/battles/:battleId/cancel', controller.cancelGroupBattle);

export default router;
