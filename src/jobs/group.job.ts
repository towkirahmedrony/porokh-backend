import cron from 'node-cron';
import { supabaseAdmin } from '../config/supabaseAdmin';

/**
 * Group competition maintenance.
 *
 * The leaderboard cache and due-battle finalization are both idempotent RPCs,
 * so overlapping ticks are harmless. Render's free tier sleeps and loses
 * in-process timers, which is why the same work is also exposed through
 * `POST /internal/cron/groups-tick` for an external pinger.
 */
export const runGroupsTick = async (): Promise<{
  leaderboardRefreshed: boolean;
  finalizedBattles: number | null;
}> => {
  let leaderboardRefreshed = false;
  let finalizedBattles: number | null = null;

  try {
    const { error } = await supabaseAdmin.rpc('refresh_group_leaderboard');
    if (error) {
      console.error('[groups:cron] leaderboard refresh failed:', error.message);
    } else {
      leaderboardRefreshed = true;
    }
  } catch (error) {
    console.error(
      '[groups:cron] leaderboard refresh threw:',
      error instanceof Error ? error.message : 'unknown error'
    );
  }

  try {
    const { data, error } = await supabaseAdmin.rpc('finalize_due_group_battles');
    if (error) {
      console.error('[groups:cron] battle finalize failed:', error.message);
    } else {
      finalizedBattles = Number(data ?? 0);
    }
  } catch (error) {
    console.error(
      '[groups:cron] battle finalize threw:',
      error instanceof Error ? error.message : 'unknown error'
    );
  }

  return { leaderboardRefreshed, finalizedBattles };
};

export const initGroupCron = () => {
  cron.schedule('*/10 * * * *', () => {
    void runGroupsTick();
  });

  cron.schedule('*/5 * * * *', async () => {
    try {
      const { error } = await supabaseAdmin.rpc('finalize_due_group_battles');
      if (error) console.error('[groups:cron] battle finalize failed:', error.message);
    } catch (error) {
      console.error(
        '[groups:cron] battle finalize threw:',
        error instanceof Error ? error.message : 'unknown error'
      );
    }
  });

  console.log('⏳ Group competition cron initialized (leaderboard 10m, battles 5m).');
};
