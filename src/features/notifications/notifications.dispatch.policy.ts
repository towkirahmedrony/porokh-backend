/**
 * Pure decisions the dispatcher makes around a single notification.
 *
 * Kept free of Supabase and Firebase imports so the rules can be tested without
 * a client, and so the retry schedule is defined in exactly one place.
 */

export const MAX_PUSH_ATTEMPTS = 3;

/** 1 minute, 5 minutes, 15 minutes. */
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];

/** A denial that will not change on its own; retrying it burns attempts. */
const TERMINAL_DENIALS = new Set(['push_disabled', 'category_disabled']);

/** Delay before the given attempt (1-based) may be retried. */
export const retryDelayMs = (attempt: number): number => {
  const index = Math.min(Math.max(Math.trunc(attempt), 1), RETRY_BACKOFF_MS.length) - 1;
  return RETRY_BACKOFF_MS[index];
};

export const isTerminalDenial = (reason: string): boolean =>
  TERMINAL_DENIALS.has(reason);

/**
 * A deferred push that cannot be sent before its expiry is dropped. Returning
 * it late is worse than not returning it: an exam reminder for an exam that has
 * already started is noise.
 */
export const shouldDropDeferredPush = (
  expiresAt: string | null | undefined,
  retryAfter: string | null | undefined
): boolean => {
  if (!expiresAt || !retryAfter) return false;

  const expiry = new Date(expiresAt).getTime();
  const retry = new Date(retryAfter).getTime();

  if (!Number.isFinite(expiry) || !Number.isFinite(retry)) return false;
  return expiry <= retry;
};

/**
 * Mirrors notification_event_meta() in the database. Used only to decide which
 * waiting row gets the last daily slot, so a security alert cannot lose it to a
 * reward notification that happened to be created a second earlier.
 */
export const priorityRank = (eventCode: string | null | undefined): number => {
  switch (eventCode) {
    case 'new_device_login':
      return 100;
    case 'exam_live_1h':
    case 'exam_live_10m':
      return 90;
    case 'exam_result':
      return 80;
    case 'streak_warning':
      return 70;
    case 'premium_expiring':
    case 'premium_granted':
    case 'premium_purchased':
      return 60;
    case 'pvp_challenge':
    case 'squad_invite':
    case 'community_reply':
    case 'squad_join_approved':
    case 'pvp_result':
      return 50;
    default:
      return 40;
  }
};

/** Attempts are counted per row; the fourth attempt must never be claimed. */
export const canAttemptPush = (attempts: unknown): boolean => {
  const used = Number(attempts ?? 0);
  return Number.isFinite(used) && used < MAX_PUSH_ATTEMPTS;
};

/** Remaining FCM lifetime for a row, or null when it never expires. */
export const remainingTtlMs = (
  expiresAt: string | null | undefined,
  now: Date = new Date()
): number | null => {
  if (!expiresAt) return null;

  const expiry = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiry)) return null;

  return expiry - now.getTime();
};
