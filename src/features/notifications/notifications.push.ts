import type { DevicePlatform } from './notifications.types';

/**
 * FCM payload shaping.
 *
 * Web Push is delivered by `firebase-messaging-sw.js`, which reads the message
 * `data` and calls `showNotification` itself. Sending a `notification` block to
 * a web token would let the browser display its own notification as well, so the
 * web payload must stay data-only.
 *
 * Android is the opposite: a data-only message is not displayed when the app is
 * backgrounded or terminated, so it must carry a `notification` block. The
 * plugin still exposes the `data` keys to the JS layer for the tap action.
 */

/** Android channel created by the app; also declared in AndroidManifest. */
export const PUSH_CHANNEL_ID = 'porokh_default';

/** Android first: a phone notification is the delivery mechanism users see. */
export const PUSH_PLATFORM_ORDER: DevicePlatform[] = ['android', 'web'];

export type PushDeviceRow = {
  fcm_token: string | null;
  platform?: string | null;
};

export type PushCopy = {
  title: string;
  body: string;
  imageUrl?: string | null;
  actionLink?: string | null;
  type: string;
  notificationId?: string | null;
};

export const normalizeDevicePlatform = (value: unknown): DevicePlatform =>
  String(value ?? '').trim().toLowerCase() === 'android' ? 'android' : 'web';

/**
 * Splits registered tokens by platform, dropping blanks and duplicates.
 *
 * A token is unique per installation, so one token must be sent exactly once
 * even if two rows somehow carry it.
 */
export const groupTokensByPlatform = (
  devices: PushDeviceRow[]
): Record<DevicePlatform, string[]> => {
  const grouped: Record<DevicePlatform, string[]> = { android: [], web: [] };
  const seen = new Set<string>();

  for (const device of devices) {
    const token = String(device.fcm_token ?? '').trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    grouped[normalizeDevicePlatform(device.platform)].push(token);
  }

  return grouped;
};

const pushData = (copy: PushCopy): Record<string, string> => ({
  title: copy.title,
  body: copy.body,
  image_url: copy.imageUrl || '',
  action_link: copy.actionLink || '/',
  type: copy.type,
  notification_id: copy.notificationId || '',
});

export type PushMessage = {
  tokens: string[];
  data: Record<string, string>;
  notification?: { title: string; body: string; imageUrl?: string };
  android?: {
    priority: 'high';
    notification: { channelId: string; sound: string; imageUrl?: string };
  };
};

/**
 * Builds the multicast message for one platform.
 *
 * The return type is structural on purpose: importing `firebase-admin` here
 * would construct the Firebase app as a side effect of importing the
 * notification service.
 */
export const buildPushMessage = (
  tokens: string[],
  platform: DevicePlatform,
  copy: PushCopy
): PushMessage => {
  const data = pushData(copy);

  if (platform !== 'android') {
    return { tokens, data };
  }

  return {
    tokens,
    data,
    notification: {
      title: copy.title || 'Porokh',
      body: copy.body,
      ...(copy.imageUrl ? { imageUrl: copy.imageUrl } : {}),
    },
    android: {
      // High priority lets FCM wake a terminated app instead of batching the
      // message until the next time the device happens to check in.
      priority: 'high',
      notification: {
        channelId: PUSH_CHANNEL_ID,
        sound: 'default',
        ...(copy.imageUrl ? { imageUrl: copy.imageUrl } : {}),
      },
    },
  };
};
