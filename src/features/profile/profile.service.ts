import { supabase } from '../../config/supabase';
import { supabaseAdmin } from '../../config/supabaseAdmin';
import { createUserSupabaseClient } from '../../config/userSupabase';
import { localizeRecord, parseLanguage } from '../../lib/utils/language';
import { DHAKA_UTC_OFFSET_MS, dhakaDayKey, startOfDhakaDay } from '../../lib/utils/time';
import {
  ActivityPoint,
  PlayerStats,
  StageResponse,
  StudyGoal,
  UserProfile,
  VersusStats,
} from './profile.types';
import { notifyXpAndProgression } from '../notifications/notifications.service';
import {
  buildProfileUpdatePayload,
  parseHscBatch,
  parseStageResponse,
  parseStudyGoal,
  parseThemePreference,
  ProfileValidationError,
} from './profile.validation';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

const DAY_MS = 24 * 60 * 60 * 1000;

const sanitizeProfileRecord = <T extends Record<string, any>>(profile: T): T => {
  if (!profile || typeof profile !== 'object') return profile;

  const settings = profile.settings;

  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return profile;
  }

  const safeSettings = { ...(settings as Record<string, unknown>) };
  delete safeSettings.two_factor_secret;

  return { ...profile, settings: safeSettings };
};

export class ProfileService {
  static async getProfileById(userId: string): Promise<UserProfile> {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
    if (error) throw new Error('Profile not found');
    return sanitizeProfileRecord(data) as UserProfile;
  }

  /**
   * Stage of the caller, read through their own JWT so `auth.uid()` inside the
   * RPC is the student and not the service role.
   */
  static async getMyStage(accessToken: string | undefined): Promise<StageResponse> {
    if (!accessToken) {
      throw new ProfileValidationError('Session unavailable', 401);
    }

    const { data, error } = await createUserSupabaseClient(accessToken).rpc('get_my_stage');

    if (error) {
      const unauthenticated = (error as { code?: string }).code === '28000';
      throw new ProfileValidationError(
        unauthenticated ? 'Session unavailable' : 'Stage is temporarily unavailable',
        unauthenticated ? 401 : 503
      );
    }

    return parseStageResponse(data);
  }

