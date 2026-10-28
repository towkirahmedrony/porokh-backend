import cron from 'node-cron';
import { supabase } from '../config/supabase';
import { supabaseAdmin } from '../config/supabaseAdmin';
import { parseLanguage } from '../lib/utils/language';
import {
  notify,
  notifyPremiumExpiring,
} from '../features/notifications/notifications.service';

const chooseText = (language: 'bn' | 'en', bn?: string | null, en?: string | null): string => {
  const preferred = language === 'en' ? en : bn;
  const fallback = language === 'en' ? bn : en;
  return preferred?.trim() || fallback?.trim() || '';
};

const BATCH = 500;

const pushEnabled = (settings: unknown): boolean => {
  const value = (settings as Record<string, any> | null)?.notification_preferences?.push;
  return value !== false;
};

const activeProfileIds = async (): Promise<string[]> => {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('account_status', 'active');

  if (error) {
    console.error('[notifications:cron] profile lookup failed:', error.message);
    return [];
  }
  return (data ?? []).map((row) => String(row.id));
};

const dhakaDate = (offsetDays = 0): string =>
  new Date(Date.now() + 6 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

const examTitle = (exam: Record<string, any>): string =>
  String(exam.title_en || exam.title || 'Exam');

const sendLiveExamReminders = async (minutes: number): Promise<void> => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const until = new Date(now + minutes * 60 * 1000).toISOString();

  const { data: exams, error } = await supabaseAdmin
    .from('exam_papers')
    .select('id, title, title_en, start_time')
    .eq('is_published', true)
    .gt('start_time', nowIso)
    .lte('start_time', until);

  if (error || !exams?.length) {
    if (error) console.error('[notifications:cron] live exam lookup failed:', error.message);
    return;
  }

  const userIds = await activeProfileIds();
  if (userIds.length === 0) return;

  for (const exam of exams) {
    const eventCode = minutes <= 10 ? 'exam_live_10m' : 'exam_live_1h';
    await notify({
      userIds,
      type: 'exam',
      eventCode,
      templateCode: eventCode,
      variables: { exam_title: examTitle(exam) },
      channels: ['in_app', 'push'],
      priority: 'high',
      actionLink: '/exam/live',
      dedupeKey: (userId) => `${eventCode}:${exam.id}:${userId}`,
      metaData: { exam_id: exam.id },
    });
  }
};

const publishDueExamResults = async (): Promise<void> => {
  const now = Date.now();
  const since = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date(now).toISOString();

  const { data: exams, error } = await supabaseAdmin
    .from('exam_papers')
    .select('id, title, title_en')
    .eq('is_published', true)
    .lte('result_publish_time', nowIso)
    .gte('result_publish_time', since);

  if (error || !exams?.length) {
    if (error) console.error('[notifications:cron] result lookup failed:', error.message);
    return;
  }

  for (const exam of exams) {
    const { data: histories } = await supabaseAdmin
      .from('exam_history')
      .select('user_id, score, rank')
      .eq('exam_id', exam.id);

    const historyByUser = new Map(
      (histories ?? []).map((row) => [String(row.user_id), row])
    );

    for (let index = 0; index < (histories ?? []).length; index += BATCH) {
      const rows = (histories ?? []).slice(index, index + BATCH);
      if (rows.length === 0) continue;

      await notify({
        userIds: rows.map((row) => String(row.user_id)),
        type: 'exam',
        eventCode: 'exam_result',
        templateCode: 'exam_result',
        variables: (userId) => {
          const history = historyByUser.get(userId);
          return {
            exam_title: examTitle(exam),
            score: history?.score ?? '-',
            rank: history?.rank ? `#${history.rank}` : '-',
          };
        },
        channels: ['in_app'],
        actionLink: '/history',
        dedupeKey: (userId) => `exam_result:${exam.id}:${userId}`,
        metaData: { exam_id: exam.id },
      });
    }
  }
};

const sendPremiumExpiryReminders = async (): Promise<void> => {
  const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const end = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);

  const { data: profiles, error } = await supabaseAdmin
    .from('profiles')
    .select('id, subscription_expiry')
    .eq('subscription_status', 'active')
    .eq('account_status', 'active')
    .gte('subscription_expiry', start.toISOString())
    .lt('subscription_expiry', end.toISOString());

  if (error) {
    console.error('[notifications:cron] premium expiry lookup failed:', error.message);
    return;
  }

  for (const profile of profiles ?? []) {
    const expiry = new Date(profile.subscription_expiry).getTime();
    const daysLeft = Math.max(1, Math.ceil((expiry - Date.now()) / (24 * 60 * 60 * 1000)));
    await notifyPremiumExpiring(String(profile.id), daysLeft, String(profile.subscription_expiry));
  }
};

