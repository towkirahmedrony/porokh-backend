import {
  BilingualCopy,
  DEFAULT_NOTIFICATION_PREFERENCES,
  IDeviceTokenPayload,
  MANDATORY_NOTIFICATION_TYPES,
  NOTIFICATION_TYPES,
  NotificationChannel,
  NotificationPreferences,
  NotificationType,
  NotifyInput,
  NotifyResult,
} from './notifications.types';
import { Language, parseLanguage } from '../../lib/utils/language';

type AnyObject = Record<string, any>;

/**
 * Loaded lazily so importing this service (payments, exams, access) never
 * constructs a Supabase client or Firebase app as a side effect.
 */
const getAdmin = (): typeof import('../../config/supabaseAdmin').supabaseAdmin =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../../config/supabaseAdmin').supabaseAdmin;

type TemplateRow = {
  template_code: string;
  title_en: string;
  title_bn: string | null;
  body_en: string;
  body_bn: string | null;
  image_url: string | null;
  action_link: string | null;
};

const MAX_PUSH_PER_USER_PER_DAY = 3;
const INSERT_CHUNK_SIZE = 200;
const TOKEN_CHUNK_SIZE = 500;

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

const localizedCopy = (copy: BilingualCopy, language: Language): string =>
  copy[language]?.trim() || copy[language === 'en' ? 'bn' : 'en']?.trim() || '';

const chunk = <T>(rows: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
};

const normalizeUserIds = (value: string | string[]): string[] => {
  const list = Array.isArray(value) ? value : [value];
  return Array.from(new Set(list.map((id) => String(id ?? '').trim()).filter(Boolean)));
};

/** Start of the current Asia/Dhaka day, used for daily push caps. */
const startOfDhakaDay = (now = new Date()): Date => {
  const dhaka = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  const ymd = dhaka.toISOString().slice(0, 10);
  return new Date(`${ymd}T00:00:00+06:00`);
};

// --- Templates ---------------------------------------------------------------

let templateCache: { loadedAt: number; byCode: Map<string, TemplateRow> } | null = null;

const loadTemplates = async (): Promise<Map<string, TemplateRow>> => {
  if (templateCache && Date.now() - templateCache.loadedAt < 5 * 60 * 1000) {
    return templateCache.byCode;
  }

  const { data, error } = await getAdmin()
    .from('notification_templates')
    .select('template_code, title_en, title_bn, body_en, body_bn, image_url, action_link')
    .eq('is_active', true);

  if (error) {
    console.error('[notify] template lookup failed:', error.message);
    return templateCache?.byCode ?? new Map();
  }

  const byCode = new Map<string, TemplateRow>();
  (data ?? []).forEach((row: TemplateRow) => byCode.set(row.template_code, row));
  templateCache = { loadedAt: Date.now(), byCode };
  return byCode;
};

const render = (text: string, variables: Record<string, string>): string =>
  text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => variables[key] ?? '');

const stringifyVariables = (variables: NotifyInput['variables']): Record<string, string> => {
  const result: Record<string, string> = {};
  Object.entries(variables ?? {}).forEach(([key, value]) => {
    if (value === null || value === undefined) return;
    result[key] = String(value);
  });
  return result;
};

// --- Preferences -------------------------------------------------------------

const parseBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

export const normalizePreferences = (raw: unknown): NotificationPreferences => {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as AnyObject) : {};
  const rawTypes =
    source.types && typeof source.types === 'object' && !Array.isArray(source.types)
      ? (source.types as AnyObject)
      : {};

  const types = { ...DEFAULT_NOTIFICATION_PREFERENCES.types };
  NOTIFICATION_TYPES.forEach((type) => {
    types[type] = parseBoolean(rawTypes[type], types[type]);
  });
  MANDATORY_NOTIFICATION_TYPES.forEach((type) => {
    types[type] = true;
  });

  return {
    types,
    in_app: parseBoolean(source.in_app, true),
    push: parseBoolean(source.push, true),
  };
};

export const getNotificationPreferences = async (userId: string): Promise<NotificationPreferences> => {
  const { data, error } = await getAdmin()
    .from('profiles')
    .select('settings')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return normalizePreferences((data?.settings as AnyObject | null)?.notification_preferences);
};

