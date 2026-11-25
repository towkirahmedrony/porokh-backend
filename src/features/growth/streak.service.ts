import { supabase } from '../../config/supabase';
import { supabaseAdmin } from '../../config/supabaseAdmin';
import { notifyXpAndProgression } from '../notifications/notifications.service';
import { localizeRecord, parseLanguage } from '../../lib/utils/language';
import { dhakaDayKey, endOfDhakaDayIso, startOfDhakaDayIso } from '../../lib/utils/time';

/**
 * Streak and freeze counters are owned by the database: exam_history and
 * user_daily_activities triggers refresh profiles.current_streak, and a
 * pg_cron job applies daily freezes. These endpoints only read that state —
 * the backend must never invent or recompute it.
 */
export const getStreakStats = async (userId: string) => {
  const { data: profile, error: profileErr } = await supabase.from('profiles').select('current_streak, total_xp, coin_balance, freezes_left').eq('id', userId).single();
  if (profileErr) throw profileErr;
  const { data: longestStreakData, error: rpcErr } = await supabase.rpc('get_longest_streak', { p_user_id: userId });
  if (rpcErr) throw rpcErr;
  // A student who has never earned a freeze has 0 left. Reporting 2 here used
  // to claim freezes the database would not honour.
  const freezesLeft = profile.freezes_left ?? 0;
  return {
    current_streak: profile.current_streak || 0, total_xp: profile.total_xp || 0, coin_balance: profile.coin_balance || 0,
    freezesLeft, freezes_left: freezesLeft,
    longest_streak: longestStreakData && longestStreakData.length > 0 ? longestStreakData[0] : null
  };
};

/**
 * The 365-day calendar comes from get_user_heatmap (submitted exam_history
 * rows), so it counts a day even when no activity row was written. Freeze days
 * are flagged separately because the RPC does not expose used_freeze.
 */
export const getHeatmap = async (userId: string) => {
  const [{ data: calendar, error: calendarErr }, { data: activities, error: activityErr }] = await Promise.all([
    supabase.rpc('get_user_heatmap', { p_user_id: userId }),
    supabase.from('user_daily_activities').select('activity_date, used_freeze').eq('user_id', userId).eq('used_freeze', true),
  ]);
  if (calendarErr) throw calendarErr;
  if (activityErr) throw activityErr;

  type HeatmapDay = {
    cal_date: string;
    exams_taken: number | null;
    study_time_minutes: number | null;
    xp_earned: number | null;
  };

  const frozenDays = new Set((activities ?? []).map((row) => row.activity_date));
  return ((calendar ?? []) as HeatmapDay[]).map((day) => ({
    activity_date: day.cal_date,
    exams_taken: day.exams_taken ?? 0,
    study_time_minutes: day.study_time_minutes ?? 0,
    xp_earned: day.xp_earned ?? 0,
    used_freeze: frozenDays.has(day.cal_date),
  }));
};

export const getDailyQuests = async (userId: string) => {
  const [{ data: profile }, { data, error }] = await Promise.all([
    supabase.from('profiles').select('language_preference').eq('id', userId).maybeSingle(),
    supabase.from('user_quest_progress')
      .select('id, is_completed, progress_count, daily_quests ( id, title, title_en, target_count, xp_reward, coin_reward, icon_url )')
      .eq('user_id', userId),
  ]);
  if (error) throw error;
  const language = parseLanguage(profile?.language_preference);
  return (data || []).map((progress) => ({
    ...progress,
    daily_quests: Array.isArray(progress.daily_quests)
      ? progress.daily_quests.map((quest) => localizeRecord(quest, language, ['title']))
      : progress.daily_quests
        ? localizeRecord(progress.daily_quests, language, ['title'])
        : null,
  }));
};

/**
 * Records that a saved exam result happened today and pays the first-session
 * reward for the day.
 *
 * The database already derives profiles.current_streak from submitted
 * exam_history rows (trg_streak_refresh), and pg_cron applies freezes. This
 * function therefore never writes current_streak, freezes_left or used_freeze:
 * it mirrors the day's submitted-exam count into user_daily_activities (which
 * the heatmap, dashboards and daily goals read) and rewards the first exam of
 * the day, including 7/30-day streak bonuses based on the derived streak.
 */