  /**
   * Records an explicit goal. This is the only write that confirms a goal, and
   * it refuses `hsc` once the server says the HSC exam is over.
   */
  static async setGoal(
    userId: string,
    accessToken: string | undefined,
    goal: unknown
  ): Promise<StageResponse> {
    if (!userId) throw new ProfileValidationError('Unauthorized', 401);

    const current = await ProfileService.getMyStage(accessToken);
    const next: StudyGoal = parseStudyGoal(goal, {
      allowHsc: current.stage !== 'post_hsc',
    });

    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ study_goal: next, goal_confirmed_at: new Date().toISOString() })
      .eq('id', userId);

    if (error) throw new Error(error.message);

    return ProfileService.getMyStage(accessToken);
  }

  /** A batch a student can belong to is a batch the admin has created. */
  private static async assertBatchExists(batch: string): Promise<void> {
    const { data, error } = await supabase
      .from('hsc_batches')
      .select('batch_year')
      .eq('batch_year', batch)
      .maybeSingle();

    if (error) throw new ProfileValidationError('HSC batch could not be verified', 503);
    if (!data) throw new ProfileValidationError('Unknown HSC batch');
  }

  static async updateProfile(
    userId: string,
    data: unknown,
    accessToken?: string
  ) {
    if (!userId) throw new Error('Unauthorized');

    // Build an explicit allowlisted payload; never pass req.body to Supabase.
    const safeUpdate = buildProfileUpdatePayload(data);

    if (Object.keys(safeUpdate).length === 0) {
      throw new Error('No editable profile fields supplied');
    }

    if (safeUpdate.hsc_batch !== undefined && safeUpdate.hsc_batch !== null) {
      await ProfileService.assertBatchExists(parseHscBatch(safeUpdate.hsc_batch));
    }

    // A goal change through the generic profile update is still a goal write,
    // so it gets the same confirmation stamp and the same post-exam rule.
    if ('study_goal' in safeUpdate) {
      if (safeUpdate.study_goal === null) {
        safeUpdate.goal_confirmed_at = null;
      } else {
        const current = await ProfileService.getMyStage(accessToken);
        safeUpdate.study_goal = parseStudyGoal(safeUpdate.study_goal, {
          allowHsc: current.stage !== 'post_hsc',
        });
        safeUpdate.goal_confirmed_at = new Date().toISOString();
      }
    }

    // আগের প্রোফাইল চেক করা হচ্ছে এক্সপি রিওয়ার্ডের জন্য
    const { data: oldProfile } = await supabase.from('profiles').select('avatar_url, institution, hsc_batch').eq('id', userId).single();
    
    const { data: updated, error } = await supabase.from('profiles').update(safeUpdate).eq('id', userId).select().single();
    if (error) throw new Error(error.message);

    // প্রোফাইল ১০০% সম্পন্ন হলে XP দেওয়ার লজিক
    if (oldProfile && updated) {
      const wasIncomplete = !oldProfile.avatar_url || !oldProfile.institution || !oldProfile.hsc_batch;
      const isNowComplete = updated.avatar_url && updated.institution && updated.hsc_batch;

      if (wasIncomplete && isNowComplete) {
        const { data: configData } = await supabaseAdmin.from('app_configs').select('value').eq('key', 'xp_rules').maybeSingle();
        const xpReward = (configData?.value as any)?.profile_completion || 50;
        
        const { error: xpErr } = await supabaseAdmin.rpc('update_user_progress', { p_user_id: userId, p_coins: 0, p_xp: xpReward });
        if (!xpErr) {
          // নোটিফিকেশন পাঠানোর ক্ষেত্রে error catch করা হলো যেন মেইন ফ্লো না ভাঙ্গে
          void notifyXpAndProgression(userId, {
            xp: xpReward,
            reason: 'profile_completion',
            title: { bn: 'প্রোফাইল সম্পন্ন হয়েছে! 🎉', en: 'Profile completed! 🎉' },
            body: {
              bn: `আপনার প্রোফাইলে প্রয়োজনীয় তথ্য যুক্ত করার জন্য আপনি পেয়েছেন ${xpReward} XP!`,
              en: `You earned ${xpReward} XP for completing your profile.`,
            },
            actionLink: '/profile',
            dedupeKey: `profile_completion:${userId}`,
          });
        }
      }
    }
    return sanitizeProfileRecord(updated);
  }

  static async updateThemePreference(userId: string, theme: unknown) {
    if (!userId) throw new Error('Unauthorized');

    const safeTheme = parseThemePreference(theme);

    const { data: profile } = await supabase.from('profiles').select('settings').eq('id', userId).single();
    
    const currentSettings = (profile?.settings as Record<string, any>) || {};
    const updatedSettings: Record<string, any> = { ...currentSettings, theme: safeTheme };
    delete updatedSettings.two_factor_secret;

    const { data, error } = await supabase
      .from('profiles')
      .update({ settings: updatedSettings })
      .eq('id', userId)
      .select('settings')
      .single();

    if (error) throw new Error(error.message);
    return data?.settings;
  }

  static async getPublicProfile(identifier: string) {
    let query = supabase.from('profiles').select('id, username, full_name, avatar_url, bio, total_xp, pvp_rating, current_streak, hsc_batch, study_goal, institution');

    if (isUuid(identifier)) query = query.eq('id', identifier);
    else query = query.eq('username', identifier);

    const { data, error } = await query.single();
    if (error) throw new Error('User not found');
    return data;
  }

  static async getUserBadges(userId: string) {
    // ব্যাজের আসল উৎস: profiles.achievements (jsonb আইডি অ্যারে) + achievements_master
    // ক্যাটালগ। ডাটাবেইজে user_badges নামে কোনো টেবিল নেই।
    const [{ data: profile }, { data: master, error }] = await Promise.all([
      supabase.from('profiles').select('achievements, language_preference').eq('id', userId).maybeSingle(),
      supabase.from('achievements_master').select('id, title, title_en, icon_url').order('xp_reward', { ascending: true }),
    ]);
    if (error) throw new Error('Failed to fetch user badges');

    const language = parseLanguage(profile?.language_preference);
    const earnedIds = new Set(
      (Array.isArray(profile?.achievements) ? (profile?.achievements as unknown[]) : [])
        .map((entry) => (typeof entry === 'string' ? entry : (entry as any)?.id))
        .filter((id): id is string => typeof id === 'string'),
    );

    // ফ্রন্টএন্ডের BadgeShowcase এই ফ্ল্যাট shape আশা করে (earned + unearned সব ব্যাজ)
    return (master || []).map((badge) => ({
      id: badge.id,
      title: localizeRecord(badge, language, ['title']).title,
      icon_url: badge.icon_url ?? null,
      is_earned: earnedIds.has(badge.id),
    }));
  }

  static async getExamStats(userId: string): Promise<Pick<PlayerStats, 'total_exams' | 'accuracy'>> {
    const { data, error } = await supabase
      .from('exam_history')
      .select('correct_count, wrong_count')
      .eq('user_id', userId);
    if (error) throw new Error('Failed to fetch exam stats');

    const rows = data || [];
    const correct = rows.reduce((sum, row) => sum + (row.correct_count ?? 0), 0);
    const wrong = rows.reduce((sum, row) => sum + (row.wrong_count ?? 0), 0);
    const answered = correct + wrong;

    return {
      total_exams: rows.length,
      // admin user-360 এর মতোই: skipped বাদ দিয়ে উত্তর দেয়া প্রশ্নের অনুপাত
      accuracy: answered > 0 ? Math.round((correct / answered) * 1000) / 10 : 0,
    };
  }

  static async getPlayerStats(userId: string): Promise<PlayerStats> {
    const [{ data: profile }, examStats] = await Promise.all([
      supabase.from('profiles').select('total_xp, current_streak').eq('id', userId).maybeSingle(),
      ProfileService.getExamStats(userId),
    ]);

    return {
      total_xp: profile?.total_xp ?? 0,
      current_streak: profile?.current_streak ?? 0,
      ...examStats,
    };
  }

  static async getVersusComparison(
    target: { id: string; total_xp: number | null; current_streak: number | null },
    viewerId?: string,
  ): Promise<VersusStats> {
    const [targetExamStats, viewerStats] = await Promise.all([
      ProfileService.getExamStats(target.id),
      viewerId && viewerId !== target.id ? ProfileService.getPlayerStats(viewerId) : Promise.resolve(null),
    ]);

    const theirStats: PlayerStats = {
      total_xp: target.total_xp ?? 0,
      current_streak: target.current_streak ?? 0,
      ...targetExamStats,
    };
    const myStats: PlayerStats = viewerStats
      ?? (viewerId === target.id ? theirStats : { total_xp: 0, accuracy: 0, current_streak: 0, total_exams: 0 });

    return { my_stats: myStats, their_stats: theirStats };
  }

  static async getActivityStats(targetId: string, viewerId?: string): Promise<ActivityPoint[]> {
    // "গত ৭ দিন" প্ল্যাটফর্মের বাকি অংশের মতো Asia/Dhaka ক্যালেন্ডার দিনে গোনা হয়
    const todayStart = startOfDhakaDay();
    const windowStart = new Date(todayStart.getTime() - 6 * DAY_MS);
    const isSelf = viewerId === targetId;
    const userIds = viewerId && !isSelf ? [targetId, viewerId] : [targetId];

    const { data, error } = await supabase
      .from('exam_history')
      .select('user_id, created_at')
      .in('user_id', userIds)
      .gte('created_at', windowStart.toISOString());
    if (error) throw new Error('Failed to fetch activity stats');

    const dayNames = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহঃ', 'শুক্র', 'শনি'];
    const points = new Map<string, ActivityPoint>();
    for (let offset = 6; offset >= 0; offset -= 1) {
      const dayInstant = new Date(todayStart.getTime() - offset * DAY_MS);
      const weekday = new Date(dayInstant.getTime() + DHAKA_UTC_OFFSET_MS).getUTCDay();
      points.set(dhakaDayKey(dayInstant), { day: dayNames[weekday], you: 0, them: 0 });
    }

    (data || []).forEach((entry) => {
      const point = points.get(dhakaDayKey(new Date(entry.created_at)));
      if (!point) return;
      if (entry.user_id === targetId) {
        point.them += 1;
        if (isSelf) point.you += 1;
      } else if (entry.user_id === viewerId) {
        point.you += 1;
      }
    });

    return Array.from(points.values());
  }
}
