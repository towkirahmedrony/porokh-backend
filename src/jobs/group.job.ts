import cron from 'node-cron';
import { supabaseAdmin } from '../config/supabaseAdmin';
import { notifyBattleFinishedById } from '../features/groups/groups.service';

/**
 * Group competition maintenance.
 *
 * The leaderboard cache and due-battle finalization are both idempotent RPCs,
 * so overlapping ticks are harmless. Render's free tier sleeps and loses
 * in-process timers, which is why the same work is also exposed through
 * `POST /internal/cron/groups-tick` for an external pinger.
 */
const finalizeDueBattles = async (): Promise<number | null> => {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  const { data: due } = await supabaseAdmin
    .from('group_battles')
    .select('id')
    .in('status', ['pending', 'ongoing'])
    .not('end_time', 'is', null)
    .lt('end_time', cutoff);

  const dueIds = (due ?? []).map((row) => String(row.id)).filter(Boolean);

  try {
    const { data, error } = await supabaseAdmin.rpc('finalize_due_group_battles');
    if (error) {
      console.error('[groups:cron] battle finalize failed:', error.message);
      return null;
    }

    if (dueIds.length > 0) {
      const { data: completed } = await supabaseAdmin
        .from('group_battles')
        .select('id')
        .in('id', dueIds)
        .eq('status', 'completed');

      const completedIds = (completed ?? []).map((row) => String(row.id));
      await Promise.allSettled(completedIds.map((id) => notifyBattleFinishedById(id)));
    }

    return Number(data ?? 0);
  } catch (error) {
    console.error(
      '[groups:cron] battle finalize threw:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return null;
  }
};

export const runGroupsTick = async (): Promise<{
  leaderboardRefreshed: boolean;
  finalizedBattles: number | null;
}> => {
  let leaderboardRefreshed = false;

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

  const finalizedBattles = await finalizeDueBattles();

  return { leaderboardRefreshed, finalizedBattles };
};

export const initGroupCron = () => {
  cron.schedule('*/10 * * * *', () => {
    void runGroupsTick();
  });

  cron.schedule('*/5 * * * *', () => {
    void finalizeDueBattles();
  });

  console.log('⏳ Group competition cron initialized (leaderboard 10m, battles 5m).');
};
