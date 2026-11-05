import {
  NOTIFICATION_TYPES,
  NotificationPriority,
  NotificationType,
} from './notifications.types';

/**
 * Validation and audience rules for admin-authored notifications.
 *
 * Kept free of database and HTTP imports so the rules can be unit tested and so
 * the dashboard preview and the actual send always agree on an audience.
 */

export type CampaignMode = 'draft' | 'schedule' | 'send';
export type AudiencePlatform = 'android' | 'web';
export type CampaignStatus = 'draft' | 'scheduled' | 'sent' | 'failed' | 'cancelled';

export interface AudienceRules {
  subscription_status?: 'all' | 'free' | 'premium';
  class_level?: string[];
  education_board?: string[];
  /** Accounts whose last activity is older than this many days. */
  last_active_days_ago?: number;
  /** Registered device platforms the account must own. */
  platform?: AudiencePlatform[];
  specific_user_id?: string;
  specific_user_ids?: string[];
}

export interface CampaignRecordInput {
  title_en: string;
  title_bn: string | null;
  body_en: string;
  body_bn: string | null;
  image_url: string | null;
  action_link: string | null;
  type: NotificationType;
  priority: NotificationPriority;
  channel: 'both';
  target_user_id: string | null;
  target_rules: AudienceRules;
  meta_data: Record<string, unknown>;
  scheduled_at: string | null;
  expires_at: string | null;
}

export interface ValidatedCampaign {
  record: CampaignRecordInput;
  mode: CampaignMode;
}

export interface CampaignListFilters {
  status?: CampaignStatus;
  type?: NotificationType;
  search?: string;
  from: string;
  to: string;
  page: number;
  limit: number;
}

/** Audit rows reference a notification id; reject anything that is not one. */
export const isUuid = (value: unknown): boolean =>
  UUID_PATTERN.test(String(value ?? '').trim());

/** A request the client can fix; the controller maps this to its status code. */
export class NotificationAdminError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'NotificationAdminError';
    this.statusCode = statusCode;
  }
}

const MAX_TITLE = 120;
const MAX_BODY = 500;
const MAX_URL = 2048;
const MAX_LIST_LIMIT = 100;
const MAX_RULE_VALUES = 30;
const MAX_SPECIFIC_USERS = 100;
const MAX_DELAY_DAYS = 3650;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CAMPAIGN_STATUSES: CampaignStatus[] = [
  'draft',
  'scheduled',
  'sent',
  'failed',
  'cancelled',
];

export const NOTIFICATION_PRIORITIES: NotificationPriority[] = ['low', 'normal', 'high'];

export const AUDIENCE_PLATFORMS: AudiencePlatform[] = ['android', 'web'];

/** Older clients sent these type names; they map onto the six real categories. */
export const LEGACY_TYPE_MAP: Record<string, NotificationType> = {
  system: 'security',
  exam_alert: 'exam',
  promo: 'reward',
  group_invite: 'social',
  battle_challenge: 'social',
  focus_request: 'social',
  nudge_alert: 'social',
  global_notice: 'social',
  campaign: 'social',
};

const AUDIENCE_KEYS = new Set([
  'subscription_status',
  'class_level',
  'education_board',
  'last_active_days_ago',
  'platform',
  'specific_user_id',
  'specific_user_ids',
]);

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Notification copy is stored as plain text and rendered as text. Control
 * characters and angle brackets are removed so stored content can never be
 * interpreted as markup by a client that renders HTML.
 */
export const sanitizeCopy = (value: unknown): string =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export const normalizeNotificationType = (value: unknown): NotificationType => {
  const raw = String(value ?? '').trim();
  if (NOTIFICATION_TYPES.includes(raw as NotificationType)) return raw as NotificationType;
  return LEGACY_TYPE_MAP[raw] ?? 'social';
};

export const normalizePriority = (value: unknown): NotificationPriority => {
  const raw = String(value ?? '').trim().toLowerCase();
  return NOTIFICATION_PRIORITIES.includes(raw as NotificationPriority)
    ? (raw as NotificationPriority)
    : 'normal';
};

/**
 * Only in-app paths may be stored as an action link. An absolute URL, a
 * protocol-relative path or a backslash is refused, so a notification can never
 * push a student into an arbitrary destination.
 */
export const isSafeActionLink = (value: string): boolean =>
  value.startsWith('/') &&
  !value.startsWith('//') &&
  !value.includes('://') &&
  !/[\\\u0000-\u001f\u007f]/.test(value);

const isHttpsUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
};

const parseDate = (value: unknown, field: string): Date | null => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new NotificationAdminError(`Invalid ${field}`);
  }
  return date;
};

