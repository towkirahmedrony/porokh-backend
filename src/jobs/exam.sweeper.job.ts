import cron from 'node-cron';
import { supabase } from '../config/supabase';
import logger from '../lib/utils/logger';
import { ATTEMPT_STATUS, resolveSubmitGraceMs } from '../features/exams/exam.timing';

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 5_000;

/**
 * Batch size for one sweep. Bounded so an operator can raise it for a backlog
 * without ever issuing an unbounded UPDATE against the live table.
 */
const resolveBatchSize = (): number => {
  const configured = Number(process.env.EXAM_SWEEP_BATCH_SIZE);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.floor(configured), MAX_BATCH_SIZE);
};

/** Guards against overlapping runs when a sweep takes longer than the interval. */
let isSweeping = false;

/**
 * Marks attempts that are past `deadline_at + submission grace` as expired.
 *
 * An attempt inside its grace window is deliberately left in progress: the
 * student's automatic submission at timer zero must still be accepted. Expiring
 * an attempt is only bookkeeping here; drafts are preserved so a follow-up
 * automatic grading pass (documented follow-up) can still grade them from
 * `answers_draft` through the normal submission lifecycle.
 */
export const sweepExpiredAttempts = async (nowMs: number = Date.now()): Promise<number> => {
  if (isSweeping) return 0;

  isSweeping = true;

  try {
    const graceMs = resolveSubmitGraceMs();
    const cutoff = new Date(nowMs - graceMs).toISOString();

    const batchSize = resolveBatchSize();

    const { data: candidates, error } = await supabase
      .from('exam_progress')
      .select('id')
      .eq('status', ATTEMPT_STATUS.IN_PROGRESS)
      .lt('deadline_at', cutoff)
      .limit(batchSize);

    if (error) {
      logger.error('[exam-sweeper] failed to load expired attempts', { message: error.message });
      return 0;
    }

    if (!candidates || candidates.length === 0) return 0;

    const ids = candidates.map((candidate) => candidate.id).filter(Boolean);
    if (ids.length === 0) return 0;

    // One bounded UPDATE instead of one round trip per attempt. The status and
    // deadline conditions are re-applied to every row in the same statement, so
    // an attempt claimed for submission between the read and this write is
    // still never expired underneath the student. The statement is idempotent,
    // which also makes two overlapping sweeps harmless.
    const { data: updated, error: updateError } = await supabase
      .from('exam_progress')
      .update({
        status: ATTEMPT_STATUS.EXPIRED,
        last_updated_at: new Date(nowMs).toISOString(),
      })
      .in('id', ids)
      .eq('status', ATTEMPT_STATUS.IN_PROGRESS)
      .lt('deadline_at', cutoff)
      .select('id');

    if (updateError) {
      logger.error('[exam-sweeper] failed to expire attempts', {
        count: ids.length,
        message: updateError.message,
      });
      return 0;
    }

    const expired = Array.isArray(updated) ? updated.length : 0;

    if (expired > 0) {
      logger.info('[exam-sweeper] expired attempts', { count: expired, cutoff });
    }

    return expired;
  } catch (error) {
    logger.error('[exam-sweeper] unexpected failure', error);
    return 0;
  } finally {
    isSweeping = false;
  }
};

export const startExamAttemptSweeper = (): void => {
  cron.schedule('*/5 * * * *', () => {
    // The job handles its own errors; the catch is a last line of defence so a
    // rejected promise can never become an unhandled rejection.
    void sweepExpiredAttempts().catch((error) => {
      logger.error('[exam-sweeper] unhandled rejection', error);
    });
  });

  logger.info('Exam attempt sweeper scheduled (runs every 5 minutes).');
};