const sendStreakWarnings = async (): Promise<void> => {
  const today = dhakaDate();

  const { data: profiles, error } = await supabaseAdmin
    .from('profiles')
    .select('id, current_streak')
    .eq('account_status', 'active')
    .gt('current_streak', 0)
    .not('current_streak', 'is', null);

  if (error || !profiles?.length) {
    if (error) console.error('[notifications:cron] streak lookup failed:', error.message);
    return;
  }

  const { data: activity } = await supabaseAdmin
    .from('user_daily_activities')
    .select('user_id')
    .eq('activity_date', today)
    .gt('exams_taken', 0);

  const activeUsers = new Set((activity ?? []).map((row) => String(row.user_id)));
  const atRisk = (profiles ?? []).filter((profile) => !activeUsers.has(String(profile.id)));

  if (atRisk.length === 0) return;

  const streakById = new Map(
    atRisk.map((profile) => [String(profile.id), Number(profile.current_streak ?? 0)])
  );

  await notify({
    userIds: atRisk.map((profile) => String(profile.id)),
    type: 'streak',
    eventCode: 'streak_warning',
    templateCode: 'streak_warning',
    variables: (userId) => ({ streak: streakById.get(userId) ?? 0 }),
    channels: ['in_app', 'push'],
    priority: 'high',
    actionLink: '/dashboard/streak',
    dedupeKey: (userId) => `streak_warning:${userId}:${today}`,
  });
};

export const initNotificationCron = () => {
  console.log('⏳ Notification Cron Job Initialized (campaigns 1m, exams 5m, daily 09:00/19:00 Asia/Dhaka)...');

  cron.schedule('* * * * *', async () => {
    try {
      const { data: campaigns, error } = await supabase
        .from('notifications')
        .select('id, title_bn, title_en, body_bn, body_en, image_url, action_link, target_user_id')
        .eq('status', 'scheduled');
      if (error) throw error;
      if (!campaigns?.length) return;

      console.log(`🚀 Found ${campaigns.length} scheduled campaigns. Processing...`);
      for (const campaign of campaigns) {
        let successCount = 0;
        try {
          let deviceQuery = supabaseAdmin.from('user_devices').select('user_id, fcm_token').not('fcm_token', 'is', null);
          if (campaign.target_user_id) deviceQuery = deviceQuery.eq('user_id', campaign.target_user_id);
          const { data: devices, error: deviceError } = await deviceQuery;
          if (deviceError) throw deviceError;

          const { messaging } = await import('../config/firebaseAdmin');
          const userIds = [...new Set((devices || []).map((device) => device.user_id).filter(Boolean))] as string[];
          const { data: profiles, error: profileError } = userIds.length
            ? await supabaseAdmin.from('profiles').select('id, language_preference, settings').in('id', userIds)
            : { data: [], error: null };
          if (profileError) throw profileError;
          const languages = new Map((profiles || []).map((profile) => [profile.id, parseLanguage(profile.language_preference)]));
          const pushAllowed = new Set((profiles || []).filter((profile) => pushEnabled(profile.settings)).map((profile) => profile.id));
          const tokensByLanguage: Record<'bn' | 'en', string[]> = { bn: [], en: [] };
          for (const device of devices || []) {
            if (device.fcm_token && pushAllowed.has(device.user_id)) {
              tokensByLanguage[languages.get(device.user_id) || 'bn'].push(device.fcm_token);
            }
          }

          for (const language of ['bn', 'en'] as const) {
            const tokens = tokensByLanguage[language];
            if (!tokens.length) continue;
            const response = await messaging.sendEachForMulticast({
              data: {
                title: chooseText(language, campaign.title_bn, campaign.title_en) || 'New Notification',
                body: chooseText(language, campaign.body_bn, campaign.body_en),
                image_url: campaign.image_url || '',
                action_link: campaign.action_link || '/',
                type: 'campaign',
              },
              tokens,
            });
            successCount += response.successCount;
          }
        } catch (pushError) {
          // Mark once after the attempt to avoid duplicate sends on the next cron tick.
          console.error(`Failed to deliver scheduled campaign ${campaign.id}:`, pushError);
        }

        const { error: updateError } = await supabase.from('notifications')
          .update({ status: 'sent', sent_at: new Date().toISOString(), total_sent: successCount })
          .eq('id', campaign.id);
        if (updateError) console.error(`Failed to mark campaign ${campaign.id} as sent:`, updateError);
        else console.log(`✅ Campaign "${campaign.title_en || campaign.title_bn}" sent to ${successCount} devices.`);
      }
    } catch (error) {
      console.error('🔥 Error in Notification Cron Job:', error);
    }
  });

  cron.schedule('*/5 * * * *', () => {
    void sendLiveExamReminders(60);
  });

  cron.schedule('*/5 * * * *', () => {
    void sendLiveExamReminders(10);
  });

  cron.schedule('*/10 * * * *', async () => {
    await publishDueExamResults();

    // A crash between the pending insert and the sent update must not leave a
    // notification invisible forever.
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { error } = await supabaseAdmin
      .from('notifications')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('status', 'pending')
      .lt('created_at', cutoff);
    if (error) console.error('[notifications:cron] pending recovery failed:', error.message);
  });

  cron.schedule('0 9 * * *', () => {
    void sendPremiumExpiryReminders();
  }, { timezone: 'Asia/Dhaka' });

  cron.schedule('0 19 * * *', () => {
    void sendStreakWarnings();
  }, { timezone: 'Asia/Dhaka' });
};
