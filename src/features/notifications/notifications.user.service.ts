import { supabase } from '../../config/supabase';
import { Language, parseLanguage } from '../../lib/utils/language';
import { getUnreadNotificationCount, markNotificationAsRead as markRead } from './notifications.service';

/**
 * The student inbox.
 *
 * Rows are read with the service client scoped to the authenticated user id, so
 * pagination happens in SQL instead of loading the whole inbox and slicing it in
 * memory. Read state is joined separately for the same reason: an embedded
 * select would see every user's rows.
 */

const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;

export type NotificationPage = {
  items: Array<Record<string, unknown>>;
  next_cursor: string | null;
};

const notificationText = (language: Language, bn?: string | null, en?: string | null): string => {
  const preferred = language === 'en' ? en : bn;
  const fallback = language === 'en' ? bn : en;
  return preferred?.trim() || fallback?.trim() || '';
};

const pageSize = (limit: unknown): number => {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE;
  return Math.min(Math.floor(parsed), MAX_PAGE);
};

export const getUserNotifications = async (
  userId: string,
  options: { limit?: unknown; before?: unknown } = {}
): Promise<NotificationPage> => {
  const { data: profile } = await supabase
    .from('profiles')
    .select('language_preference')
    .eq('id', userId)
    .maybeSingle();

  const language = parseLanguage(profile?.language_preference);
  const limit = pageSize(options.limit);
  const before = typeof options.before === 'string' && options.before.trim() ? options.before.trim() : null;

  let query = supabase
    .from('notifications')
    .select(
      'id, title_en, title_bn, body_en, body_bn, image_url, action_link, type, channel, priority, meta_data, event_code, created_at, expires_at'
    )
    .eq('status', 'sent')
    .or(`target_user_id.eq.${userId},target_user_id.is.null`)
    .neq('channel', 'push')
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order('created_at', { ascending: false })
    // One extra row tells us whether another page exists without a count query.
    .limit(limit + 1);

  if (before) query = query.lt('created_at', before);

  const { data: notifications, error } = await query;
  if (error) throw new Error(error.message);

  const rows = (notifications ?? []).slice(0, limit);
  const hasMore = (notifications ?? []).length > limit;
  const notificationIds = rows.map((row) => String(row.id));

  // Read state for this user only.
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

  const items = rows.map((notification) => {
    const read = readByNotification.get(String(notification.id));
    return {
      ...notification,
      title: notificationText(language, notification.title_bn, notification.title_en),
      body: notificationText(language, notification.body_bn, notification.body_en),
      notification_reads: read ? [read] : [],
    };
  });

  return {
    items,
    next_cursor: hasMore && rows.length > 0 ? String(rows[rows.length - 1].created_at) : null,
  };
};

export const getUnreadCount = async (userId: string): Promise<number> =>
  getUnreadNotificationCount(userId);

export const markNotificationAsRead = async (
  userId: string,
  notificationId: string,
  isClicked = false,
  platform: string | null = null
) => {
  await markRead(userId, notificationId, isClicked, platform);
};