export const updateNotificationPreferences = async (
  userId: string,
  patch: unknown
): Promise<NotificationPreferences> => {
  const current = await getNotificationPreferences(userId);
  const incoming = patch && typeof patch === 'object' && !Array.isArray(patch) ? (patch as AnyObject) : {};
  const incomingTypes =
    incoming.types && typeof incoming.types === 'object' && !Array.isArray(incoming.types)
      ? (incoming.types as AnyObject)
      : {};

  const next: NotificationPreferences = {
    types: { ...current.types },
    in_app: parseBoolean(incoming.in_app, current.in_app),
    push: parseBoolean(incoming.push, current.push),
  };

  NOTIFICATION_TYPES.forEach((type) => {
    if (typeof incomingTypes[type] === 'boolean') {
      next.types[type] = incomingTypes[type] as boolean;
    }
  });
  MANDATORY_NOTIFICATION_TYPES.forEach((type) => {
    next.types[type] = true;
  });

  const { data: profile, error: profileError } = await getAdmin()
    .from('profiles')
    .select('settings')
    .eq('id', userId)
    .maybeSingle();

  if (profileError) throw new Error(profileError.message);

  const settings =
    profile?.settings && typeof profile.settings === 'object' && !Array.isArray(profile.settings)
      ? { ...(profile.settings as AnyObject) }
      : {};

  settings.notification_preferences = next;

  const { error } = await getAdmin()
    .from('profiles')
    .update({ settings })
    .eq('id', userId);

  if (error) throw new Error(error.message);
  return next;
};

// --- Push --------------------------------------------------------------------

type PushOutcome = { sent: number; error: string | null };

const getPushCapReached = async (userId: string): Promise<boolean> => {
  const { count, error } = await getAdmin()
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('target_user_id', userId)
    .gte('push_sent_at', startOfDhakaDay().toISOString());

  if (error) {
    console.error('[notify] push cap lookup failed:', error.message);
    return false;
  }
  return (count ?? 0) >= MAX_PUSH_PER_USER_PER_DAY;
};

const cleanupInvalidTokens = async (tokens: string[], responses: AnyObject[]): Promise<void> => {
  const stale = tokens.filter((_token, index) => {
    const response = responses[index];
    if (!response || response.success) return false;
    return INVALID_TOKEN_CODES.has(String(response.error?.code ?? ''));
  });

  if (stale.length === 0) return;

  const { error } = await getAdmin().from('user_devices').delete().in('fcm_token', stale);
  if (error) console.error('[notify] stale token cleanup failed:', error.message);
};

const deliverPushForUser = async (
  userId: string,
  copy: { title: BilingualCopy; body: BilingualCopy },
  options: {
    actionLink?: string | null;
    imageUrl?: string | null;
    type: NotificationType;
    notificationId?: string | null;
    language?: Language;
  }
): Promise<PushOutcome> => {
  let language = options.language;
  if (!language) {
    const { data: profile } = await getAdmin()
      .from('profiles')
      .select('language_preference')
      .eq('id', userId)
      .maybeSingle();
    language = parseLanguage(profile?.language_preference);
  }

  const { data: devices, error } = await getAdmin()
    .from('user_devices')
    .select('fcm_token')
    .eq('user_id', userId)
    .not('fcm_token', 'is', null);

  if (error || !devices || devices.length === 0) {
    return { sent: 0, error: error?.message ?? null };
  }

  const tokens = Array.from(
    new Set(devices.map((device) => String(device.fcm_token ?? '')).filter(Boolean))
  );

  if (tokens.length === 0) return { sent: 0, error: null };

  let sent = 0;
  let lastError: string | null = null;

  for (const tokenChunk of chunk(tokens, TOKEN_CHUNK_SIZE)) {
    try {
      const { messaging } = await import('../../config/firebaseAdmin');
      const response = await messaging.sendEachForMulticast({
        data: {
          title: localizedCopy(copy.title, language) || 'Porokh',
          body: localizedCopy(copy.body, language),
          image_url: options.imageUrl || '',
          action_link: options.actionLink || '/',
          type: options.type,
          notification_id: options.notificationId || '',
        },
        tokens: tokenChunk,
      });

      sent += response.successCount;
      await cleanupInvalidTokens(tokenChunk, response.responses as AnyObject[]);
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'push failed';
      console.error('[notify] FCM push failed:', lastError);
    }
  }

  return { sent, error: lastError };
};

// --- Core entry point --------------------------------------------------------

