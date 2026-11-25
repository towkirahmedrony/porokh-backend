import { supabaseAdmin } from '../../config/supabaseAdmin';
import {
  loadDeviceTokens,
  sendCampaignPush,
  sendPushToDevices,
} from './notifications.service';
import { pushFailureReason, recordAudit } from './notifications.admin.service';
import type { NotificationPriority } from './notifications.types';
import {
  MAX_PUSH_ATTEMPTS,
  isTerminalDenial,
  priorityRank,
  remainingTtlMs,
  retryDelayMs,
  shouldDropDeferredPush,
} from './notifications.dispatch.policy';

/**
 * The only push sender.
 *
 * Postgres decides *what* should happen (can_send_push) and *when* a row is due
 * (pg_cron planners). This loop claims one row at a time, asks the policy
 * function, sends, and records the per-device outcome. Two callers — the
 * in-process timer and cron-job.org — can run it at once because the claim is a
 * compare-and-set on push_attempts.
 */

const MAX_ATTEMPTS = MAX_PUSH_ATTEMPTS;
const BATCH_SIZE = 25;
/**
 * A student with no registered device has not failed to receive anything: the
 * app simply is not installed on a device yet. The row is parked for an hour
 * instead of being closed, so signing in on a phone today still delivers it
 * without the loop retrying the same row every tick.
 */
const NO_DEVICE_RETRY_MS = 60 * 60 * 1000;

type NotificationRow = {
  id: string;
  target_user_id: string | null;
  title_en: string | null;
  title_bn: string | null;
  body_en: string | null;
  body_bn: string | null;
  image_url: string | null;
  action_link: string | null;
  type: string;
  channel: string;
  priority: string | null;
  event_code: string | null;
  created_at: string | null;
  expires_at: string | null;
  push_attempts: number | null;
};

type PushDecision = {
  allowed: boolean;
  reason: string;
  retryAfter: string | null;
};

export type DispatchSummary = {
  claimed: number;
  sent: number;
  skipped: number;
  deferred: number;
  failed: number;
  campaigns: number;
};

const iso = (value: number | Date): string => new Date(value).toISOString();

const readPolicy = async (
  userId: string,
  eventCode: string,
  now: Date
): Promise<PushDecision> => {
  const { data, error } = await supabaseAdmin.rpc('can_send_push', {
    p_user_id: userId,
    p_event_code: eventCode,
    p_now: now.toISOString(),
  });

  if (error) throw new Error(error.message);

  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: Boolean(row?.allowed),
    reason: String(row?.reason ?? 'unknown'),
    retryAfter: row?.retry_after ? String(row.retry_after) : null,
  };
};

const claim = async (id: string, attempt: number, now: Date): Promise<boolean> => {
  const { data, error } = await supabaseAdmin
    .from('notifications')
    .update({
      push_attempts: attempt,
      push_next_attempt_at: iso(now.getTime() + retryDelayMs(attempt)),
    })
    .eq('id', id)
    .eq('status', 'sent')
    .is('push_sent_at', null)
    .eq('push_attempts', attempt - 1)
    .select('id');

  if (error) {
    console.error('[dispatch] claim failed:', error.message);
    return false;
  }

  return Boolean(data?.length);
};

const closeRow = async (
  id: string,
  patch: Record<string, unknown>
): Promise<void> => {
  const { error } = await supabaseAdmin.from('notifications').update(patch).eq('id', id);
  if (error) console.error('[dispatch] update failed:', error.message);
};

const logPush = async (
  userId: string,
  notificationId: string,
  results: Array<{
    deviceId: string | null;
    status: 'accepted' | 'failed' | 'invalid_token' | 'skipped' | 'deferred';
    errorCode?: string | null;
    fcmMessageId?: string | null;
  }>
): Promise<void> => {
  if (results.length === 0) return;

  const rows = results.map((result) => ({
    user_id: userId,
    notification_id: notificationId,
    device_id: result.deviceId,
    status: result.status,
    error_code: result.errorCode ?? null,
    fcm_message_id: result.fcmMessageId ?? null,
  }));

  const { error } = await supabaseAdmin.from('notification_push_log').insert(rows);
  if (error) console.error('[dispatch] push log failed:', error.message);
};