const parseStringList = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new NotificationAdminError(`${field} must be an array`);
  }
  if (value.length > MAX_RULE_VALUES) {
    throw new NotificationAdminError(`${field} accepts at most ${MAX_RULE_VALUES} values`);
  }

  const cleaned = value
    .map((item) => sanitizeCopy(item))
    .filter(Boolean);

  return cleaned.length > 0 ? Array.from(new Set(cleaned)) : undefined;
};

/** Validates the audience object sent by the admin panel. Unknown keys are refused. */
export const parseAudienceRules = (raw: unknown): AudienceRules => {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NotificationAdminError('target_rules must be an object');
  }

  const source = raw as Record<string, unknown>;
  Object.keys(source).forEach((key) => {
    if (!AUDIENCE_KEYS.has(key)) {
      throw new NotificationAdminError(`Unsupported audience rule: ${key}`);
    }
  });

  const rules: AudienceRules = {};

  if (source.subscription_status !== undefined) {
    const value = String(source.subscription_status);
    if (!['all', 'free', 'premium'].includes(value)) {
      throw new NotificationAdminError('subscription_status must be all, free or premium');
    }
    rules.subscription_status = value as AudienceRules['subscription_status'];
  }

  const classLevels = parseStringList(source.class_level, 'class_level');
  if (classLevels) rules.class_level = classLevels;

  const boards = parseStringList(source.education_board, 'education_board');
  if (boards) rules.education_board = boards;

  if (source.last_active_days_ago !== undefined) {
    const days = Number(source.last_active_days_ago);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DELAY_DAYS) {
      throw new NotificationAdminError(
        `last_active_days_ago must be a whole number between 1 and ${MAX_DELAY_DAYS}`
      );
    }
    rules.last_active_days_ago = days;
  }

  if (source.platform !== undefined) {
    const platforms = parseStringList(source.platform, 'platform') ?? [];
    const invalid = platforms.filter(
      (platform) => !AUDIENCE_PLATFORMS.includes(platform as AudiencePlatform)
    );
    if (invalid.length > 0) {
      throw new NotificationAdminError('platform accepts only android or web');
    }
    if (platforms.length > 0) rules.platform = platforms as AudiencePlatform[];
  }

  if (source.specific_user_id !== undefined && source.specific_user_id !== null) {
    const id = String(source.specific_user_id).trim();
    if (!UUID_PATTERN.test(id)) {
      throw new NotificationAdminError('specific_user_id must be a user id');
    }
    rules.specific_user_id = id;
    rules.specific_user_ids = [id];
  }

  if (source.specific_user_ids !== undefined && source.specific_user_ids !== null) {
    const ids = parseStringList(source.specific_user_ids, 'specific_user_ids') ?? [];
    if (ids.length > MAX_SPECIFIC_USERS) {
      throw new NotificationAdminError(
        `Select at most ${MAX_SPECIFIC_USERS} users`
      );
    }
    const invalid = ids.filter((id) => !UUID_PATTERN.test(id));
    if (invalid.length > 0) {
      throw new NotificationAdminError('specific_user_ids must be user ids');
    }
    if (ids.length > 0) rules.specific_user_ids = ids;
  }

  return rules;
};

const parseMetaData = (raw: unknown): Record<string, unknown> => {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NotificationAdminError('meta_data must be an object');
  }

  const source = raw as Record<string, unknown>;
  const entries = Object.entries(source);
  if (entries.length > 20) {
    throw new NotificationAdminError('meta_data accepts at most 20 keys');
  }

  const meta: Record<string, unknown> = {};
  entries.forEach(([key, value]) => {
    const safeKey = key.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40);
    if (!safeKey) return;

    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      meta[safeKey] = typeof value === 'string' ? sanitizeCopy(value).slice(0, 500) : value;
      return;
    }

    if (Array.isArray(value)) {
      const items = value
        .filter((item) => ['string', 'number', 'boolean'].includes(typeof item))
        .slice(0, 20)
        .map((item) => (typeof item === 'string' ? sanitizeCopy(item).slice(0, 200) : item));
      meta[safeKey] = items;
      return;
    }

    throw new NotificationAdminError(`meta_data.${safeKey} must be a flat value`);
  });

  return meta;
};

/**
 * Turns an admin form into the exact row that may be written. Anything the
 * client adds that is not listed here (status, created_by, total_sent, ...) is
 * dropped, so the request cannot escalate its own privileges.
 */
