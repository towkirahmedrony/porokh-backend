import {
  BilingualCopy,
  DEFAULT_NOTIFICATION_PREFERENCES,
  IDeviceTokenPayload,
  MANDATORY_NOTIFICATION_TYPES,
  NOTIFICATION_TYPES,
  NotificationChannel,
  NotificationPreferences,
  NotificationPriority,
  NotificationType,
  NotifyInput,
  NotifyResult,
} from './notifications.types';
import {
  PushCopy,
  PushDevice,
  PushLanguage,
  buildFcmPushPayload,
  normalizeDevicePlatform,
  normalizePushLanguage,
} from './notifications.push';
import {
  isFcmConfigured,
  normalizePushTokens,
  sendFcmMulticast,
} from '../../config/fcm';
import { AudienceRules, matchesAudienceRules } from './notifications.admin.rules';

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

const INSERT_CHUNK_SIZE = 200;

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

export type PreferenceFlags = {
  user_id: string;
  push_enabled: boolean;
  exam_reminders: boolean;
  streak_reminders: boolean;
  social: boolean;
  rewards: boolean;
  premium: boolean;
};

/**
 * The toggles that decide whether a campaign may reach an account. One query per
 * chunk, because a per-profile lookup would be hundreds of round trips.
 */
export const loadPreferenceFlags = async (
  userIds: string[]
): Promise<Map<string, PreferenceFlags>> => {
  const byUser = new Map<string, PreferenceFlags>();
  if (userIds.length === 0) return byUser;

  for (const idChunk of chunk(userIds, INSERT_CHUNK_SIZE)) {
    const { data, error } = await getAdmin()
      .from('notification_preferences')
      .select(
        'user_id, push_enabled, exam_reminders, streak_reminders, social, rewards, premium'
      )
      .in('user_id', idChunk);

    if (error) {
      console.error('[notify] preference lookup failed:', error.message);
      continue;
    }

    (data ?? []).forEach((row: PreferenceFlags) => {
      byUser.set(String(row.user_id), row);
    });
  }

  return byUser;
};

const TYPE_TO_COLUMN: Record<string, keyof PreferenceFlags> = {
  exam: 'exam_reminders',
  streak: 'streak_reminders',
  social: 'social',
  reward: 'rewards',
  billing: 'premium',
};

/** A missing row means the defaults, which allow the category. */
export const categoryEnabledForType = (
  flags: PreferenceFlags | undefined,
  type: string
): boolean => {
  if (!flags) return true;
  if (type === 'security') return true;

  const column = TYPE_TO_COLUMN[type];
  return column ? Boolean(flags[column] ?? true) : true;
};

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
    quiet_start: clock(source.quiet_start as string, DEFAULT_NOTIFICATION_PREFERENCES.quiet_start),
    quiet_end: clock(source.quiet_end as string, DEFAULT_NOTIFICATION_PREFERENCES.quiet_end),
    timezone:
      typeof source.timezone === 'string' && source.timezone.trim()
        ? source.timezone.trim().slice(0, 64)
        : DEFAULT_NOTIFICATION_PREFERENCES.timezone,
  };
};

type PreferenceRow = {
  push_enabled: boolean;
  exam_reminders: boolean;
  streak_reminders: boolean;
  social: boolean;
  rewards: boolean;
  premium: boolean;
  quiet_start: string;
  quiet_end: string;
  timezone: string;
};

const PREFERENCE_COLUMNS =
  'push_enabled, exam_reminders, streak_reminders, social, rewards, premium, quiet_start, quiet_end, timezone';

const clock = (value: string | null | undefined, fallback: string): string => {
  const normalized = String(value ?? '').slice(0, 5);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(normalized) ? normalized : fallback;
};

const preferencesFromRow = (row: PreferenceRow | null): NotificationPreferences => ({
  types: {
    exam: row?.exam_reminders ?? true,
    reward: row?.rewards ?? true,
    streak: row?.streak_reminders ?? true,
    social: row?.social ?? true,
    billing: row?.premium ?? true,
    security: true,
  },
  in_app: true,
  push: row?.push_enabled ?? true,
  quiet_start: clock(row?.quiet_start, '23:00'),
  quiet_end: clock(row?.quiet_end, '07:00'),
  timezone: row?.timezone || 'Asia/Dhaka',
});

