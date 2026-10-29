import { supabase } from '../../config/supabase';
import { Language, parseLanguage } from '../../lib/utils/language';
import { MANDATORY_NOTIFICATION_TYPES, NotificationType } from './notifications.types';
import {
  markNotificationAsRead as markRead,
  getUnreadNotificationCount,
  normalizePreferences,
} from './notifications.service';

const notificationText = (language: Language, bn?: string | null, en?: string | null): string => {
  const preferred = language === 'en' ? en : bn;
  const fallback = language === 'en' ? bn : en;
  return preferred?.trim() || fallback?.trim() || '';
};

const isExpired = (expiresAt: string | null | undefined): boolean =>
  Boolean(expiresAt && new Date(expiresAt).getTime() < Date.now());

const matchesTargetRules = (rules: unknown, classLevel: string, subStatus: string): boolean => {
  if (!rules || typeof rules !== 'object') return true;
  const target = rules as Record<string, any>;

  if (
    target.subscription_status &&
    target.subscription_status !== 'all' &&
    target.subscription_status !== subStatus
  ) {
    return false;
  }

  if (Array.isArray(target.class_level) && target.class_level.length > 0) {
    if (!target.class_level.includes('all') && !target.class_level.includes(classLevel)) {
      return false;
    }
  }

  return true;
};

export const getUserNotifications = async (userId: string) => {
  const { data: profile } = await supabase
    .from('profiles')
    .select('class_level, subscription_status, language_preference, settings')
    .eq('id', userId)
    .single();

  const classLevel = profile?.class_level || 'all';
  const subStatus = profile?.subscription_status === 'active' ? 'premium' : 'free';
  const language = parseLanguage(profile?.language_preference);
  const preferences = normalizePreferences(
    (profile?.settings as Record<string, any> | null)?.notification_preferences
  );

  const { data: notifications, error: notifError } = await supabase
    .from('notifications')
    .select('*')
    .eq('status', 'sent')
    .or(`target_user_id.eq.${userId},target_user_id.is.null`)
    .order('created_at', { ascending: false });

  if (notifError) throw new Error(notifError.message);

  // Read state is fetched separately for this user: the service-role client
  // bypasses RLS, so an embedded select would leak every user's read state.
  const notificationIds = (notifications ?? []).map((row) => String(row.id));
  const readByNotification = new Map<string, { is_read: boolean; is_clicked: boolean }>();

  if (notificationIds.length > 0) {
    const { data: reads } = await supabase
      .from('notification_reads')
      .select('notification_id, is_read, is_clicked')
      .eq('user_id', userId)
      .in('notification_id', notificationIds);

    (reads ?? []).forEach((read) => {
      readByNotification.set(String(read.notification_id), {
        is_read: Boolean(read.is_read),
        is_clicked: Boolean(read.is_clicked),
      });
    });
  }

  const filteredNotifications = (notifications ?? []).filter((notification) => {
    if (isExpired(notification.expires_at)) return false;
    if (notification.target_user_id && notification.target_user_id !== userId) return false;
    if (!matchesTargetRules(notification.target_rules, classLevel, subStatus)) return false;

    const type = notification.type as NotificationType;
    const mandatory = MANDATORY_NOTIFICATION_TYPES.includes(type);
    if (!mandatory && preferences.types[type] === false) return false;
    if (!mandatory && !preferences.in_app) return false;
    if (!mandatory && notification.channel === 'push') return false;

    return true;
  });

  const withReadState = filteredNotifications.map((notification) => {
    const read = readByNotification.get(String(notification.id));
    return {
      ...notification,
      notification_reads: read ? [read] : [],
    };
  });

  const combined = [...withReadState].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return combined.map((notification) => ({
    ...notification,
    title: notificationText(language, notification.title_bn, notification.title_en),
    body: notificationText(language, notification.body_bn, notification.body_en),
  }));
};

export const getUnreadCount = async (userId: string): Promise<number> =>
  getUnreadNotificationCount(userId);

export const markNotificationAsRead = async (
  userId: string,
  notificationId: string,
  isClicked = false
) => {
  await markRead(userId, notificationId, isClicked);
};
