import { Router } from 'express';
import { groupsTick } from './groups.controller';

const router = Router();

/**
 * External scheduler entry point. Render's free plan sleeps and an in-process
 * cron stops with it, so cron-job.org can call this alongside /health.
 * Protected by the CRON_SECRET secret header, never by a user session.
 */
router.post('/cron/groups-tick', groupsTick);

export default router;
