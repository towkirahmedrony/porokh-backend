import { supabaseAdmin } from '../../config/supabaseAdmin';
import { fetchOneSignalMessageReport } from '../../config/onesignal';
import {
  loadDevicePlatforms,
  normalizePreferences,
  sendCampaignPush,
} from './notifications.service';
import {
  AudienceRules,
  NotificationAdminError,
  NotificationStats,
  isUuid,
  matchesAudienceRules,
  normalizeNotificationType,
  normalizeStats,
  parseAudienceRules,
  parseListFilters,
  validateCampaignInput,
} from './notifications.admin.rules';
import { NotificationType } from './notifications.types';

type AnyObject = Record<string, any>;

/** One retry may be attempted this many times before an admin must resend. */
const MAX_PUSH_ATTEMPTS = 3;

const AUDIENCE_PAGE = 500;
const AUDIENCE_MAX_PAGES = 100;

// --- Shared helpers ----------------------------------------------------------

const loadNotification = async (id: string): Promise<AnyObject> => {
  if (!isUuid(id)) throw new NotificationAdminError('Invalid notification id');

  const { data, error } = await supabaseAdmin
    .from('notifications')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw new NotificationAdminError(error.message, 500);
  if (!data) throw new NotificationAdminError('Notification not found', 404);

  return data as AnyObject;
};

/**
 * Audit writes never fail a request: the notification itself already happened,
 * and losing the trail entry is preferable to reporting a failed send.
 */
export const recordAudit = async (
  notificationId: string | null,
  actorId: string | null,
  action:
    | 'created'
    | 'updated'
    | 'scheduled'
    | 'send_attempted'
    | 'sent'
    | 'failed'
    | 'cancelled'
    | 'retried'
    | 'delivery_refreshed'
    | 'deleted',
  details: Record<string, unknown> = {}
): Promise<void> => {
  const { error } = await supabaseAdmin
    .from('notification_admin_audit')
    .insert({ notification_id: notificationId, actor_id: actorId, action, details });

  if (error) {
    console.error('[notify:admin] audit write failed:', error.message);
  }
};

export const pushFailureReason = (result: {
  accepted: number;
  messageId: string | null;
  error: string | null;
}): string | null => {
  if (result.error) return result.error;
  if (result.accepted === 0) return 'OneSignal accepted 0 devices';
  if (!result.messageId) return 'OneSignal response had no message id';
  return null;
};

/**
 * Pushes one stored notification and records exactly what the provider
 * reported. A notification is only published as `sent` after OneSignal accepts
 * it and returns a message id; any provider error or zero accepted devices
 * leaves the row `failed` with the error stored for the retry button.
 */
const deliverStoredNotification = async (
  row: AnyObject,
  actorId: string,
  attempt: number
): Promise<AnyObject> => {
  await recordAudit(row.id, actorId, 'send_attempted', {
    attempt,
    target_rules: row.target_rules ?? {},
    target_user_id: row.target_user_id ?? null,
  });

  const result = await sendCampaignPush({
    id: String(row.id),
    title_bn: row.title_bn,
    title_en: row.title_en,
    body_bn: row.body_bn,
    body_en: row.body_en,
    imageUrl: row.image_url,
    actionLink: row.action_link,
    targetRules: row.target_rules,
    type: row.type,
    priority: row.priority === 'high' || row.priority === 'low' ? row.priority : 'normal',
    attempt,
  });

  const errorText = pushFailureReason(result);
  const succeeded = Boolean(result.messageId) && result.accepted > 0 && !errorText;
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('notifications')
    .update({
      status: succeeded ? 'sent' : 'failed',
      sent_at: succeeded ? row.sent_at ?? now : null,
      total_sent: result.accepted,
      onesignal_message_id: result.messageId,
      provider_accepted_at: result.accepted > 0 ? now : null,
      push_error: succeeded ? null : errorText!.slice(0, 500),
      push_attempts: attempt,
    })
    .eq('id', row.id)
    .select()
    .single();

  if (error) throw new NotificationAdminError(error.message, 500);

  await recordAudit(row.id, actorId, succeeded ? (attempt > 1 ? 'retried' : 'sent') : 'failed', {
    attempt,
    provider_accepted: result.accepted,
    provider_error: errorText,
    onesignal_message_id: result.messageId,
  });

  return data as AnyObject;
};

