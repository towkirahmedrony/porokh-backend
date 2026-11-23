import type { MulticastMessage } from 'firebase-admin/messaging';
import type { NotificationPriority } from './notifications.types';

/**
 * FCM payload shaping.
 *
 * A push carries routing hints and the notification text only. The record the
 * fields point at is always fetched from Supabase through RLS, so a payload that
 * leaks cannot expose another account's content.
 *
 * Two payload shapes exist because the two clients render differently:
 *
 * - Android gets a `notification` block, which the system displays even when the
 *   app is terminated, plus a data block with the canonical routing fields.
 * - The web client gets data-only pushes, which its service worker renders, and
 *   no `notification` block, so one message is never shown twice.
 */

/**
 * Android channels created natively on app start. The id is part of the payload
 * contract: a message naming a missing channel is silently dropped on Android 8+.
 */
export const ANDROID_CHANNEL_IDS = {
  exam: 'exam',
  security: 'security',
  general: 'general',
  social: 'social',
} as const;

export type AndroidChannelId = (typeof ANDROID_CHANNEL_IDS)[keyof typeof ANDROID_CHANNEL_IDS];

/** Resolves the channel from the stored notification type, not the priority. */
export const androidChannelForType = (type: string): AndroidChannelId => {
  if (type === 'exam') return ANDROID_CHANNEL_IDS.exam;
  if (type === 'security') return ANDROID_CHANNEL_IDS.security;
  if (type === 'social') return ANDROID_CHANNEL_IDS.social;
  return ANDROID_CHANNEL_IDS.general;
};

/** Delivery window for a push; a stale reminder must not arrive a week late. */
export const DEFAULT_PUSH_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_ACTION_LINK = '/';

/** Transport recorded for an installation in `user_devices`. */
export type DevicePlatform = 'web' | 'android';

/** Text language of one push. Bangla is the default for this product. */
export type PushLanguage = 'bn' | 'en';

export type PushDevice = {
  token: string;
  platform: DevicePlatform;
  language: PushLanguage;
  /** App installation id, used by the push log; never the token itself. */
  deviceId?: string | null;
};

export type PushCopy = {
  title: { bn: string; en: string };
  body: { bn: string; en: string };
  imageUrl?: string | null;
  actionLink?: string | null;
  type: string;
  notificationId?: string | null;
  priority?: NotificationPriority;
  /** Collapses repeated events of the same kind in the tray. */
  collapseKey?: string | null;
  /** Remaining lifetime in ms; derived from expires_at by the dispatcher. */
  ttlMs?: number | null;
};

export type FcmPushPayload = Omit<MulticastMessage, 'tokens'>;

export const normalizeDevicePlatform = (value: unknown): DevicePlatform =>
  String(value ?? '').trim().toLowerCase() === 'android' ? 'android' : 'web';

export const normalizePushLanguage = (value: unknown): PushLanguage => {
  const normalized = String(value ?? '').trim().toLowerCase();

  // Anything that is not an explicit English preference is served in Bangla:
  // a missing or malformed value must not push English to a Bangla user.
  return normalized.startsWith('en') ? 'en' : 'bn';
};

const nonEmpty = (value: string | null | undefined): string =>
  String(value ?? '').trim();

/**
 * Only an in-app route may be attached. An absolute or protocol-relative URL is
 * replaced with the home route so a payload can never navigate the app off-site.
 */
export const safeActionLink = (value: unknown): string => {
  const link = String(value ?? '').trim();

  if (!link || !link.startsWith('/') || link.startsWith('//')) {
    return DEFAULT_ACTION_LINK;
  }

  return link;
};

/**
 * Builds the payload for one platform and language.
 *
 * Both languages are also carried in `data` so the client can re-render the
 * notification in-app after a language switch or a cold start.
 */
export const buildFcmPushPayload = (
  copy: PushCopy,
  options: { platform?: DevicePlatform; language?: PushLanguage } = {}
): FcmPushPayload => {
  const platform = options.platform ?? 'web';
  const language = options.language ?? 'bn';

  const titleEn = nonEmpty(copy.title?.en) || nonEmpty(copy.title?.bn) || 'Porokh';
  const titleBn = nonEmpty(copy.title?.bn) || titleEn;
  const bodyEn = nonEmpty(copy.body?.en) || nonEmpty(copy.body?.bn) || titleEn;
  const bodyBn = nonEmpty(copy.body?.bn) || bodyEn;

  const title = language === 'bn' ? titleBn : titleEn;
  const body = language === 'bn' ? bodyBn : bodyEn;
  const actionLink = safeActionLink(copy.actionLink);
  const imageUrl = nonEmpty(copy.imageUrl);
  const type = nonEmpty(copy.type) || 'system';
  const notificationId = nonEmpty(copy.notificationId);
  const highPriority = copy.priority === 'high';
  const channelId = androidChannelForType(type);
  const collapseKey = nonEmpty(copy.collapseKey) || nonEmpty(type) || 'notification';
  const ttl = Math.max(
    60_000,
    Math.min(
      typeof copy.ttlMs === 'number' && Number.isFinite(copy.ttlMs)
        ? copy.ttlMs
        : DEFAULT_PUSH_TTL_MS,
      DEFAULT_PUSH_TTL_MS
    )
  );

  const data: Record<string, string> = {
    type,
    notification_id: notificationId,
    action_link: actionLink,
    event_code: nonEmpty(copy.collapseKey) || type,
    // `title`/`body` are the resolved values; the labeled pairs let the client
    // pick the other language without a second lookup.
    title,
    body,
    title_bn: titleBn,
    title_en: titleEn,
    body_bn: bodyBn,
    body_en: bodyEn,
  };

  if (imageUrl) data.image_url = imageUrl;

  if (platform === 'android') {
    return {
      notification: {
        title,
        body,
        ...(imageUrl ? { imageUrl } : {}),
      },
      data,
      android: {
        priority: highPriority ? 'high' : 'normal',
        ttl,
        collapseKey,
        notification: {
          channelId,
          sound: 'default',
          ...(imageUrl ? { imageUrl } : {}),
          // The tap opens the app; the client resolves action_link itself, so
          // no intent filter with a per-notification URI is needed.
          ...(notificationId ? { tag: notificationId } : {}),
        },
      },
    };
  }

  return {
    data,
    webpush: {
      // Data-only: the service worker owns rendering and click handling.
      headers: {
        Urgency: highPriority ? 'high' : 'normal',
        TTL: String(Math.floor(ttl / 1000)),
      },
      data: {
        type,
        notification_id: notificationId,
        action_link: actionLink,
        title,
        body,
        ...(imageUrl ? { image_url: imageUrl } : {}),
      },
    },
  };
};
