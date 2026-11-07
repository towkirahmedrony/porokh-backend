import { Router } from 'express';
import * as SupportController from './support.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rateLimit } from '../../middlewares/rateLimit';

const router = Router();

router.use(requireAuth);

const createLimiter = rateLimit({ windowMs: 60_000, max: 5, keyPrefix: 'support:create' });
const replyLimiter = rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'support:reply' });
const reopenLimiter = rateLimit({ windowMs: 60_000, max: 5, keyPrefix: 'support:reopen' });

router.get('/', SupportController.listTickets);
router.post('/', createLimiter, SupportController.createTicket);
router.get('/:id', SupportController.getTicket);
router.post('/:id/replies', replyLimiter, SupportController.replyToTicket);
router.post('/:id/reopen', reopenLimiter, SupportController.reopenTicket);

export default router;
