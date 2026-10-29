import { supabase } from '../../config/supabase';
import { supabaseAdmin } from '../../config/supabaseAdmin';
import { parseLanguage } from '../../lib/utils/language';
import { NOTIFICATION_TYPES, NotificationType } from './notifications.types';

const LEGACY_TYPE_MAP: Record<string, NotificationType> = {
  system: 'security',
  exam_alert: 'exam',
  promo: 'reward',
  group_invite: 'social',
  battle_challenge: 'social',
  focus_request: 'social',
  nudge_alert: 'social',
  global_notice: 'social',
  campaign: 'social',
};

const normalizeCampaignType = (value: unknown): NotificationType => {
  const raw = String(value ?? '').trim();
  if (NOTIFICATION_TYPES.includes(raw as NotificationType)) return raw as NotificationType;
  return LEGACY_TYPE_MAP[raw] ?? 'social';
};

const pushEnabled = (settings: unknown): boolean => {
  const value = (settings as Record<string, any> | null)?.notification_preferences?.push;
  return value !== false;
};

// --- CAMPAIGNS ---
export const createCampaign = async (campaignData: any, adminId: string) => {
  // ১. ডাটাবেসে সেভ করা (status 'scheduled' এর বদলে 'sent' দেওয়া হলো যাতে সাথে সাথে যায়)
  const { data, error } = await supabase.from('notifications').insert({ 
    ...campaignData, 
    type: normalizeCampaignType(campaignData.type),
    meta_data: {
      ...(campaignData.meta_data ?? {}),
      legacy_type: campaignData.type ?? null,
    },
    created_by: adminId, 
    status: 'sent', 
    total_sent: 0, 
    total_clicks: 0 
  }).select().single();
  
  if (error) throw new Error(error.message); 

  // ২. ফায়ারবেসের মাধ্যমে পুশ নোটিফিকেশন পাঠানো
  try {
    // সব ইউজারের ফায়ারবেস টোকেন নিয়ে আসা (যাদের টোকেন null নয়)
    const { data: userDevices } = await supabaseAdmin
      .from('user_devices')
      .select('user_id, fcm_token')
      .not('fcm_token', 'is', null);

    if (userDevices && userDevices.length > 0) {
      const { messaging } = await import('../../config/firebaseAdmin');
      const userIds = [...new Set(userDevices.map(device => device.user_id).filter(Boolean))] as string[];
      const { data: profiles } = userIds.length
        ? await supabaseAdmin.from('profiles').select('id, language_preference, settings').in('id', userIds)
        : { data: [] };
      const languageByUser = new Map((profiles || []).map(profile => [profile.id, parseLanguage(profile.language_preference)]));
      const pushAllowed = new Set((profiles || []).filter(profile => pushEnabled(profile.settings)).map(profile => profile.id));
      const tokensByLanguage: Record<'bn' | 'en', string[]> = { bn: [], en: [] };
      for (const device of userDevices) {
        if (device.fcm_token && pushAllowed.has(device.user_id)) {
          tokensByLanguage[languageByUser.get(device.user_id) || 'bn'].push(device.fcm_token);
        }
      }
      let successCount = 0;
      let failureCount = 0;
      for (const language of ['bn', 'en'] as const) {
        const tokens = tokensByLanguage[language];
        if (tokens.length === 0) continue;
        const title = language === 'en'
          ? campaignData.title_en || campaignData.title_bn || 'New Notification'
          : campaignData.title_bn || campaignData.title_en || 'নতুন বিজ্ঞপ্তি';
        const body = language === 'en'
          ? campaignData.body_en || campaignData.body_bn || ''
          : campaignData.body_bn || campaignData.body_en || '';
        const response = await messaging.sendEachForMulticast({
          data: {
            title,
            body,
            image_url: campaignData.image_url || '',
            action_link: campaignData.action_link || '/',
            type: 'campaign'
          },
          tokens
        });
        successCount += response.successCount;
        failureCount += response.failureCount;
      }
      // কতজনকে পাঠানো হলো সেই সংখ্যাটি ডাটাবেসে আপডেট করা
      await supabase.from('notifications').update({ total_sent: successCount }).eq('id', data.id);
      console.log(`Campaign broadcasted. Success: ${successCount}, Failed: ${failureCount}`);
    }
  } catch (pushError) {
    console.error('Error broadcasting push notification:', pushError);
  }

  return data;
};

export const getCampaigns = async () => {
  const { data, error } = await supabase.from('notifications').select('*').order('created_at', { ascending: false });
  if (error) throw new Error(error.message); return data;
};

export const cancelCampaign = async (id: string) => {
  const { data, error } = await supabase.from('notifications').update({ status: 'cancelled' }).eq('id', id).select().single();
  if (error) throw new Error(error.message); return data;
};

export const updateCampaign = async (id: string, payload: any) => {
  const nextPayload =
    payload && Object.prototype.hasOwnProperty.call(payload, 'type')
      ? { ...payload, type: normalizeCampaignType(payload.type) }
      : payload;
  const { data, error } = await supabase.from('notifications').update(nextPayload).eq('id', id).select().single();
  if (error) throw new Error(error.message); return data;
};

export const deleteCampaign = async (id: string) => {
  const { data, error } = await supabase.from('notifications').delete().eq('id', id).select().single();
  if (error) throw new Error(error.message); return data;
};