const buildCopy = (
  input: NotifyInput,
  template: TemplateRow | undefined,
  userId: string
): {
  title: BilingualCopy;
  body: BilingualCopy;
  actionLink: string | null;
  imageUrl: string | null;
} | null => {
  const rawVariables =
    typeof input.variables === 'function' ? input.variables(userId) : input.variables;
  const variables = stringifyVariables(rawVariables);

  const title: BilingualCopy | null = template
    ? {
        bn: render(template.title_bn || template.title_en, variables),
        en: render(template.title_en, variables),
      }
    : input.title ?? null;

  const body: BilingualCopy | null = template
    ? {
        bn: render(template.body_bn || template.body_en, variables),
        en: render(template.body_en, variables),
      }
    : input.body ?? null;

  if (!title || !body) return null;

  return {
    title,
    body,
    actionLink: input.actionLink ?? template?.action_link ?? null,
    imageUrl: input.imageUrl ?? template?.image_url ?? null,
  };
};

/**
 * Single notification entry point used by every feature.
 *
 * - renders templates (bn/en with `{{variables}}`)
 * - honours per-user preferences and the daily push cap
 * - is idempotent through `dedupe_key`
 * - never throws into the caller's main flow
 */
export const notify = async (input: NotifyInput): Promise<NotifyResult> => {
  const result: NotifyResult = { inserted: 0, pushed: 0, skipped: 0 };

  try {
    const userIds = normalizeUserIds(input.userIds);
    if (userIds.length === 0) return result;

    const channels = new Set<NotificationChannel>(input.channels ?? ['in_app']);
    if (channels.size === 0) return result;

    const { data: profiles, error: profileError } = await getAdmin()
      .from('profiles')
      .select('id, language_preference, settings')
      .in('id', userIds);

    if (profileError) {
      console.error('[notify] profile lookup failed:', profileError.message);
      return result;
    }

    const profileById = new Map<string, AnyObject>(
      (profiles ?? []).map((profile: AnyObject) => [String(profile.id), profile])
    );

    const templates = input.templateCode ? await loadTemplates() : new Map<string, TemplateRow>();
    const template = input.templateCode ? templates.get(input.templateCode) : undefined;
    const mandatory = MANDATORY_NOTIFICATION_TYPES.includes(input.type);
    const rows: AnyObject[] = [];

    for (const userId of userIds) {
      const profile = profileById.get(userId);
      if (!profile) {
        result.skipped += 1;
        continue;
      }

      const preferences = normalizePreferences(
        (profile.settings as AnyObject | null)?.notification_preferences
      );

      if (!mandatory && preferences.types[input.type] === false) {
        result.skipped += 1;
        continue;
      }

      const wantsInApp = mandatory || (channels.has('in_app') && preferences.in_app);
      const wantsPush = channels.has('push') && preferences.push;

      if (!wantsInApp && !wantsPush) {
        result.skipped += 1;
        continue;
      }

      const copy = buildCopy(input, template, userId);
      if (!copy) {
        console.error('[notify] missing template and inline copy for', input.eventCode);
        result.skipped += 1;
        continue;
      }

      const dedupeKey =
        typeof input.dedupeKey === 'function'
          ? input.dedupeKey(userId)
          : input.dedupeKey ?? null;

      rows.push({
        target_user_id: userId,
        title_bn: copy.title.bn,
        title_en: copy.title.en,
        body_bn: copy.body.bn,
        body_en: copy.body.en,
        image_url: copy.imageUrl,
        action_link: copy.actionLink,
        type: input.type,
        channel: wantsPush && wantsInApp ? 'both' : wantsPush ? 'push' : 'in_app',
        priority: input.priority ?? 'normal',
        meta_data: {
          ...(input.metaData ?? {}),
          event: input.eventCode,
          push_requested: wantsPush,
        },
        status: 'pending',
        event_code: input.eventCode,
        dedupe_key: dedupeKey,
        expires_at: input.expiresAt ?? null,
        created_by: input.createdBy ?? null,
      });
    }

    if (rows.length === 0) return result;

    const insertedRows: AnyObject[] = [];

    for (const rowChunk of chunk(rows, INSERT_CHUNK_SIZE)) {
      const { data, error } = await getAdmin()
        .from('notifications')
        .upsert(rowChunk, { onConflict: 'dedupe_key', ignoreDuplicates: true })
        .select('id, target_user_id, title_bn, title_en, body_bn, body_en, action_link, image_url, type, meta_data');

      if (error) {
        console.error('[notify] insert failed:', error.message);
        continue;
      }

      insertedRows.push(...(data ?? []));
    }

    if (insertedRows.length === 0) return result;

    const insertedIds = insertedRows.map((row) => row.id);
    const { error: statusError } = await getAdmin()
      .from('notifications')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .in('id', insertedIds);

    if (statusError) console.error('[notify] status update failed:', statusError.message);

    result.inserted = insertedRows.length;

    const pushRows = insertedRows.filter((row) => Boolean(row.meta_data?.push_requested));

    if (pushRows.length === 0) return result;

    let pushAttempts = 0;
    for (const row of pushRows) {
      const userId = String(row.target_user_id);

      if (input.pushLimit !== undefined && pushAttempts >= input.pushLimit) {
        await getAdmin()
          .from('notifications')
          .update({ push_error: 'batch_capped' })
          .eq('id', row.id);
        continue;
      }
      pushAttempts += 1;

      if (await getPushCapReached(userId)) {
        await getAdmin()
          .from('notifications')
          .update({ push_error: 'rate_limited' })
          .eq('id', row.id);
        continue;
      }

      const outcome = await deliverPushForUser(
        userId,
        {
          title: { bn: row.title_bn ?? row.title_en ?? '', en: row.title_en ?? row.title_bn ?? '' },
          body: { bn: row.body_bn ?? row.body_en ?? '', en: row.body_en ?? row.body_bn ?? '' },
        },
        {
          actionLink: row.action_link,
          imageUrl: row.image_url,
          type: input.type,
          notificationId: row.id,
        }
      );

      if (outcome.sent > 0) {
        result.pushed += 1;
        await getAdmin()
          .from('notifications')
          .update({ push_sent_at: new Date().toISOString(), push_error: null })
          .eq('id', row.id);
      } else if (outcome.error) {
        await getAdmin()
          .from('notifications')
          .update({ push_error: outcome.error.slice(0, 500) })
          .eq('id', row.id);
      }
    }

    return result;
  } catch (error) {
    console.error(
      '[notify] unexpected failure:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return result;
  }
};

/** Fire-and-forget wrapper for request handlers. */
export const notifySafe = (input: NotifyInput): void => {
  void notify(input);
};

// --- Read tracking -----------------------------------------------------------

const isNotificationVisibleToUser = async (userId: string, notificationId: string): Promise<boolean> => {
  const { data, error } = await getAdmin()
    .from('notifications')
    .select('id, target_user_id, status, expires_at')
    .eq('id', notificationId)
    .maybeSingle();

  if (error || !data) return false;
  if (data.status !== 'sent') return false;
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return false;

  return data.target_user_id === userId || data.target_user_id === null;
};

export const markNotificationAsRead = async (
  userId: string,
  notificationId: string,
  isClicked = false
): Promise<void> => {
  if (!notificationId) throw new Error('Notification id is required');

  const visible = await isNotificationVisibleToUser(userId, notificationId);
  if (!visible) throw new Error('Notification not found');

  const now = new Date().toISOString();
  const { error } = await getAdmin().from('notification_reads').upsert(
    {
      notification_id: notificationId,
      user_id: userId,
      is_read: true,
      read_at: now,
      is_clicked: isClicked,
      clicked_at: isClicked ? now : null,
      device_platform: 'web',
    },
    { onConflict: 'user_id,notification_id' }
  );

  if (error) throw new Error(error.message);

  if (isClicked) {
    const { data: row } = await getAdmin()
      .from('notifications')
      .select('total_clicks')
      .eq('id', notificationId)
      .maybeSingle();

    await getAdmin()
      .from('notifications')
      .update({ total_clicks: Number(row?.total_clicks ?? 0) + 1 })
      .eq('id', notificationId);
  }
};

export const markAllNotificationsAsRead = async (userId: string): Promise<number> => {
  const now = new Date().toISOString();

  const { data: notifications, error } = await getAdmin()
    .from('notifications')
    .select('id, expires_at')
    .or(`target_user_id.eq.${userId},target_user_id.is.null`)
    .eq('status', 'sent');

  if (error) throw new Error(error.message);

  const visible = (notifications ?? []).filter(
    (row) => !row.expires_at || new Date(row.expires_at).getTime() >= Date.now()
  );

  const { data: reads } = await getAdmin()
    .from('notification_reads')
    .select('notification_id')
    .eq('user_id', userId)
    .eq('is_read', true);

  const alreadyRead = new Set((reads ?? []).map((row) => String(row.notification_id)));
  const pending = visible.filter((row) => !alreadyRead.has(String(row.id)));

  if (pending.length === 0) return 0;

  for (const rowChunk of chunk(pending, INSERT_CHUNK_SIZE)) {
    const { error: upsertError } = await getAdmin().from('notification_reads').upsert(
      rowChunk.map((row) => ({
        notification_id: row.id,
        user_id: userId,
        is_read: true,
        read_at: now,
      })),
      { onConflict: 'user_id,notification_id' }
    );

    if (upsertError) throw new Error(upsertError.message);
  }

  return pending.length;
};

export const getUnreadNotificationCount = async (userId: string): Promise<number> => {
  const { data, error } = await getAdmin().rpc('get_unread_notification_count_for_user', {
    p_user_id: userId,
  });

  if (!error && typeof data === 'number') return data;

  const { data: notifications } = await getAdmin()
    .from('notifications')
    .select('id, expires_at, channel')
    .or(`target_user_id.eq.${userId},target_user_id.is.null`)
    .eq('status', 'sent');

  const ids = (notifications ?? [])
    .filter(
      (row) =>
        row.channel !== 'push' &&
        (!row.expires_at || new Date(row.expires_at).getTime() >= Date.now())
    )
    .map((row) => String(row.id));
  if (ids.length === 0) return 0;

  const { data: reads } = await getAdmin()
    .from('notification_reads')
    .select('notification_id')
    .eq('user_id', userId)
    .eq('is_read', true)
    .in('notification_id', ids);

  return Math.max(0, ids.length - new Set((reads ?? []).map((row) => String(row.notification_id))).size);
};

// --- Device registration -----------------------------------------------------

export const saveUserDeviceToken = async (userId: string, payload: IDeviceTokenPayload) => {
  if (!userId) throw new Error('User ID is required');
  if (!payload.device_id) throw new Error('Device ID is required');

  const { data: existing } = await getAdmin()
    .from('user_devices')
    .select('id')
    .eq('user_id', userId)
    .eq('device_id', payload.device_id)
    .maybeSingle();

  const { data, error } = await getAdmin()
    .from('user_devices')
    .upsert(
      {
        user_id: userId,
        device_id: payload.device_id,
        device_name: payload.device_name || 'Web Client',
        os_or_browser: payload.os_or_browser || 'Unknown',
        fcm_token: payload.fcm_token,
        ip_address: payload.ip_address || null,
        last_active_at: new Date().toISOString(),
        is_trusted: true,
      },
      { onConflict: 'user_id,device_id' }
    )
    .select();

  if (error) {
    console.error('Device token save failed:', error);
    throw new Error(error.message);
  }

  if (!existing && payload.fcm_token) {
    notifySafe({
      userIds: userId,
      type: 'security',
      eventCode: 'new_device_login',
      templateCode: 'new_device_login',
      variables: {
        device: payload.device_name || payload.os_or_browser || 'Unknown device',
      },
      channels: ['in_app', 'push'],
      priority: 'high',
      actionLink: '/change-password',
      dedupeKey: `new_device:${userId}:${payload.device_id}`,
      metaData: { device_id: payload.device_id },
    });
  }

  return data;
};

// --- Legacy helpers kept for existing call sites -----------------------------

export const sendPushNotification = async (
  userId: string,
  title: BilingualCopy,
  body: BilingualCopy,
  imageUrl?: string,
  actionLink?: string
) => {
  try {
    if (await getPushCapReached(userId)) return;
    await deliverPushForUser(userId, { title, body }, { imageUrl, actionLink, type: 'social' });
  } catch (error) {
    console.error('FCM Push Notification Error:', error);
  }
};

/**
 * Bilingual "payment successful" notification.
 *
 * Only sent after the payment row has actually transitioned to `paid`; it
 * deliberately contains no transaction id, sender number or amount. Failures
 * are swallowed: a notification must never roll back a completed payment.
 */
export const sendPaymentSuccessNotification = async (
  userId: string,
  plan: { name?: string | null; nameEn?: string | null; days?: number | null } = {}
) => {
  const planBn = (plan.name || '').trim() || 'প্রিমিয়াম';
  const planEn = (plan.nameEn || plan.name || '').trim() || 'Premium';

  await notify({
    userIds: userId,
    type: 'billing',
    eventCode: 'premium_purchased',
    title: { bn: 'প্রিমিয়াম চালু হয়েছে', en: 'Premium activated' },
    body: {
      bn: planBn
        ? `আপনার "${planBn}" প্ল্যান চালু হয়েছে। এখন প্রিমিয়াম সুবিধা ব্যবহার করতে পারবেন।`
        : 'আপনার প্রিমিয়াম প্ল্যান চালু হয়েছে। এখন প্রিমিয়াম সুবিধা ব্যবহার করতে পারবেন।',
      en: planEn
        ? `Your "${planEn}" plan is now active. Premium access is available.`
        : 'Your premium plan is now active. Premium access is available.',
    },
    channels: ['in_app'],
    actionLink: '/premium',
    metaData: { plan_days: plan.days ?? null },
  });
};

export const sendRewardNotification = async (
  userId: string,
  title: BilingualCopy,
  body: BilingualCopy,
  coins = 0,
  xp = 0
) => {
  await notify({
    userIds: userId,
    type: 'reward',
    eventCode: 'reward_earned',
    title,
    body,
    channels: ['in_app'],
    actionLink: '/profile',
    metaData: { reward: { coins, xp } },
  });
};

// --- Progression -------------------------------------------------------------

type LevelRow = {
  id: number;
  name_bn: string;
  name_en: string;
  min_xp: number;
  max_xp: number | null;
};

let levelCache: { loadedAt: number; levels: LevelRow[] } | null = null;

const loadLevels = async (): Promise<LevelRow[]> => {
  if (levelCache && Date.now() - levelCache.loadedAt < 5 * 60 * 1000) return levelCache.levels;

  const { data, error } = await getAdmin()
    .from('levels_master')
    .select('id, name_bn, name_en, min_xp, max_xp')
    .order('min_xp', { ascending: true });

  if (error) {
    console.error('[notify] level lookup failed:', error.message);
    return levelCache?.levels ?? [];
  }

  levelCache = { loadedAt: Date.now(), levels: (data ?? []) as LevelRow[] };
  return levelCache.levels;
};

export const levelForXp = (levels: LevelRow[], xp: number): LevelRow | null => {
  let match: LevelRow | null = null;
  for (const level of levels) {
    if (xp >= Number(level.min_xp)) match = level;
  }
  return match;
};

let top10Cache: { loadedAt: number; threshold: number | null } | null = null;

const getTop10Threshold = async (): Promise<number | null> => {
  if (top10Cache && Date.now() - top10Cache.loadedAt < 5 * 60 * 1000) return top10Cache.threshold;

  const { data, error } = await getAdmin()
    .from('profiles')
    .select('total_xp')
    .order('total_xp', { ascending: false })
    .range(9, 9);

  if (error) return top10Cache?.threshold ?? null;
  const threshold = data && data.length > 0 ? Number(data[0].total_xp ?? 0) : null;
  top10Cache = { loadedAt: Date.now(), threshold };
  return threshold;
};

/**
 * Sends the in-app reward and the level/league/top-10 follow-ups for an XP
 * award. Call after the authoritative XP write has succeeded.
 */
export const notifyXpAndProgression = async (
  userId: string,
  options: {
    xp: number;
    reason: string;
    dedupeKey?: string | null;
    title?: BilingualCopy;
    body?: BilingualCopy;
    actionLink?: string;
  }
): Promise<void> => {
  try {
    const { data: profile } = await getAdmin()
      .from('profiles')
      .select('total_xp')
      .eq('id', userId)
      .maybeSingle();

    const afterXp = Number(profile?.total_xp ?? 0);
    const safeXp = Math.max(0, Math.round(Number(options.xp) || 0));
    const beforeXp = Math.max(0, afterXp - safeXp);

    if (safeXp > 0) {
      await notify({
        userIds: userId,
        type: 'reward',
        eventCode: options.reason,
        title: options.title,
        body: options.body,
        templateCode: options.title && options.body ? undefined : 'reward_earned',
        variables: { amount: safeXp },
        channels: ['in_app'],
        actionLink: options.actionLink ?? '/profile',
        dedupeKey: options.dedupeKey ?? null,
        metaData: { xp: safeXp, reason: options.reason },
      });
    }

    const levels = await loadLevels();
    const beforeLevel = levelForXp(levels, beforeXp);
    const afterLevel = levelForXp(levels, afterXp);

    if (beforeLevel && afterLevel && afterLevel.id > beforeLevel.id) {
      await notify({
        userIds: userId,
        type: 'reward',
        eventCode: 'level_up',
        templateCode: 'level_up',
        variables: { level: afterLevel.name_bn },
        title: {
          bn: `লেভেল আপ! আপনি এখন ${afterLevel.name_bn}`,
          en: `Level up! You are now ${afterLevel.name_en}`,
        },
        channels: ['in_app'],
        actionLink: '/dashboard/leaderboard',
        dedupeKey: `level_up:${userId}:${afterLevel.id}`,
        metaData: { level: afterLevel.id },
      });
    }

    const threshold = await getTop10Threshold();
    if (threshold !== null && beforeXp < threshold && afterXp >= threshold) {
      await notify({
        userIds: userId,
        type: 'reward',
        eventCode: 'leaderboard_top10',
        templateCode: 'leaderboard_top10',
        channels: ['in_app'],
        actionLink: '/dashboard/leaderboard',
        dedupeKey: `top10:${userId}:${new Date().toISOString().slice(0, 10)}`,
      });
    }
  } catch (error) {
    console.error(
      '[notify] progression notification failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
  }
};

// --- Event helpers -----------------------------------------------------------

export const notifyQuotaExhausted = async (userId: string, feature: string): Promise<void> => {
  const today = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const featureLabel = feature === 'exam_start' ? 'exam' : feature;
  await notify({
    userIds: userId,
    type: 'billing',
    eventCode: 'quota_exhausted',
    templateCode: 'quota_exhausted',
    variables: { feature: featureLabel },
    channels: ['in_app'],
    actionLink: '/premium',
    dedupeKey: `quota:${feature}:${userId}:${today}`,
  });
};

export const notifyPremiumGranted = async (
  userId: string,
  grantType: 'premium' | 'unlimited_quota'
): Promise<void> => {
  await notify({
    userIds: userId,
    type: 'billing',
    eventCode: 'premium_granted',
    templateCode: 'premium_granted',
    variables: { grant: grantType === 'premium' ? 'Premium' : 'Unlimited exam' },
    channels: ['in_app'],
    actionLink: '/premium',
    dedupeKey: `premium_grant:${userId}:${Date.now()}`,
  });
};

export const notifyPremiumExpiring = async (
  userId: string,
  daysLeft: number,
  expiryDate: string
): Promise<void> => {
  await notify({
    userIds: userId,
    type: 'billing',
    eventCode: 'premium_expiring',
    templateCode: 'premium_expiring',
    variables: { days: Math.max(1, Math.round(daysLeft)) },
    channels: ['in_app', 'push'],
    priority: 'high',
    actionLink: '/premium',
    dedupeKey: `premium_expiry:${userId}:${expiryDate.slice(0, 10)}`,
  });
};

export const notifyReferralBonus = async (
  userId: string,
  amount: number,
  referredUserId: string
): Promise<void> => {
  await notify({
    userIds: userId,
    type: 'reward',
    eventCode: 'referral_bonus',
    templateCode: 'referral_bonus',
    variables: { amount },
    channels: ['in_app'],
    actionLink: '/referral',
    dedupeKey: `referral:${referredUserId}`,
  });
};

export const notifyLevelAndLeague = async (
  userId: string,
  beforeXp: number,
  afterXp: number
): Promise<void> => {
  const levels = await loadLevels();
  const beforeLevel = levelForXp(levels, beforeXp);
  const afterLevel = levelForXp(levels, afterXp);

  if (!beforeLevel || !afterLevel || beforeLevel.id === afterLevel.id) return;

  const promoted = afterLevel.id > beforeLevel.id;

  await notify({
    userIds: userId,
    type: 'reward',
    eventCode: promoted ? 'league_promotion' : 'league_demotion',
    templateCode: promoted ? 'league_promotion' : 'league_demotion',
    variables: { league: afterLevel.name_bn },
    title: {
      bn: promoted ? `লিগে উন্নতি: ${afterLevel.name_bn}` : `লিগ পরিবর্তন: ${afterLevel.name_bn}`,
      en: promoted ? `League promotion: ${afterLevel.name_en}` : `League changed: ${afterLevel.name_en}`,
    },
    channels: ['in_app'],
    actionLink: '/dashboard/leaderboard',
    dedupeKey: `league:${userId}:${afterLevel.id}`,
  });
};