export const validateCampaignInput = (raw: unknown): ValidatedCampaign => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NotificationAdminError('A notification body is required');
  }

  const body = raw as Record<string, unknown>;

  const titleEn = sanitizeCopy(body.title_en).slice(0, MAX_TITLE);
  const titleBn = sanitizeCopy(body.title_bn).slice(0, MAX_TITLE);
  const bodyEn = sanitizeCopy(body.body_en).slice(0, MAX_BODY);
  const bodyBn = sanitizeCopy(body.body_bn).slice(0, MAX_BODY);

  if (!titleEn && !titleBn) {
    throw new NotificationAdminError('A title is required in at least one language');
  }
  if (!bodyEn && !bodyBn) {
    throw new NotificationAdminError('A message is required in at least one language');
  }

  const imageUrl = sanitizeCopy(body.image_url).slice(0, MAX_URL);
  if (imageUrl && !isHttpsUrl(imageUrl)) {
    throw new NotificationAdminError('image_url must be an https URL');
  }

  const actionLink = sanitizeCopy(body.action_link).slice(0, MAX_URL);
  if (actionLink && !isSafeActionLink(actionLink)) {
    throw new NotificationAdminError('action_link must be an in-app path such as /history');
  }

  const targetUserId = body.target_user_id ? String(body.target_user_id).trim() : '';
  if (targetUserId && !UUID_PATTERN.test(targetUserId)) {
    throw new NotificationAdminError('target_user_id must be a user id');
  }

  const targetRules = parseAudienceRules(body.target_rules);

  if (targetUserId) {
    if (targetRules.specific_user_ids && !targetRules.specific_user_ids.includes(targetUserId)) {
      throw new NotificationAdminError(
        'target_user_id and specific_user_ids disagree; send to one audience'
      );
    }
    targetRules.specific_user_ids = [targetUserId];
    targetRules.specific_user_id = targetUserId;
  }

  const scheduledFor = parseDate(body.scheduled_at, 'scheduled_at');
  const expiresAt = parseDate(body.expires_at, 'expires_at');
  const now = Date.now();

  if (expiresAt && expiresAt.getTime() <= now) {
    throw new NotificationAdminError('expires_at must be in the future');
  }

  const requestedMode = String(body.mode ?? '').trim();
  if (requestedMode && !['draft', 'schedule', 'send'].includes(requestedMode)) {
    throw new NotificationAdminError('mode must be draft, schedule or send');
  }

  let mode: CampaignMode;
  if (requestedMode === 'draft') {
    mode = 'draft';
  } else if (scheduledFor && scheduledFor.getTime() > now) {
    mode = 'schedule';
  } else {
    mode = 'send';
  }

  if (mode === 'schedule' && expiresAt && scheduledFor && expiresAt <= scheduledFor) {
    throw new NotificationAdminError('expires_at must be after the scheduled time');
  }

  const record: CampaignRecordInput = {
    title_en: titleEn || titleBn,
    title_bn: titleBn || null,
    body_en: bodyEn || bodyBn,
    body_bn: bodyBn || null,
    image_url: imageUrl || null,
    action_link: actionLink || null,
    type: normalizeNotificationType(body.type),
    priority: normalizePriority(body.priority),
    // In-app plus push: the inbox record is what makes an admin notification
    // visible in the app and what the delivery statistics describe.
    channel: 'both',
    target_user_id: null,
    target_rules: targetRules,
    meta_data: parseMetaData(body.meta_data),
    scheduled_at: mode === 'schedule' ? scheduledFor?.toISOString() ?? null : null,
    expires_at: expiresAt?.toISOString() ?? null,
  };

  return { record, mode };
};

const parseNumber = (value: unknown, field: string, fallback: number): number => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new NotificationAdminError(`${field} must be a positive number`);
  }
  return Math.floor(parsed);
};

/**
 * Only letters, combining marks, digits, spaces and dashes reach the PostgREST
 * filter syntax. Marks are kept so Bangla vowels and hasants survive.
 */
export const sanitizeSearch = (value: unknown): string =>
  String(value ?? '')
    .replace(/[^\p{L}\p{M}\p{N} _-]/gu, '')
    .trim()
    .slice(0, 100);

export const parseListFilters = (query: unknown): CampaignListFilters => {
  const source = asObject(query);

  const status = String(source.status ?? '').trim();
  if (status && !CAMPAIGN_STATUSES.includes(status as CampaignStatus)) {
    throw new NotificationAdminError('Unsupported status filter');
  }

  const type = String(source.type ?? '').trim();
  if (type && !NOTIFICATION_TYPES.includes(type as NotificationType)) {
    throw new NotificationAdminError('Unsupported type filter');
  }

  const from = parseDate(source.from, 'from');
  const to = parseDate(source.to, 'to');
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const start = from ?? defaultFrom;
  const end = to ?? now;

  if (end.getTime() <= start.getTime()) {
    throw new NotificationAdminError('to must be after from');
  }

  return {
    status: (status as CampaignStatus) || undefined,
    type: (type as NotificationType) || undefined,
    search: sanitizeSearch(source.search) || undefined,
    from: start.toISOString(),
    to: end.toISOString(),
    page: parseNumber(source.page, 'page', 1),
    limit: Math.min(parseNumber(source.limit, 'limit', 20), MAX_LIST_LIMIT),
  };
};

