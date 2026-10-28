import { notify } from '../notifications/notifications.service';
import { NotifyInput } from '../notifications/notifications.types';

type GroupNotification = {
  type: string;
  titleBn: string;
  titleEn: string;
  bodyBn: string;
  bodyEn: string;
  actionLink?: string;
  dedupeKey?: NotifyInput['dedupeKey'];
  metaData?: Record<string, unknown>;
};

/**
 * Best-effort notification for group events. Groups must keep working when
 * notifications fail, so every failure is logged inside `notify` and never
 * propagated to the caller.
 */
export const notifyGroupUsers = async (
  userIds: Array<string | null | undefined>,
  notification: GroupNotification
): Promise<void> => {
  const recipients = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))));

  if (recipients.length === 0) return;

  await notify({
    userIds: recipients,
    type: 'social',
    eventCode: notification.type,
    title: { bn: notification.titleBn, en: notification.titleEn },
    body: { bn: notification.bodyBn, en: notification.bodyEn },
    actionLink: notification.actionLink ?? '/groups',
    channels: ['in_app', 'push'],
    // Group events can fan out to a whole squad; keep FCM work bounded.
    pushLimit: 50,
    dedupeKey: notification.dedupeKey ?? null,
    metaData: notification.metaData,
  });
};
