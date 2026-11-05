import { supabase } from '../../config/supabase';
import { NOTIFICATION_TYPES, NotificationType } from './notifications.types';
import { sendCampaignPush } from './notifications.service';

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

const parseCampaignDate = (value: unknown, field: string): Date | null => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${field}`);
  return date;
};

// --- CAMPAIGNS ---
export const createCampaign = async (campaignData: any, adminId: string) => {
  const scheduledFor = parseCampaignDate(campaignData.scheduled_at, 'scheduled_at');
  const expiresAt = parseCampaignDate(campaignData.expires_at, 'expires_at');
  const shouldSchedule = Boolean(
    scheduledFor && scheduledFor.getTime() > Date.now()
  );

  const { data, error } = await supabase
    .from('notifications')
    .insert({
      ...campaignData,
      type: normalizeCampaignType(campaignData.type),
      meta_data: {
        ...(campaignData.meta_data ?? {}),
        legacy_type: campaignData.type ?? null,
      },
      created_by: adminId,
      status: shouldSchedule ? 'scheduled' : 'sent',
      scheduled_at: scheduledFor?.toISOString() ?? null,
      expires_at: expiresAt?.toISOString() ?? null,
      sent_at: shouldSchedule ? null : new Date().toISOString(),
      total_sent: 0,
      total_clicks: 0,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  if (shouldSchedule) return data;

  // OneSignal delivery is attempted after the inbox record exists, so a push
  // failure can never erase the notification.
  try {
    const recipients = await sendCampaignPush({
      id: data.id,
      title_bn: campaignData.title_bn,
      title_en: campaignData.title_en,
      body_bn: campaignData.body_bn,
      body_en: campaignData.body_en,
      imageUrl: campaignData.image_url || null,
      actionLink: campaignData.action_link || '/',
      targetUserId: campaignData.target_user_id ?? null,
      targetRules: campaignData.target_rules ?? null,
      priority: campaignData.priority,
    });

    await supabase
      .from('notifications')
      .update({ total_sent: recipients })
      .eq('id', data.id);
    console.log(`Campaign broadcasted through OneSignal. Recipients: ${recipients}`);
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
