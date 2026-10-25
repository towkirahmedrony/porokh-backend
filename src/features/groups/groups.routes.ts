import { Router } from 'express';
import * as controller from './groups.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rateLimit } from '../../middlewares/rateLimit';

const router = Router();

const chatSendLimit = rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'group-chat' });

router.use(requireAuth);

router.get('/config', controller.getConfig);
router.get('/me', controller.getMyGroups);
router.get('/discover', controller.discover);
router.get('/leaderboard', controller.getLeaderboard);

router.post('/', controller.createGroup);
router.post('/join', controller.joinGroup);
router.post('/join-by-code', controller.joinByCode);

router.get('/:id', controller.getGroup);
router.patch('/:id', controller.updateGroup);
router.post('/:id/leave', controller.leaveGroup);
router.get('/:id/join-code', controller.getJoinCode);
router.get('/:id/requests', controller.getJoinRequests);
router.post('/:id/requests/:userId', controller.reviewJoinRequest);
router.post('/:id/members/:userId/kick', controller.kickMember);

router.get('/:id/messages', controller.getMessages);
router.post('/:id/messages', chatSendLimit, controller.postMessage);

router.get('/:id/battles', controller.listBattles);
router.post('/:id/battles', controller.createBattle);

export default router;
