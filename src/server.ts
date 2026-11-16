import app from './app';
import { initNotificationCron } from './jobs/notification.job';
import cron from 'node-cron'; // 👈 node-cron ইম্পোর্ট করা হলো
import { processDailyStreaks, resetMonthlyFreezes } from './jobs/streak.job'; // 👈 streak.job ইম্পোর্ট করা হলো
// 👇 নতুন: এম্বেডিং ওয়ার্কার ইম্পোর্ট করা হলো
import { startEmbeddingWorker } from './jobs/embedding.worker';
import { startExamAttemptSweeper } from './jobs/exam.sweeper.job';
import { initGroupCron } from './jobs/group.job';
import logger from './lib/utils/logger';
// import { connectRedis } from './config/redis';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5000;
const HOST = '0.0.0.0'; // হোস্ট যুক্ত করা হয়েছে

/** How long an in-flight request may finish before the process is forced out. */
const SHUTDOWN_GRACE_MS = 10_000;

let shuttingDown = false;

/**
 * Stops accepting new connections, lets in-flight requests finish, then exits.
 *
 * Render sends SIGTERM on deploy. Without this the process is killed mid-request
 * and clients see connection resets; with it a deploy drains cleanly. Scheduled
 * jobs end with the process, and every job is already safe to interrupt: the
 * sweeper and notification claim are idempotent, and a torn embedding update is
 * retried because the question stays stale.
 */
const shutdown = (server: import('http').Server, reason: string, exitCode: number): void => {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`[process] ${reason} received; draining connections`);

  const force = setTimeout(() => {
    logger.error('[process] graceful shutdown timed out; exiting');
    process.exit(exitCode || 1);
  }, SHUTDOWN_GRACE_MS);

  // Do not let the timer itself keep the process alive.
  force.unref();

  server.close(() => {
    clearTimeout(force);
    logger.info('[process] shutdown complete');
    process.exit(exitCode);
  });

  // Node stops accepting new sockets on close(); idle keep-alive sockets would
  // otherwise hold the drain open for their keep-alive timeout.
  const closable = server as import('http').Server & { closeIdleConnections?: () => void };
  closable.closeIdleConnections?.();
};

async function bootstrap() {
  try {
    // ডাটাবেস বা রেডিয়স কানেকশন এখানে ইনিশিয়ালাইজ করবেন
    // await connectRedis();

    // listen-এর মধ্যে HOST প্যারামিটার দেওয়া হয়েছে
    const server = app.listen(PORT, HOST, () => {
      console.log(`🚀 Server is running on http://${HOST}:${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
    });

    // Cron Job ইনিশিয়ালাইজ করা হলো (নোটিফিকেশন scheduled থেকে sent করার জন্য)
    initNotificationCron();

    // ==========================================
    // 🌟 AI Embedding & Duplicate Checking 🌟
    // ==========================================
    startEmbeddingWorker();

    // ==========================================
    // 🌟 Streak System Cron Jobs 🌟
    // ==========================================
    
    // ==========================================
    // 🌟 Exam attempt expiry sweeper 🌟
    // ==========================================
    // Marks attempts that are past their deadline plus the submission grace
    // window as expired. Runs every five minutes.
    startExamAttemptSweeper();

    // ==========================================
    // 🌟 Group competition maintenance 🌟
    // ==========================================
    initGroupCron();

    // প্রতিদিন রাত ১২:০১ মিনিটে স্ট্রিক প্রসেস হবে
    cron.schedule('1 0 * * *', () => {
      console.log('⏳ Running daily streak processing cron job...');
      // Never let a rejected job body become an unhandled rejection that stops
      // the process; the job logs its own failures.
      Promise.resolve(processDailyStreaks()).catch((error) => {
        console.error('Daily streak job failed:', error);
      });
    });

    // প্রতি মাসের ১ তারিখ রাত ১২:০৫ মিনিটে ফ্রিজ রিসেট হবে
    cron.schedule('5 0 1 * *', () => {
      console.log('⏳ Running monthly freeze reset cron job...');
      Promise.resolve(resetMonthlyFreezes()).catch((error) => {
        console.error('Monthly freeze reset job failed:', error);
      });
    });

    // ---------------------------------------------------------------
    // Process safety
    // ---------------------------------------------------------------
    // A rejected promise from a fire-and-forget call is an operational bug, not
    // a reason to take the API offline: kill the process here and every student
    // request in flight fails with it. It is logged loudly with the reason so it
    // is fixed, and genuinely fatal faults still exit through uncaughtException.
    process.on('unhandledRejection', (reason) => {
      logger.error(
        '[process] unhandled promise rejection (process kept alive)',
        reason instanceof Error ? reason.stack ?? reason.message : reason
      );
    });

    // A synchronous throw outside any request/response cycle leaves the process
    // in an unknown state, so it is drained and exited instead of ignored.
    process.on('uncaughtException', (error) => {
      logger.error('[process] uncaught exception', error?.stack ?? error);
      shutdown(server, 'uncaughtException', 1);
    });

    process.on('SIGTERM', () => shutdown(server, 'SIGTERM', 0));
    process.on('SIGINT', () => shutdown(server, 'SIGINT', 0));

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

bootstrap();