const defer = async (
  row: NotificationRow,
  attempt: number,
  decision: PushDecision,
  now: Date
): Promise<'deferred' | 'skipped'> => {
  const retryAt = decision.retryAfter ? new Date(decision.retryAfter) : null;
  // A reminder that cannot be sent before it expires is dropped instead of
  // arriving late.
  if (shouldDropDeferredPush(row.expires_at, decision.retryAfter)) {
    await closeRow(row.id, {
      push_attempts: MAX_ATTEMPTS,
      push_next_attempt_at: null,
      push_error: `dropped:${decision.reason}`,
    });
    await logPush(row.target_user_id!, row.id, [
      { deviceId: null, status: 'skipped', errorCode: `dropped:${decision.reason}` },
    ]);
    return 'skipped';
  }

  const nextAttempt = retryAt ?? new Date(now.getTime() + retryDelayMs(attempt));

  // A deferral is not a send attempt, so the attempt counter is given back.
  await closeRow(row.id, {
    push_attempts: attempt - 1,
    push_next_attempt_at: nextAttempt.toISOString(),
    push_error: null,
  });
  await logPush(row.target_user_id!, row.id, [
    { deviceId: null, status: 'deferred', errorCode: decision.reason },
  ]);
  return 'deferred';
};

const dispatchOne = async (
  row: NotificationRow,
  now: Date
): Promise<keyof Pick<DispatchSummary, 'sent' | 'skipped' | 'deferred' | 'failed'>> => {
  const userId = row.target_user_id;
  if (!userId) return 'skipped';

  const attempt = Number(row.push_attempts ?? 0) + 1;
  if (attempt > MAX_ATTEMPTS) return 'skipped';

  if (!(await claim(row.id, attempt, now))) return 'skipped';

  // A row without an event code predates this system; fall back to its type so
  // the policy still applies instead of blocking the push outright.
  const eventCode = row.event_code ?? row.type;

  let decision: PushDecision;
  try {
    decision = await readPolicy(userId, eventCode, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'policy unavailable';
    await closeRow(row.id, {
      push_attempts: attempt - 1,
      push_next_attempt_at: iso(now.getTime() + retryDelayMs(1)),
      push_error: message.slice(0, 300),
    });
    return 'deferred';
  }

  if (!decision.allowed) {
    if (isTerminalDenial(decision.reason)) {
      await closeRow(row.id, {
        push_attempts: MAX_ATTEMPTS,
        push_next_attempt_at: null,
        push_error: `skipped:${decision.reason}`,
      });
      await logPush(userId, row.id, [
        { deviceId: null, status: 'skipped', errorCode: decision.reason },
      ]);
      return 'skipped';
    }

    return defer(row, attempt, decision, now);
  }

  const devices = await loadDeviceTokens([userId]);
  if (devices.length === 0) {
    // No device is a skip, not an attempt: the claim is given back so the row
    // keeps its full retry budget for the day the user registers a device.
    await closeRow(row.id, {
      push_attempts: attempt - 1,
      push_next_attempt_at: iso(now.getTime() + NO_DEVICE_RETRY_MS),
      push_error: 'no_registered_devices',
    });
    await logPush(userId, row.id, [
      { deviceId: null, status: 'deferred', errorCode: 'no_registered_devices' },
    ]);
    return 'deferred';
  }

  const ttlMs = remainingTtlMs(row.expires_at, now);

  const outcome = await sendPushToDevices(devices, {
    title: { bn: row.title_bn ?? '', en: row.title_en ?? '' },
    body: { bn: row.body_bn ?? '', en: row.body_en ?? '' },
    imageUrl: row.image_url,
    actionLink: row.action_link,
    type: row.type,
    notificationId: row.id,
    priority: (row.priority === 'high' ? 'high' : 'normal') as NotificationPriority,
    collapseKey: eventCode,
    ttlMs,
  });

  await logPush(
    userId,
    row.id,
    outcome.results.map((result) => ({
      deviceId: result.deviceId,
      status: result.status,
      errorCode: result.status === 'accepted' ? null : outcome.error,
      fcmMessageId: outcome.messageId,
    }))
  );

  const accepted = outcome.sent > 0;
  const retryLeft = attempt < MAX_ATTEMPTS && !accepted;

  await closeRow(row.id, {
    push_attempts: attempt,
    push_next_attempt_at: retryLeft ? iso(now.getTime() + retryDelayMs(attempt)) : null,
    push_sent_at: accepted ? now.toISOString() : null,
    provider_accepted_at: accepted ? now.toISOString() : null,
    fcm_message_id: outcome.messageId,
    total_sent: outcome.sent,
    failed_count: outcome.failed + outcome.invalidTokens,
    push_error: accepted
      ? null
      : (outcome.error ?? (attempt >= MAX_ATTEMPTS ? 'fcm_failed_after_retries' : 'fcm_rejected')).slice(0, 300),
  });

  if (accepted) return 'sent';
  return attempt >= MAX_ATTEMPTS ? 'failed' : 'deferred';
};

const dueRows = async (now: Date, limit: number): Promise<NotificationRow[]> => {
  const nowIso = now.toISOString();

  const { data, error } = await supabaseAdmin
    .from('notifications')
    .select(
      'id, target_user_id, title_en, title_bn, body_en, body_bn, image_url, action_link, type, channel, priority, event_code, created_at, expires_at, push_attempts'
    )
    .eq('status', 'sent')
    .in('channel', ['push', 'both'])
    .is('push_sent_at', null)
    .lt('push_attempts', MAX_ATTEMPTS)
    .not('target_user_id', 'is', null)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .or(`scheduled_at.is.null,scheduled_at.lte.${nowIso}`)
    .or(`push_next_attempt_at.is.null,push_next_attempt_at.lte.${nowIso}`)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('[dispatch] due lookup failed:', error.message);
    return [];
  }

  return (data ?? []) as NotificationRow[];
};