const isPremiumProfile = (profile: { subscription_status?: unknown }): boolean =>
  profile.subscription_status === 'premium' || profile.subscription_status === 'active';

/**
 * One audience matcher for the send path and the preview, so the count an admin
 * sees before sending is the audience that is actually used.
 */
export const matchesAudienceRules = (
  rules: AudienceRules | null | undefined,
  profile: {
    id?: unknown;
    subscription_status?: unknown;
    class_level?: unknown;
    education_board?: unknown;
    last_active_at?: unknown;
  },
  platforms: string[] = []
): boolean => {
  if (!rules) return true;

  const specific = rules.specific_user_ids
    ?? (rules.specific_user_id ? [rules.specific_user_id] : []);
  if (specific.length > 0 && !specific.includes(String(profile.id ?? ''))) {
    return false;
  }

  if (rules.subscription_status === 'premium' && !isPremiumProfile(profile)) return false;
  if (rules.subscription_status === 'free' && isPremiumProfile(profile)) return false;

  if (
    rules.class_level &&
    rules.class_level.length > 0 &&
    !rules.class_level.includes('all') &&
    !rules.class_level.includes(String(profile.class_level ?? ''))
  ) {
    return false;
  }

  if (
    rules.education_board &&
    rules.education_board.length > 0 &&
    !rules.education_board.includes('all') &&
    !rules.education_board.includes(String(profile.education_board ?? ''))
  ) {
    return false;
  }

  if (rules.platform && rules.platform.length > 0) {
    const owned = new Set(platforms.map((platform) => String(platform)));
    if (!rules.platform.some((platform) => owned.has(platform))) return false;
  }

  if (rules.last_active_days_ago) {
    const lastActive = new Date(String(profile.last_active_at ?? '')).getTime();
    if (
      Number.isFinite(lastActive) &&
      lastActive > Date.now() - rules.last_active_days_ago * 24 * 60 * 60 * 1000
    ) {
      return false;
    }
  }

  return true;
};

export interface NotificationStats {
  total: number;
  sent: number;
  scheduled: number;
  draft: number;
  cancelled: number;
  failed: number;
  /** Devices OneSignal accepted the message for. */
  providerAccepted: number;
  /** Devices the provider reported as delivered; only meaningful once refreshed. */
  delivered: number;
  /** How many notifications have provider delivery data. */
  deliveryReported: number;
  failedDevices: number;
  taps: number;
  pushErrored: number;
  devices: number;
  androidDevices: number;
  pushOptedIn: number;
  /** Provider-verified delivery rate, or null when no report exists yet. */
  deliveryRate: number | null;
  /** Taps divided by provider-accepted devices. */
  tapRate: number | null;
}

const numberOrZero = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const rate = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Math.min(1, numerator / denominator) : null;

/**
 * Coerces the RPC payload. Rates stay null instead of 0 when the provider has
 * not reported yet, so the dashboard can say "no data" rather than "0%".
 */
export const normalizeStats = (raw: unknown): NotificationStats => {
  const data = asObject(raw);

  const providerAccepted = numberOrZero(data.provider_accepted);
  const delivered = numberOrZero(data.delivered);
  const deliveryReported = numberOrZero(data.delivery_reported);

  return {
    total: numberOrZero(data.total),
    sent: numberOrZero(data.sent),
    scheduled: numberOrZero(data.scheduled),
    draft: numberOrZero(data.draft),
    cancelled: numberOrZero(data.cancelled),
    failed: numberOrZero(data.failed),
    providerAccepted,
    delivered,
    deliveryReported,
    failedDevices: numberOrZero(data.failed_devices),
    taps: numberOrZero(data.taps),
    pushErrored: numberOrZero(data.push_errored),
    devices: numberOrZero(data.devices),
    androidDevices: numberOrZero(data.android_devices),
    pushOptedIn: numberOrZero(data.push_opted_in),
    deliveryRate: deliveryReported > 0 ? rate(delivered, providerAccepted) : null,
    tapRate: rate(numberOrZero(data.taps), providerAccepted),
  };
};
