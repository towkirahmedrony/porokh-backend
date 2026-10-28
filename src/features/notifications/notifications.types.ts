export interface IMarkReadPayload {
  notification_id: string;
  is_clicked?: boolean;
}

export interface IDeviceTokenPayload {
  device_id: string;
  device_name?: string;
  os_or_browser?: string;
  fcm_token: string | null;
  ip_address?: string | null;
}

/** The only notification categories the product supports. */
export type NotificationType = 'exam' | 'reward' | 'streak' | 'social' | 'billing' | 'security';

export type NotificationPriority = 'low' | 'normal' | 'high';

export type NotificationChannel = 'in_app' | 'push';

export type BilingualCopy = { bn: string; en: string };

export interface NotifyInput {
  /** A single user id or a list. Duplicates are removed before delivery. */
  userIds: string | string[];
  type: NotificationType;
  /** Stable event identifier, e.g. `exam_live_10m`, `level_up`. */
  eventCode: string;
  /** Optional template_code in notification_templates. Falls back to copy. */
  templateCode?: string;
  title?: BilingualCopy;
  body?: BilingualCopy;
  actionLink?: string;
  imageUrl?: string;
  priority?: NotificationPriority;
  metaData?: Record<string, unknown>;
  /** Defaults to in-app only. Push is opt-in for time-sensitive events. */
  channels?: NotificationChannel[];
  /** Caps push fan-out for large group events; in-app is still delivered to all. */
  pushLimit?: number;
  /**
   * Values interpolated into `{{variable}}` placeholders. A function receives
   * the recipient so per-user values (score, streak length) stay correct in a
   * single broadcast call.
   */
  variables?:
    | Record<string, string | number | null | undefined>
    | ((userId: string) => Record<string, string | number | null | undefined>);
  /**
   * Idempotency key. A function receives the recipient so broadcast events
   * can still produce one key per user (`result:{exam}:{user}`).
   */
  dedupeKey?: string | ((userId: string) => string) | null;
  expiresAt?: string | null;
  createdBy?: string | null;
}

export interface NotifyResult {
  inserted: number;
  pushed: number;
  skipped: number;
}

export interface NotificationPreferences {
  types: Record<NotificationType, boolean>;
  in_app: boolean;
  push: boolean;
}

export const NOTIFICATION_TYPES: NotificationType[] = [
  'exam',
  'reward',
  'streak',
  'social',
  'billing',
  'security',
];

/** Types the user is never allowed to disable. */
export const MANDATORY_NOTIFICATION_TYPES: NotificationType[] = ['billing', 'security'];

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  types: {
    exam: true,
    reward: true,
    streak: true,
    social: true,
    billing: true,
    security: true,
  },
  in_app: true,
  push: true,
};
