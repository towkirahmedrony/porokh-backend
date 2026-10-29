import { Router } from 'express';
import * as NoticeUserController from './notices.user.controller';
import { requireAuth } from '../../middlewares/requireAuth';

const router = Router();

router.use(requireAuth);

router.get('/unread-count', NoticeUserController.getUnreadCount);
router.get('/urgent', NoticeUserController.getUrgentNotice);
router.get('/', NoticeUserController.listNotices);
router.get('/:id', NoticeUserController.getNotice);
router.post('/:id/read', NoticeUserController.markRead);
router.post('/:id/dismiss', NoticeUserController.dismiss);

export default router;