// --- Create / list ------------------------------------------------------------

export const createCampaign = async (body: unknown, actorId: string): Promise<AnyObject> => {
  const { record, mode } = validateCampaignInput(body);
  // A send starts as a draft so the row is never published before the provider
  // response; deliverStoredNotification moves it to sent or failed.
  const status = mode === 'draft' ? 'draft' : mode === 'schedule' ? 'scheduled' : 'draft';

  const { data, error } = await supabaseAdmin
    .from('notifications')
    .insert({
      ...record,
      status,
      created_by: actorId,
      sent_at: null,
      total_sent: 0,
      total_clicks: 0,
      push_attempts: 0,
    })
    .select()
    .single();

  if (error) throw new NotificationAdminError(error.message, 500);

  await recordAudit(data.id, actorId, mode === 'schedule' ? 'scheduled' : 'created', {
    mode,
    type: record.type,
    priority: record.priority,
    title: record.title_en,
  });

  if (mode !== 'send') return data as AnyObject;

  return deliverStoredNotification(data as AnyObject, actorId, 1);
};

export const listCampaigns = async (query: unknown) => {
  const filters = parseListFilters(query);
  const offset = (filters.page - 1) * filters.limit;

  let request = supabaseAdmin
    .from('notifications')
    .select(
      'id, title_en, title_bn, body_en, body_bn, image_url, action_link, type, channel, priority, status, target_user_id, target_rules, meta_data, total_sent, total_clicks, delivered_count, failed_count, push_error, push_attempts, onesignal_message_id, delivery_checked_at, scheduled_at, sent_at, expires_at, created_at, created_by, event_code',
      { count: 'exact' }
    )
    // Only admin-authored campaigns belong here. Per-user notifications (for
    // example urgent notices created through notify()) also carry created_by
    // but have target_user_id and no campaign audience rules.
    .not('created_by', 'is', null)
    .is('target_user_id', null)
    .gte('created_at', filters.from)
    .lt('created_at', filters.to)
    .order('created_at', { ascending: false });

  if (filters.status) request = request.eq('status', filters.status);
  if (filters.type) request = request.eq('type', filters.type);

  if (filters.search) {
    const term = `%${filters.search}%`;
    request = request.or(
      `title_en.ilike.${term},title_bn.ilike.${term},body_en.ilike.${term},body_bn.ilike.${term}`
    );
  }

  const { data, error, count } = await request.range(offset, offset + filters.limit - 1);

  if (error) throw new NotificationAdminError(error.message, 500);

  return {
    items: data ?? [],
    page: filters.page,
    limit: filters.limit,
    total: count ?? 0,
  };
};