/** Admin campaigns: one row per audience, resolved by target_rules. */
export const dispatchScheduledCampaigns = async (now = new Date()): Promise<number> => {
  const { data: campaigns, error } = await supabaseAdmin
    .from('notifications')
    .select(
      'id, title_bn, title_en, body_bn, body_en, image_url, action_link, target_rules, expires_at, priority, type, push_attempts'
    )
    .eq('status', 'scheduled')
    .lte('scheduled_at', now.toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(10);

  if (error) {
    console.error('[dispatch] campaign lookup failed:', error.message);
    return 0;
  }

  let processed = 0;

  for (const campaign of campaigns ?? []) {
    const expiresAt = campaign.expires_at ? new Date(campaign.expires_at) : null;

    if (expiresAt && expiresAt.getTime() <= now.getTime()) {
      await supabaseAdmin
        .from('notifications')
        .update({ status: 'cancelled' })
        .eq('id', campaign.id)
        .eq('status', 'scheduled');
      continue;
    }

    const attempt = Number(campaign.push_attempts ?? 0) + 1;

    const { data: claimed } = await supabaseAdmin
      .from('notifications')
      .update({ push_attempts: attempt })
      .eq('id', campaign.id)
      .eq('status', 'scheduled')
      .eq('push_attempts', attempt - 1)
      .select('id');

    if (!claimed?.length) continue;

    const result = await sendCampaignPush({
      id: campaign.id,
      title_bn: campaign.title_bn,
      title_en: campaign.title_en,
      body_bn: campaign.body_bn,
      body_en: campaign.body_en,
      imageUrl: campaign.image_url || null,
      actionLink: campaign.action_link || '/',
      targetRules: campaign.target_rules,
      type: campaign.type,
      priority: campaign.priority === 'high' ? 'high' : 'normal',
    });

    const errorText = pushFailureReason(result);
    const succeeded = Boolean(result.messageId) && result.accepted > 0 && !errorText;
    const at = new Date().toISOString();

    await supabaseAdmin
      .from('notifications')
      .update({
        status: succeeded ? 'sent' : 'failed',
        sent_at: succeeded ? at : null,
        total_sent: result.accepted,
        failed_count: result.failed + result.invalidTokens,
        fcm_message_id: result.messageId,
        provider_accepted_at: result.accepted > 0 ? at : null,
        push_error: succeeded ? null : (errorText ?? 'no_devices_accepted').slice(0, 500),
        push_attempts: attempt,
      })
      .eq('id', campaign.id)
      .eq('status', 'scheduled');

    await recordAudit(campaign.id, null, succeeded ? 'sent' : 'failed', {
      attempt,
      provider_accepted: result.accepted,
      provider_failed: result.failed,
      provider_invalid_tokens: result.invalidTokens,
      provider_error: errorText,
      fcm_message_id: result.messageId,
    });

    processed += 1;
  }

  return processed;
};

export const dispatchNotifications = async (
  options: { now?: Date; limit?: number } = {}
): Promise<DispatchSummary> => {
  const now = options.now ?? new Date();
  const limit = options.limit ?? BATCH_SIZE;
  const summary: DispatchSummary = {
    claimed: 0,
    sent: 0,
    skipped: 0,
    deferred: 0,
    failed: 0,
    campaigns: 0,
  };

  const rows = (await dueRows(now, limit)).sort((left, right) => {
    // The daily cap has two slots; the highest-priority event claims one first.
    const byPriority = priorityRank(right.event_code) - priorityRank(left.event_code);
    if (byPriority !== 0) return byPriority;
    return String(left.created_at ?? '').localeCompare(String(right.created_at ?? ''));
  });

  // Small sequential batches: Render's free instance does not have the memory
  // for a wide fan-out, and one stuck row must not delay the rest.
  for (const row of rows) {
    try {
      const outcome = await dispatchOne(row, now);
      summary.claimed += 1;
      summary[outcome] += 1;
    } catch (error) {
      console.error('[dispatch] row failed:', error);
      summary.failed += 1;
    }
  }

  summary.campaigns = await dispatchScheduledCampaigns(now);
  return summary;
};

let running = false;

/** Overlap guard for the in-process timer; a second tick returns immediately. */
export const runDispatchOnce = async (): Promise<DispatchSummary | null> => {
  if (running) return null;
  running = true;

  try {
    return await dispatchNotifications();
  } finally {
    running = false;
  }
};
