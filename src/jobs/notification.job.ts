import cron from 'node-cron';
import { supabaseAdmin } from '../config/supabaseAdmin';
import {
  notify,
  notifyPremiumExpiring,
  sendCampaignPush,
} from '../features/notifications/notifications.service';

const BATCH = 500;

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
      const now = new Date();
      const { data: campaigns, error } = await supabaseAdmin
        .from('notifications')
        .select(
          'id, title_bn, title_en, body_bn, body_en, image_url, action_link, target_rules, expires_at, priority, type, push_attempts'
        )
        .eq('status', 'scheduled')
        .lte('scheduled_at', now.toISOString())
        .order('scheduled_at', { ascending: true })
        .limit(50);
      if (error) throw error;
      if (!campaigns?.length) return;

      console.log(`🚀 Found ${campaigns.length} scheduled campaigns. Processing...`);
      for (const campaign of campaigns) {
        const expiresAt = campaign.expires_at
          ? new Date(campaign.expires_at)
          : null;

        // An expired notification is dropped instead of pushed late.
        if (expiresAt && expiresAt.getTime() <= now.getTime()) {
          await supabaseAdmin
            .from('notifications')
            .update({ status: 'cancelled' })
            .eq('id', campaign.id)
            .eq('status', 'scheduled');
          continue;
        }

        const attempt = Number(campaign.push_attempts ?? 0) + 1;
        // Any tick that repeats this delivery is stopped by the provider-side
        // idempotency key, so an overlapping or restarted worker cannot double
        // send a scheduled notification.
        const result = await sendCampaignPush({
          id: campaign.id,
          title_bn: campaign.title_bn,
          title_en: campaign.title_en,
          body_bn: campaign.body_bn,
          body_en: campaign.body_en,
          imageUrl: campaign.image_url || null,
          actionLink: campaign.action_link || '/',
          targetRules: campaign.target_rules,
          type: campaign.type,
          priority: campaign.priority === 'high' ? 'high' : 'normal',
        });

        const deliveredAt = new Date().toISOString();
        const { error: updateError } = await supabaseAdmin
          .from('notifications')
          .update({
            status: 'sent',
            sent_at: deliveredAt,
            total_sent: result.accepted,
            onesignal_message_id: result.messageId,
            provider_accepted_at: result.accepted > 0 ? deliveredAt : null,
            push_error: result.error ? result.error.slice(0, 500) : null,
            push_attempts: attempt,
          })
          .eq('id', campaign.id)
          .eq('status', 'scheduled');

        if (updateError) {
          console.error(`Failed to mark campaign ${campaign.id} as sent:`, updateError);
        } else {
          console.log(
            `✅ Campaign "${campaign.title_en || campaign.title_bn}" accepted for ${result.accepted} devices.`
          );
        }
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
