import cron from 'node-cron';
import { runDispatchOnce } from '../features/notifications/notifications.dispatcher';

/**
 * Dispatch backstop.
 *
 * Scheduling lives in pg_cron and delivery is idempotent, so this timer is a
 * convenience while the process happens to be awake. cron-job.org's call to
 * /internal/notifications/dispatch is what keeps delivery moving when Render
 * has put the instance to sleep.
 */
export const initNotificationCron = (): void => {
  console.log('⏳ Notification dispatcher backstop every 30s (authoritative schedule is pg_cron)');

  cron.schedule('*/30 * * * * *', () => {
    void runDispatchOnce()
      .then((summary) => {
        if (summary && (summary.sent > 0 || summary.failed > 0)) {
          console.log(
            `[dispatch] claimed=${summary.claimed} sent=${summary.sent} deferred=${summary.deferred} failed=${summary.failed}`
          );
        }
      })
      .catch((error) => {
        console.error('[dispatch] tick failed:', error instanceof Error ? error.message : error);
      });
  });
};
