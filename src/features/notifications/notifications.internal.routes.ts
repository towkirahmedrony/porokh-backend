import { Router } from 'express';
import rateLimit from '../../middlewares/rateLimit';
import { dispatchController } from './notifications.internal.controller';

const router = Router();

// cron-job.org runs every minute; the limiter only needs to stop a runaway
// caller from hammering the FCM quota.
const dispatchLimiter = rateLimit({
  windowMs: 60_000,
  max: 12,
  keyPrefix: 'notifications:dispatch',
});

// The secret header is the authentication: this route is not behind requireAuth
// because a cron provider has no user session.
router.post('/notifications/dispatch', dispatchLimiter, dispatchController);

export default router;
