import { supabase } from '../../config/supabase';
import { supabaseAdmin } from '../../config/supabaseAdmin';
import { notifyXpAndProgression } from '../notifications/notifications.service';
import { localizeRecord, parseLanguage } from '../../lib/utils/language';

export const getStreakStats = async (userId: string) => {
  const { data: profile, error: profileErr } = await supabase.from('profiles').select('current_streak, total_xp, coin_balance, freezes_left').eq('id', userId).single();
  if (profileErr) throw profileErr;
  const { data: longestStreakData, error: rpcErr } = await supabase.rpc('get_longest_streak', { p_user_id: userId });
  if (rpcErr) throw rpcErr;
  return {
    current_streak: profile.current_streak || 0, total_xp: profile.total_xp || 0, coin_balance: profile.coin_balance || 0,
    freezesLeft: profile.freezes_left ?? 2, freezes_left: profile.freezes_left ?? 2,
    longest_streak: longestStreakData && longestStreakData.length > 0 ? longestStreakData[0] : null
  };
};

export const getHeatmap = async (userId: string) => {
  const { data, error } = await supabase.from('user_daily_activities').select('activity_date, exams_taken, study_time_minutes, xp_earned, used_freeze').eq('user_id', userId).order('activity_date', { ascending: true });
  if (error) throw error;
  return data || [];
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

export const incrementStreakOnExamSubmit = async (userId: string) => {
  if (!userId) return;
  try {
    const bdTime = new Date(new Date().getTime() + 6 * 60 * 60 * 1000);
    const today = bdTime.toISOString().split('T')[0];
    const yesterdayDate = new Date(bdTime.getTime() - 24 * 60 * 60 * 1000);
    const yesterday = yesterdayDate.toISOString().split('T')[0];

    const { data: activity } = await supabaseAdmin.from('user_daily_activities').select('id, exams_taken').eq('user_id', userId).eq('activity_date', today).maybeSingle();
    const examsTaken = activity?.exams_taken || 0;

    if (examsTaken === 0) {
      const { data: profile } = await supabaseAdmin.from('profiles').select('current_streak').eq('id', userId).maybeSingle();
      if (!profile) return;

      const { data: yesterdayActivity } = await supabaseAdmin.from('user_daily_activities').select('exams_taken, used_freeze').eq('user_id', userId).eq('activity_date', yesterday).maybeSingle();
      const isStreakMaintained = yesterdayActivity && (yesterdayActivity.exams_taken > 0 || yesterdayActivity.used_freeze);
      
      let newStreak = isStreakMaintained ? (profile?.current_streak || 0) + 1 : 1;
      await supabaseAdmin.from('profiles').update({ current_streak: newStreak }).eq('id', userId);

      // Fetch dynamic rules
      const { data: configData } = await supabaseAdmin.from('app_configs').select('value').eq('key', 'xp_rules').maybeSingle();
      const rules = (configData?.value as any) || {};

      let xpReward = rules.daily_login || 10;
      let notifTitle = { bn: 'ডেইলি গোল পূরণ! 🎉', en: 'Daily goal completed! 🎉' };
      let notifBody = { bn: `আজকের প্রথম পড়ার জন্য আপনি পেয়েছেন ${xpReward} XP!`, en: `You earned ${xpReward} XP for your first study session today.` };

      if (newStreak > 0 && newStreak % 30 === 0) {
        xpReward += (rules.streak_30_days || 300);
        notifTitle = { bn: '🔥 ৩০ দিনের ফায়ার স্ট্রিক!', en: '🔥 30-day study streak!' };
        notifBody = { bn: `অসাধারণ! টানা ৩০ দিন পড়াশোনা করার জন্য বোনাস হিসেবে পেয়েছেন সর্বমোট ${xpReward} XP!`, en: `Amazing! You earned a total bonus of ${xpReward} XP for studying 30 days in a row.` };
      } else if (newStreak > 0 && newStreak % 7 === 0) {
        xpReward += (rules.streak_7_days || 50);
        notifTitle = { bn: '🔥 ৭ দিনের স্ট্রিক!', en: '🔥 7-day study streak!' };
        notifBody = { bn: `দারুণ! টানা ৭ দিন পড়াশোনা করার জন্য বোনাস হিসেবে পেয়েছেন সর্বমোট ${xpReward} XP!`, en: `Great! You earned a total bonus of ${xpReward} XP for studying 7 days in a row.` };
      }

      await supabaseAdmin.rpc('update_user_progress', { p_user_id: userId, p_coins: 0, p_xp: xpReward });
      await notifyXpAndProgression(userId, {
        xp: xpReward,
        reason: 'streak_reward',
        title: notifTitle,
        body: notifBody,
        actionLink: '/dashboard/streak',
        dedupeKey: `streak_reward:${userId}:${today}`,
      });

      if (activity) {
        await supabaseAdmin.from('user_daily_activities').update({ exams_taken: 1 }).eq('id', activity.id);
      } else {
        await supabaseAdmin.from('user_daily_activities').insert({ user_id: userId, activity_date: today, exams_taken: 1, study_time_minutes: 0, xp_earned: xpReward });
      }
    }
  } catch (error) {
    console.error('❌ [STREAK LOG] Critical Server Error:', error);
  }
};
