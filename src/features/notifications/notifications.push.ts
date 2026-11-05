import { createHash } from 'crypto';
import type { BilingualCopy, NotificationPriority } from './notifications.types';

/**
 * OneSignal payload shaping.
 *
 * A push carries identifiers and routing hints only. The OS renders the title
 * and body, but the record those fields point at is always fetched from Supabase
 * through RLS, so a leaked payload cannot expose another account's content.
 *
 * Recipients are addressed as `include_aliases.external_id` — the Supabase user
 * UUID the device logged in with. OneSignal then reaches every subscription of
 * that user, which is what makes multi-device delivery work without a token
 * table here.
 */

/** Documented maximum number of `external_id` aliases per create-message call. */
export const PUSH_ALIAS_LIMIT = 20_000;

/** Transport recorded for an installation in `user_devices`. */
export type DevicePlatform = 'web' | 'android';

export type PushCopy = {
  title: BilingualCopy;
  body: BilingualCopy;
  imageUrl?: string | null;
  actionLink?: string | null;
  type: string;
  notificationId?: string | null;
  priority?: NotificationPriority;
};

export type OneSignalPushMessage = {
  target_channel: 'push';
  include_aliases: { external_id: string[] };
  headings: { en: string; bn: string };
  contents: { en: string; bn: string };
  data: Record<string, string>;
  big_picture?: string;
  priority?: number;
  idempotency_key?: string;
};

/** OneSignal priority 10 = high, which wakes a dozing device immediately. */
const ONESIGNAL_HIGH_PRIORITY = 10;

export const normalizeDevicePlatform = (value: unknown): DevicePlatform =>
  String(value ?? '').trim().toLowerCase() === 'android' ? 'android' : 'web';

/**
 * Trims and de-duplicates recipient ids. The same user must appear once even if
 * two registrations point at them, otherwise the alias list carries duplicates.
 */
export const normalizeExternalIds = (
  values: Array<string | null | undefined>
): string[] => {
  const seen = new Set<string>();

  for (const value of values) {
    const id = String(value ?? '').trim();
    if (id) seen.add(id);
  }

  return Array.from(seen);
};

/** Splits a recipient list into requests OneSignal will accept. */
export const chunkExternalIds = (
  ids: string[],
  size = PUSH_ALIAS_LIMIT
): string[][] => {
  const chunkSize = Math.max(1, Math.floor(size));
  const chunks: string[][] = [];

  for (let index = 0; index < ids.length; index += chunkSize) {
    chunks.push(ids.slice(index, index + chunkSize));
  }

  return chunks;
};

const nonEmpty = (value: string | null | undefined): string =>
  String(value ?? '').trim();

const IDEMPOTENCY_NAMESPACE = 'porokh:notification:idempotency:v1';

/**
 * OneSignal requires `idempotency_key` to be a real UUID, not an arbitrary
 * string. The key is derived from the notification, attempt and chunk so it is
 * stable for a repeated send but changes on a retry or a second chunk.
 *
 * The digest is formatted as a UUID with the version-5 nibble and RFC 4122
 * variant bits set, which is what the provider validates.
 */
export const buildNotificationIdempotencyKey = (
  notificationId: string,
  attempt: number,
  chunkIndex = 0
): string => {
  const id = String(notificationId ?? '').trim();
  if (!id) throw new Error('Notification id is required for an idempotency key');

  const normalizedAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  const normalizedChunk = Math.max(0, Math.floor(Number(chunkIndex) || 0));
  const seed = `${IDEMPOTENCY_NAMESPACE}|${id}|${normalizedAttempt}|${normalizedChunk}`;

  const bytes = Buffer.from(createHash('sha256').update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
};

/**
 * Builds the create-message body for one chunk of recipients.
 *
 * Both languages are sent in every message: Android picks the heading and
 * contents that match the device locale, which is a better signal than the
 * profile row's stored preference and removes the old per-language fan-out.
 */
export const buildOneSignalMessage = (
  externalIds: string[],
  copy: PushCopy,
  options: { idempotencyKey?: string | null } = {}
): OneSignalPushMessage => {
  const recipients = normalizeExternalIds(externalIds);
  if (recipients.length === 0) throw new Error('No push recipients');

  const titleEn = nonEmpty(copy.title?.en) || nonEmpty(copy.title?.bn) || 'Porokh';
  const titleBn = nonEmpty(copy.title?.bn) || titleEn;
  const bodyEn = nonEmpty(copy.body?.en) || titleEn;
  const bodyBn = nonEmpty(copy.body?.bn) || bodyEn;

  const message: OneSignalPushMessage = {
    target_channel: 'push',
    include_aliases: { external_id: recipients },
    headings: { en: titleEn, bn: titleBn },
    contents: { en: bodyEn, bn: bodyBn },
    // Minimal routing metadata: the client validates `action_link` against the
    // routes this build serves and opens the record from Supabase.
    data: {
      type: copy.type,
      notification_id: nonEmpty(copy.notificationId),
      action_link: nonEmpty(copy.actionLink) || '/',
    },
  };

  const imageUrl = nonEmpty(copy.imageUrl);
  if (imageUrl) message.big_picture = imageUrl;

  if (copy.priority === 'high') message.priority = ONESIGNAL_HIGH_PRIORITY;

  const idempotencyKey = nonEmpty(options.idempotencyKey);
  if (idempotencyKey) message.idempotency_key = idempotencyKey;

  return message;
};
