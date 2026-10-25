import { supabaseAdmin } from '../../config/supabaseAdmin';

type GroupNotification = {
  type: string;
  titleBn: string;
  titleEn: string;
  bodyBn: string;
  bodyEn: string;
  actionLink?: string;
};

const MAX_RECIPIENTS_PER_INSERT = 200;

/**
 * Best-effort in-app notification. Groups must work even when the notification
 * table is unavailable, so failures are logged and swallowed.
 */
export const notifyGroupUsers = async (
  userIds: Array<string | null | undefined>,
  notification: GroupNotification
): Promise<void> => {
  const recipients = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))));

  if (recipients.length === 0) return;

  const rows = recipients.slice(0, MAX_RECIPIENTS_PER_INSERT).map((userId) => ({
    target_user_id: userId,
    title_bn: notification.titleBn,
    title_en: notification.titleEn,
    body_bn: notification.bodyBn,
    body_en: notification.bodyEn,
    type: notification.type,
    channel: 'in_app',
    action_link: notification.actionLink ?? '/groups',
  }));

  try {
    const { error } = await supabaseAdmin.from('notifications').insert(rows);
    if (error) {
      console.error('[groups:notification] insert failed:', error.message);
    }
  } catch (error) {
    console.error(
      '[groups:notification] insert threw:',
      error instanceof Error ? error.message : 'unknown error'
    );
  }

  // Push is best-effort and capped so a group-wide event cannot fan out into
  // hundreds of blocking FCM calls. A missing Firebase credential must never
  // fail the group action, so the module is loaded lazily inside try/catch.
  const pushRecipients = recipients.slice(0, 50);
  try {
    const { sendPushNotification } = await import('../notifications/notifications.service');
    void Promise.allSettled(
      pushRecipients.map((userId) =>
        sendPushNotification(
          userId,
          { bn: notification.titleBn, en: notification.titleEn },
          { bn: notification.bodyBn, en: notification.bodyEn },
          undefined,
          notification.actionLink ?? '/groups'
        )
      )
    );
  } catch (error) {
    console.error(
      '[groups:notification] push skipped:',
      error instanceof Error ? error.message : 'unknown error'
    );
  }
};