export const getNotificationPreferences = async (
  userId: string
): Promise<NotificationPreferences> => {
  const { data, error } = await getAdmin()
    .from('notification_preferences')
    .select(PREFERENCE_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (data) return preferencesFromRow(data as PreferenceRow);

  // A missing row means the defaults; writing it keeps later updates simple.
  const { error: insertError } = await getAdmin()
    .from('notification_preferences')
    .insert({ user_id: userId })
    .select('user_id');

  if (insertError && insertError.code !== '23505') {
    console.error('[notify] preference seed failed:', insertError.message);
  }

  return preferencesFromRow(null);
};

export const updateNotificationPreferences = async (
  userId: string,
  patch: unknown
): Promise<NotificationPreferences> => {
  const incoming = patch && typeof patch === 'object' && !Array.isArray(patch) ? (patch as AnyObject) : {};
  const incomingTypes =
    incoming.types && typeof incoming.types === 'object' && !Array.isArray(incoming.types)
      ? (incoming.types as AnyObject)
      : {};

  const next = await getNotificationPreferences(userId);
  const update: AnyObject = {};

  if (typeof incoming.push === 'boolean') update.push_enabled = incoming.push;
  // in_app is accepted for compatibility but can never be turned off.
  if (typeof incoming.types?.exam === 'boolean') update.exam_reminders = incoming.types.exam;
  if (typeof incoming.types?.streak === 'boolean') update.streak_reminders = incoming.types.streak;
  if (typeof incoming.types?.social === 'boolean') update.social = incoming.types.social;
  if (typeof incoming.types?.reward === 'boolean') update.rewards = incoming.types.reward;
  if (typeof incoming.types?.billing === 'boolean') update.premium = incoming.types.billing;
  if (typeof incoming.quiet_start === 'string') update.quiet_start = clock(incoming.quiet_start, next.quiet_start);
  if (typeof incoming.quiet_end === 'string') update.quiet_end = clock(incoming.quiet_end, next.quiet_end);
  if (typeof incoming.timezone === 'string' && incoming.timezone.trim()) {
    update.timezone = String(incoming.timezone).trim().slice(0, 64);
  }

  const { error } = await getAdmin()
    .from('notification_preferences')
    .upsert({ user_id: userId, ...update }, { onConflict: 'user_id' });

  if (error) throw new Error(error.message);

  return getNotificationPreferences(userId);
};

// --- Push --------------------------------------------------------------------

export type PushResult = {
  token: string;
  deviceId: string | null;
  status: 'accepted' | 'failed' | 'invalid_token';
};

type PushOutcome = {
  /** Devices FCM accepted the message for. Acceptance is not proof of display. */
  sent: number;
  failed: number;
  invalidTokens: number;
  messageId: string | null;
  error: string | null;
  /** Per-device result, written to notification_push_log by the dispatcher. */
  results: PushResult[];
};

const emptyPushOutcome = (error: string | null = null): PushOutcome => ({
  sent: 0,
  failed: 0,
  invalidTokens: 0,
  messageId: null,
  error,
  results: [],
});

/** Text language per account, used to localise the system notification. */
const loadProfileLanguages = async (
  userIds: string[]
): Promise<Map<string, PushLanguage>> => {
  const byUser = new Map<string, PushLanguage>();

  for (const idChunk of chunk(userIds, INSERT_CHUNK_SIZE)) {
    const { data, error } = await getAdmin()
      .from('profiles')
      .select('id, language_preference')
      .in('id', idChunk);

    if (error) {
      console.error('[notify] language lookup failed:', error.message);
      continue;
    }

    (data ?? []).forEach((row: AnyObject) => {
      byUser.set(String(row.id), normalizePushLanguage(row.language_preference));
    });
  }

  return byUser;
};

/**
 * Every active registration token for the given accounts, de-duplicated by
 * token. This is the only place the server decides who can receive a push:
 * tokens are read with the service role and never returned to a client.
 */
export const loadDeviceTokens = async (userIds: string[]): Promise<PushDevice[]> => {
  const ids = normalizeUserIds(userIds);
  if (ids.length === 0) return [];

  const languages = await loadProfileLanguages(ids);
  const devices = new Map<string, PushDevice>();

  for (const idChunk of chunk(ids, INSERT_CHUNK_SIZE)) {
    const { data, error } = await getAdmin()
      .from('user_devices')
      .select('user_id, device_id, fcm_token, platform')
      .in('user_id', idChunk)
      .not('fcm_token', 'is', null);

    if (error) {
      console.error('[notify] device token lookup failed:', error.message);
      continue;
    }

    (data ?? []).forEach((row: AnyObject) => {
      const token = String(row.fcm_token ?? '').trim();
      if (!token) return;

      devices.set(token, {
        token,
        deviceId: row.device_id ? String(row.device_id) : null,
        platform: normalizeDevicePlatform(row.platform),
        language: languages.get(String(row.user_id)) ?? 'bn',
      });
    });
  }

  return Array.from(devices.values());
};

/**
 * Removes tokens FCM reported as unregistered or invalid. The device row is kept
 * so the security history and the login dedupe key stay intact.
 */
const deactivateInvalidTokens = async (tokens: string[]): Promise<void> => {
  const unique = normalizePushTokens(tokens);
  if (unique.length === 0) return;

  for (const tokenChunk of chunk(unique, INSERT_CHUNK_SIZE)) {
    const { error } = await getAdmin()
      .from('user_devices')
      .update({ fcm_token: null, last_active_at: new Date().toISOString() })
      .in('fcm_token', tokenChunk);

    if (error) {
      console.error('[notify] invalid token cleanup failed:', error.message);
    }
  }
};

/**
 * Sends one payload to the given devices.
 *
 * Devices are grouped by platform and language because both change the payload:
 * Android needs a system notification block for a terminated app, the web client
 * renders its own from data-only pushes, and the text follows the recipient's
 * stored language instead of fanning out a second message per language.
 */
export const sendPushToDevices = async (
  devices: PushDevice[],
  copy: PushCopy
): Promise<PushOutcome> => {
  if (devices.length === 0) return emptyPushOutcome();

  if (!isFcmConfigured()) return emptyPushOutcome('fcm_not_configured');

  const groups = new Map<string, string[]>();

  for (const device of devices) {
    const key = `${device.platform}:${device.language}`;
    const tokens = groups.get(key) ?? [];
    tokens.push(device.token);
    groups.set(key, tokens);
  }

  const outcome = emptyPushOutcome();
  const invalidTokens: string[] = [];
  const deviceByToken = new Map<string, string | null>();
  devices.forEach((device) => deviceByToken.set(device.token, device.deviceId ?? null));

  for (const [key, tokens] of groups) {
    const [platform, language] = key.split(':') as [PushDevice['platform'], PushLanguage];

    const result = await sendFcmMulticast(
      tokens,
      buildFcmPushPayload(copy, { platform, language })
    );

    outcome.sent += result.accepted;
    outcome.failed += result.failed;
    outcome.invalidTokens += result.invalidTokens.length;
    outcome.messageId = outcome.messageId ?? result.messageIds[0] ?? null;
    if (result.error) outcome.error = result.error;
    invalidTokens.push(...result.invalidTokens);

    result.acceptedTokens.forEach((token) =>
      outcome.results.push({ token, deviceId: deviceByToken.get(token) ?? null, status: 'accepted' })
    );
    result.failedTokens.forEach((token) =>
      outcome.results.push({ token, deviceId: deviceByToken.get(token) ?? null, status: 'failed' })
    );
    result.invalidTokens.forEach((token) =>
      outcome.results.push({ token, deviceId: deviceByToken.get(token) ?? null, status: 'invalid_token' })
    );
  }

  await deactivateInvalidTokens(invalidTokens);

  return outcome;
};

// --- Campaign broadcasts -----------------------------------------------------

/**
 * Campaign targeting is applied to the profile, not to a device: a user with
 * two phones must match or miss the campaign as one person. The matcher lives in
 * notifications.admin.rules so the dashboard preview and the send path cannot
 * drift apart.
 */
export const matchesCampaignTargetRules = (
  rules: unknown,
  profile: AnyObject,
  platforms: string[] = []
): boolean =>
  matchesAudienceRules(
    (rules && typeof rules === 'object' && !Array.isArray(rules)
      ? rules
      : null) as AudienceRules | null,
    profile,
    platforms
  );

const AUDIENCE_PAGE = 1000;
const AUDIENCE_MAX_PAGES = 100;

/**
 * Registered platforms per account.
 *
 * `user_devices` records which installations this account opened the app on, so
 * it is the audience a campaign may target. Platform is read here; the tokens
 * themselves are loaded separately and only for the accounts that survive the
 * audience filter.
 */
export const loadDevicePlatforms = async (): Promise<Map<string, Set<string>>> => {
  const byUser = new Map<string, Set<string>>();

  for (let page = 0; page < AUDIENCE_MAX_PAGES; page += 1) {
    const from = page * AUDIENCE_PAGE;
    const { data, error } = await getAdmin()
      .from('user_devices')
      .select('user_id, platform')
      .order('user_id', { ascending: true })
      .range(from, from + AUDIENCE_PAGE - 1);

    if (error) {
      console.error('[notify] device audience lookup failed:', error.message);
      break;
    }

    const rows = (data ?? []) as AnyObject[];
    rows.forEach((row) => {
      const userId = String(row.user_id ?? '');
      if (!userId) return;
      const platforms = byUser.get(userId) ?? new Set<string>();
      platforms.add(String(row.platform ?? 'web'));
      byUser.set(userId, platforms);
    });

    if (rows.length < AUDIENCE_PAGE) break;
  }

  return byUser;
};

/**
 * Result of one campaign delivery attempt. `accepted` counts devices FCM accepted
 * the message for, which is provider acceptance rather than proof a user saw it;
 * no delivery or open rate is derived from it.
 */
/** Resolves the accounts' tokens and sends. Never throws into the caller. */
export const sendPushToUsers = async (
  userIds: string | string[],
  copy: PushCopy
): Promise<PushOutcome> => {
  const ids = normalizeUserIds(Array.isArray(userIds) ? userIds : [userIds]);
  if (ids.length === 0) return emptyPushOutcome();

  try {
    const devices = await loadDeviceTokens(ids);
    if (devices.length === 0) return emptyPushOutcome('no_registered_devices');

    return await sendPushToDevices(devices, copy);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'push failed';
    console.error('[notify] push failed:', message.slice(0, 300));
    return emptyPushOutcome(message.slice(0, 300));
  }
};

export type CampaignPushResult = {
  accepted: number;
  failed: number;
  invalidTokens: number;
  messageId: string | null;
  error: string | null;
};

const emptyCampaignResult = (error: string | null = null): CampaignPushResult => ({
  accepted: 0,
  failed: 0,
  invalidTokens: 0,
  messageId: null,
  error,
});

/**
 * Delivers one bilingual campaign push and reports what the provider accepted.
 * The notification row is written by the caller first, so a provider failure
 * leaves the in-app record intact and the failure visible in `push_error`.
 */
export const sendCampaignPush = async (campaign: {
  id: string;
  title_bn?: string | null;
  title_en?: string | null;
  body_bn?: string | null;
  body_en?: string | null;
  imageUrl?: string | null;
  actionLink?: string | null;
  targetRules?: unknown;
  type?: string | null;
  priority?: NotificationPriority;
}): Promise<CampaignPushResult> => {
  try {
    const devicePlatforms = await loadDevicePlatforms();
    if (devicePlatforms.size === 0) {
      return emptyCampaignResult('no_registered_devices');
    }

    const audience = Array.from(devicePlatforms.keys());
    const rules = (campaign.targetRules && typeof campaign.targetRules === 'object'
      ? campaign.targetRules
      : null) as AudienceRules | null;
    const type = String(campaign.type ?? 'social');
    const allowed: string[] = [];

    for (const userChunk of chunk(audience, INSERT_CHUNK_SIZE)) {
      const { data, error } = await getAdmin()
        .from('profiles')
        .select(
          'id, settings, class_level, education_board, subscription_status, last_active_at, account_status'
        )
        .in('id', userChunk);

      if (error) {
        console.error('[notify] campaign audience lookup failed:', error.message);
        continue;
      }

      const preferencesByUser = await loadPreferenceFlags(
        (data ?? []).map((profile: AnyObject) => String(profile.id))
      );

      (data ?? []).forEach((profile: AnyObject) => {
        if (String(profile.account_status ?? 'active') !== 'active') return;

        const flags = preferencesByUser.get(String(profile.id));
        if (flags && !flags.push_enabled) return;
        if (!categoryEnabledForType(flags, type)) return;

        if (
          matchesAudienceRules(
            rules,
            profile,
            Array.from(devicePlatforms.get(String(profile.id)) ?? [])
          )
        ) {
          allowed.push(String(profile.id));
        }
      });
    }

    if (allowed.length === 0) {
      return emptyCampaignResult('no_matching_subscribers');
    }

    const outcome = await sendPushToUsers(allowed, {
      title: {
        bn: campaign.title_bn ?? campaign.title_en ?? '',
        en: campaign.title_en ?? campaign.title_bn ?? '',
      },
      body: {
        bn: campaign.body_bn ?? campaign.body_en ?? '',
        en: campaign.body_en ?? campaign.body_bn ?? '',
      },
      imageUrl: campaign.imageUrl ?? null,
      actionLink: campaign.actionLink ?? null,
      type,
      notificationId: campaign.id,
      priority: campaign.priority,
    });

    if (outcome.error) {
      console.error('[notify] campaign push failed:', outcome.error);
    }

    return {
      accepted: outcome.sent,
      failed: outcome.failed,
      invalidTokens: outcome.invalidTokens,
      messageId: outcome.messageId,
      error: outcome.error,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'campaign push failed';
    console.error('[notify] campaign broadcast failed:', message);
    return emptyCampaignResult(message);
  }
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

      // The inbox row is always created. Whether it also becomes a push is
      // decided once, by can_send_push, when the dispatcher picks the row up.
      const wantsInApp = mandatory || channels.has('in_app');
      const wantsPush = channels.has('push');

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
        },
        status: 'sent',
        sent_at: new Date().toISOString(),
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
        .select('id, target_user_id, title_bn, title_en, body_bn, body_en, action_link, image_url, type, priority, meta_data');

      if (error) {
        console.error('[notify] insert failed:', error.message);
        continue;
      }

      insertedRows.push(...(data ?? []));
    }

    result.inserted = insertedRows.length;

    // Delivery is the dispatcher's job: it enforces the daily cap, the gap and
    // quiet hours in one place, and it owns the retry schedule.
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
  isClicked = false,
  platform: string | null = null
): Promise<void> => {
  if (!notificationId) throw new Error('Notification id is required');

  const visible = await isNotificationVisibleToUser(userId, notificationId);
  if (!visible) throw new Error('Notification not found');

  const now = new Date().toISOString();
  const read: AnyObject = {
    notification_id: notificationId,
    user_id: userId,
    is_read: true,
    read_at: now,
  };

  // A plain open must not clear an earlier click: only set the click columns
  // when this request is actually a click.
  if (isClicked) {
    read.is_clicked = true;
    read.clicked_at = now;
    read.device_platform = normalizeDevicePlatform(platform);
  }

  const { error } = await getAdmin()
    .from('notification_reads')
    .upsert(read, { onConflict: 'user_id,notification_id' });

  if (error) throw new Error(error.message);

  if (isClicked) {
    // Derived, not incremented: two rapid taps cannot inflate the counter.
    const { count } = await getAdmin()
      .from('notification_reads')
      .select('id', { count: 'exact', head: true })
      .eq('notification_id', notificationId)
      .eq('is_clicked', true);

    await getAdmin()
      .from('notifications')
      .update({ total_clicks: count ?? 0 })
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

  const deviceId = String(payload.device_id).trim();
  const fcmToken = payload.fcm_token ? String(payload.fcm_token).trim() : null;
  const platform = normalizeDevicePlatform(payload.platform);

  const { data: existing } = await getAdmin()
    .from('user_devices')
    .select('id')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();

  // One installation holds one active token. Releasing it from other rows stops
  // a previous account on a shared phone from receiving this device's pushes.
  if (fcmToken) {
    const { error: releaseError } = await getAdmin()
      .from('user_devices')
      .update({ fcm_token: null })
      .eq('fcm_token', fcmToken)
      .neq('device_id', deviceId);

    if (releaseError) {
      console.error('Device token release failed:', releaseError.message);
    }
  }

  const device = {
    user_id: userId,
    device_id: deviceId,
    device_name: payload.device_name || 'Web Client',
    os_or_browser: payload.os_or_browser || 'Unknown',
    fcm_token: fcmToken,
    platform,
    ip_address: payload.ip_address || null,
    last_active_at: new Date().toISOString(),
    is_trusted: true,
  };

  // The live schema may not enforce a unique (user_id, device_id) pair, so do
  // not make registration depend on an ON CONFLICT target that may not exist.
  const { data, error } = existing?.id
    ? await getAdmin()
        .from('user_devices')
        .update(device)
        .eq('id', existing.id)
        .select()
    : await getAdmin().from('user_devices').insert([device]).select();

  if (error) {
    console.error('Device token save failed:', error);
    throw new Error(error.message);
  }

  if (!existing && fcmToken) {
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
      dedupeKey: `new_device:${userId}:${deviceId}`,
      metaData: { device_id: deviceId },
    });
  }

  return data;
};

/**
 * Deactivates this installation's token on sign-out or account switch. The row
 * is kept so the security history and the "new device login" dedupe survive.
 */
export const deactivateUserDeviceToken = async (
  userId: string,
  deviceId: string
): Promise<void> => {
  const id = String(deviceId ?? '').trim();
  if (!id) throw new Error('Device ID is required');

  const { error } = await getAdmin()
    .from('user_devices')
    .update({ fcm_token: null, last_active_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('device_id', id);

  if (error) throw new Error(error.message);
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