export const getCampaignDetail = async (id: string): Promise<AnyObject> => {
  const notification = await loadNotification(id);

  const { data: audit, error: auditError } = await supabaseAdmin
    .from('notification_admin_audit')
    .select('id, action, actor_id, details, created_at')
    .eq('notification_id', id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (auditError) {
    console.error('[notify:admin] audit lookup failed:', auditError.message);
  }

  const actorIds = Array.from(
    new Set((audit ?? []).map((row) => row.actor_id).filter(Boolean))
  ) as string[];

  const actorNames = new Map<string, string>();

  if (actorIds.length > 0) {
    const { data: profiles } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name')
      .in('id', actorIds);

    (profiles ?? []).forEach((profile) => {
      actorNames.set(String(profile.id), String(profile.full_name ?? ''));
    });
  }

  return {
    ...notification,
    audit_trail: (audit ?? []).map((row) => ({
      ...row,
      actor_name: row.actor_id ? actorNames.get(String(row.actor_id)) ?? null : null,
    })),
  };
};

// --- Update / lifecycle -------------------------------------------------------

export const updateCampaign = async (
  id: string,
  body: unknown,
  actorId: string
): Promise<AnyObject> => {
  const current = await loadNotification(id);

  if (!['draft', 'scheduled'].includes(String(current.status))) {
    throw new NotificationAdminError(
      'Only drafts and scheduled notifications can be edited',
      409
    );
  }

  const patch = body && typeof body === 'object' ? (body as AnyObject) : {};
  const { record, mode } = validateCampaignInput({
    title_en: current.title_en,
    title_bn: current.title_bn,
    body_en: current.body_en,
    body_bn: current.body_bn,
    image_url: current.image_url,
    action_link: current.action_link,
    type: current.type,
    priority: current.priority,
    target_rules: current.target_rules,
    meta_data: current.meta_data,
    scheduled_at: current.scheduled_at,
    expires_at: current.expires_at,
    ...patch,
  });

  if (current.status === 'scheduled' && mode !== 'schedule') {
    throw new NotificationAdminError(
      'A scheduled notification needs a future scheduled_at',
      400
    );
  }

  // Sending starts from draft; deliverStoredNotification publishes it only
  // after a successful provider response.
  const status = mode === 'schedule' ? 'scheduled' : 'draft';

  const { data, error } = await supabaseAdmin
    .from('notifications')
    .update({
      ...record,
      status,
      sent_at: null,
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw new NotificationAdminError(error.message, 500);

  await recordAudit(id, actorId, status === 'scheduled' ? 'scheduled' : 'updated', {
    mode,
    title: record.title_en,
  });

  if (mode !== 'send') return data as AnyObject;

  return deliverStoredNotification(data as AnyObject, actorId, Number(current.push_attempts ?? 0) + 1);
};

export const cancelCampaign = async (id: string, actorId: string): Promise<AnyObject> => {
  const current = await loadNotification(id);

  if (!['draft', 'scheduled'].includes(String(current.status))) {
    throw new NotificationAdminError(
      'Only drafts and scheduled notifications can be cancelled',
      409
    );
  }

  const { data, error } = await supabaseAdmin
    .from('notifications')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .select()
    .single();

  if (error) throw new NotificationAdminError(error.message, 500);

  await recordAudit(id, actorId, 'cancelled', { previous_status: current.status });

  return data as AnyObject;
};

export const sendCampaign = async (id: string, actorId: string): Promise<AnyObject> => {
  const current = await loadNotification(id);

  if (!['draft', 'scheduled'].includes(String(current.status))) {
    throw new NotificationAdminError('This notification has already been sent', 409);
  }

  return deliverStoredNotification(
    current,
    actorId,
    Number(current.push_attempts ?? 0) + 1
  );
};

/**
 * A retry re-sends the same stored notification under the next attempt number,
 * so the derived idempotency key is new and OneSignal does not drop it as a
 * duplicate of the first attempt.
 */
export const retryCampaign = async (id: string, actorId: string): Promise<AnyObject> => {
  const current = await loadNotification(id);
  const attempts = Number(current.push_attempts ?? 0);

  if (!['sent', 'failed'].includes(String(current.status))) {
    throw new NotificationAdminError(
      'Only a sent or failed notification can be retried',
      409
    );
  }
  if (attempts >= MAX_PUSH_ATTEMPTS) {
    throw new NotificationAdminError(
      `Retry limit reached (${MAX_PUSH_ATTEMPTS} attempts)`,
      409
    );
  }
  if (!current.push_error && !Number(current.failed_count ?? 0)) {
    throw new NotificationAdminError(
      'There is no failed delivery to retry for this notification',
      409
    );
  }

  return deliverStoredNotification(current, actorId, attempts + 1);
};

/**
 * Refreshes the provider's delivery report. A notification without a stored
 * OneSignal message id has no report yet, which is reported as a conflict
 * rather than a fabricated 0.
 */
export const refreshDeliveryStats = async (
  id: string,
  actorId: string
): Promise<AnyObject> => {
  const current = await loadNotification(id);
  const messageId = String(current.onesignal_message_id ?? '').trim();

  if (!messageId) {
    throw new NotificationAdminError(
      'No provider message id yet; send the notification first',
      409
    );
  }

  const report = await fetchOneSignalMessageReport(messageId);
  const now = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('notifications')
    .update({
      delivered_count: report.delivered,
      failed_count: report.failed,
      delivery_checked_at: now,
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw new NotificationAdminError(error.message, 500);

  await recordAudit(id, actorId, 'delivery_refreshed', {
    delivered: report.delivered,
    failed: report.failed,
    onesignal_message_id: messageId,
  });

  return data as AnyObject;
};

/**
 * Only an unusable row may be deleted: a published notification is delivery
 * history, and deleting it would remove the audit trail it points at.
 */
export const deleteCampaign = async (id: string, actorId: string): Promise<{ id: string }> => {
  const current = await loadNotification(id);

  if (!['draft', 'cancelled', 'failed'].includes(String(current.status))) {
    throw new NotificationAdminError(
      'Published notifications cannot be deleted; cancel or retry them instead',
      409
    );
  }

  const { error } = await supabaseAdmin.from('notifications').delete().eq('id', id);
  if (error) throw new NotificationAdminError(error.message, 500);

  await recordAudit(null, actorId, 'deleted', {
    notification_id: id,
    title: current.title_en,
    status: current.status,
  });

  return { id };
};

// --- Audience -----------------------------------------------------------------

export interface AudiencePreview {
  eligibleAccounts: number;
  pushReachable: number;
  inAppVisible: number;
  excludedByPreference: number;
  devices: { total: number; android: number; web: number };
}

/**
 * Counts the audience for the rules the admin is editing, using the same
 * matcher as the send path. Only aggregate counts leave the service: no user
 * id, name or contact detail is returned.
 */
export const previewAudience = async (body: unknown): Promise<AudiencePreview> => {
  const source = body && typeof body === 'object' ? (body as AnyObject) : {};
  const rules = parseAudienceRules(source.target_rules ?? {});
  const type = normalizeNotificationType(source.type) as NotificationType;

  const devicePlatforms = await loadDevicePlatforms();
  const devices = { total: 0, android: 0, web: 0 };
  devicePlatforms.forEach((platforms) => {
    devices.total += platforms.size;
    if (platforms.has('android')) devices.android += 1;
    if (platforms.has('web')) devices.web += 1;
  });

  const candidates = Array.from(devicePlatforms.keys());
  let eligibleAccounts = 0;
  let pushReachable = 0;
  let inAppVisible = 0;
  let excludedByPreference = 0;

  for (let page = 0; page * AUDIENCE_PAGE < candidates.length; page += 1) {
    if (page >= AUDIENCE_MAX_PAGES) break;
    const userChunk = candidates.slice(page * AUDIENCE_PAGE, (page + 1) * AUDIENCE_PAGE);

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select(
        'id, settings, class_level, education_board, subscription_status, last_active_at, account_status'
      )
      .in('id', userChunk);

    if (error) {
      throw new NotificationAdminError(error.message, 503);
    }

    (data ?? []).forEach((profile: AnyObject) => {
      if (String(profile.account_status ?? 'active') !== 'active') return;

      const platforms = Array.from(devicePlatforms.get(String(profile.id)) ?? []);
      if (!matchesAudienceRules(rules, profile, platforms)) return;

      eligibleAccounts += 1;

      const preferences = normalizePreferences(
        (profile.settings as AnyObject | null)?.notification_preferences
      );
      const typeEnabled = preferences.types[type] !== false;

      if (preferences.push && typeEnabled) pushReachable += 1;
      if (preferences.in_app && typeEnabled) inAppVisible += 1;
      if (!preferences.push && !preferences.in_app) excludedByPreference += 1;
    });
  }

  return { eligibleAccounts, pushReachable, inAppVisible, excludedByPreference, devices };
};

// --- Analytics ----------------------------------------------------------------

export const getStats = async (
  query: unknown
): Promise<{ stats: NotificationStats; from: string; to: string }> => {
  const filters = parseListFilters(query);

  const { data, error } = await supabaseAdmin.rpc('notification_admin_stats', {
    p_from: filters.from,
    p_to: filters.to,
  });

  if (error) {
    throw new NotificationAdminError(
      `Notification analytics unavailable: ${error.message}`,
      503
    );
  }

  return { stats: normalizeStats(data), from: filters.from, to: filters.to };
};
