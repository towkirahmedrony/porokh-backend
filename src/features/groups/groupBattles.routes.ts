import { Router } from 'express';
import * as controller from './groups.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { rateLimit } from '../../middlewares/rateLimit';

const router = Router();

const questionReadLimit = rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'group-battle-questions' });
const submitLimit = rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'group-battle-submit' });

router.use(requireAuth);

router.get('/:id', controller.getBattle);
router.post('/:id/join', controller.joinBattle);
router.get('/:id/questions', questionReadLimit, controller.getBattleQuestions);
router.post('/:id/submit', submitLimit, controller.submitBattle);
router.post('/:id/cancel', controller.cancelBattle);
router.post('/:id/finalize', controller.finalizeBattle);

export default router;