export const recordStudyActivity = async (userId: string) => {
  if (!userId) return;
  try {
    // The database stores activity_date and derives streaks in Asia/Dhaka, so
    // the day boundaries here must use the same calendar day.
    const today = dhakaDayKey();

    const [
      { data: activity, error: activityErr },
      { count: submittedToday, error: countErr },
      { data: profile },
    ] = await Promise.all([
      supabaseAdmin
        .from('user_daily_activities')
        .select('id, exams_taken, xp_earned')
        .eq('user_id', userId)
        .eq('activity_date', today)
        .maybeSingle(),
      supabaseAdmin
        .from('exam_history')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .not('submitted_at', 'is', null)
        .or('status.is.null,status.neq.fraud_detected')
        .gte('submitted_at', startOfDhakaDayIso())
        .lt('submitted_at', endOfDhakaDayIso()),
      supabaseAdmin.from('profiles').select('current_streak').eq('id', userId).maybeSingle(),
    ]);

    if (activityErr) throw activityErr;
    if (countErr) throw countErr;
    if (!profile) return;

    // submitted_at is the source of truth: abandoned attempts have no result
    // row and never reach this function, so they cannot create a study day.
    const examsTaken = Math.max(submittedToday ?? 0, 1);
    // A freeze-only day has exams_taken = 0, so its first real exam still pays.
    const isFirstExamOfDay = (activity?.exams_taken ?? 0) === 0;

    const { data: configData } = await supabaseAdmin
      .from('app_configs')
      .select('value')
      .eq('key', 'xp_rules')
      .maybeSingle();
    const rules = (configData?.value as any) || {};

    const streak = profile.current_streak ?? 0;
    let xpReward = 0;
    let notifTitle = { bn: 'ডেইলি গোল পূরণ! 🎉', en: 'Daily goal completed! 🎉' };
    let notifBody = { bn: '', en: '' };

    if (isFirstExamOfDay) {
      xpReward = rules.daily_login || 10;
      notifBody = {
        bn: `আজকের প্রথম পড়ার জন্য আপনি পেয়েছেন ${xpReward} XP!`,
        en: `You earned ${xpReward} XP for your first study session today.`,
      };

      if (streak > 0 && streak % 30 === 0) {
        xpReward += rules.streak_30_days || 300;
        notifTitle = { bn: '🔥 ৩০ দিনের ফায়ার স্ট্রিক!', en: '🔥 30-day study streak!' };
        notifBody = {
          bn: `অসাধারণ! টানা ৩০ দিন পড়াশোনা করার জন্য বোনাস হিসেবে পেয়েছেন সর্বমোট ${xpReward} XP!`,
          en: `Amazing! You earned a total bonus of ${xpReward} XP for studying 30 days in a row.`,
        };
      } else if (streak > 0 && streak % 7 === 0) {
        xpReward += rules.streak_7_days || 50;
        notifTitle = { bn: '🔥 ৭ দিনের স্ট্রিক!', en: '🔥 7-day study streak!' };
        notifBody = {
          bn: `দারুণ! টানা ৭ দিন পড়াশোনা করার জন্য বোনাস হিসেবে পেয়েছেন সর্বমোট ${xpReward} XP!`,
          en: `Great! You earned a total bonus of ${xpReward} XP for studying 7 days in a row.`,
        };
      }
    }

    // Setting the count (instead of incrementing) makes a repeated or retried
    // submit idempotent: the row always matches the day's exam_history rows.
    const { error: upsertErr } = await supabaseAdmin.from('user_daily_activities').upsert(
      {
        user_id: userId,
        activity_date: today,
        exams_taken: examsTaken,
        xp_earned: (activity?.xp_earned ?? 0) + xpReward,
      },
      { onConflict: 'user_id,activity_date' }
    );
    if (upsertErr) throw upsertErr;

    if (xpReward <= 0) return;

    await supabaseAdmin.rpc('update_user_progress', { p_user_id: userId, p_coins: 0, p_xp: xpReward });
    await notifyXpAndProgression(userId, {
      xp: xpReward,
      reason: 'streak_reward',
      title: notifTitle,
      body: notifBody,
      actionLink: '/dashboard/streak',
      dedupeKey: `streak_reward:${userId}:${today}`,
    });
  } catch (error) {
    console.error('❌ [STREAK LOG] Critical Server Error:', error);
  }
};
