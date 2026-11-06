import { supabase } from '../../config/supabase';
import { dhakaDayKey, startOfDhakaDay, startOfDhakaDayIso } from '../../lib/utils/time';
import { SearchInputError, normalizeSearchTerm } from '../../lib/utils/search';
import { recordAdminAudit } from '../../lib/utils/adminAudit';

import { notifyPremiumGranted } from '../notifications/notifications.service';
/**
 * Validation / state error for the access feature. `status` drives the HTTP
 * code and `code` is forwarded to the client when it is on the exposed list
 * (see app.ts).
 */
export class AccessError extends Error {
  status: number;
  code: string;
  details?: unknown;
  /** Messages are hand-written constants, so even a 503 can be shown to the operator. */
  exposeMessage = true;

  constructor(message: string, status = 400, code = 'VALIDATION_FAILED', details?: unknown) {
    super(message);
    this.name = 'AccessError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const GRANT_SCOPES = ['all', 'user'] as const;
const GRANT_TYPES = ['premium', 'unlimited_quota'] as const;

const MAX_REASON_LENGTH = 500;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const parseTimestamp = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new AccessError('Invalid timestamp value');
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new AccessError('Invalid timestamp value');
  return new Date(parsed).toISOString();
};

export const getQuotaStatus = async (userId: string) => {
  const { data, error } = await supabase.rpc('get_quota_status', { p_user_id: userId });
  if (error) throw new Error(error.message);
  return data;
};

export const getQuotas = async () => {
  const { data, error } = await supabase.from('feature_quotas').select('*').order('feature');
  if (error) throw new Error(error.message);
  return data;
};

export const updateQuota = async (
  feature: string,
  data: { free_daily_limit?: number; is_enabled?: boolean },
  actorId?: string
) => {
  if (!isNonEmptyString(feature)) throw new AccessError('Feature is required');

  const patch: { free_daily_limit?: number; is_enabled?: boolean } = {};

  if (data?.free_daily_limit !== undefined) {
    const limit = data.free_daily_limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
      throw new AccessError('free_daily_limit must be a whole number of 0 or greater');
    }
    patch.free_daily_limit = limit;
  }

  if (data?.is_enabled !== undefined) {
    if (typeof data.is_enabled !== 'boolean') {
      throw new AccessError('is_enabled must be a boolean');
    }
    patch.is_enabled = data.is_enabled;
  }

  if (Object.keys(patch).length === 0) {
    throw new AccessError('No supported fields to update');
  }

  // The feature must already exist; unknown features are a client error rather
  // than a silent no-op.
  const { data: existing, error: lookupError } = await supabase
    .from('feature_quotas')
    .select('feature, free_daily_limit, is_enabled')
    .eq('feature', feature)
    .maybeSingle();

  if (lookupError) throw new Error(lookupError.message);
  if (!existing) throw new AccessError('Unknown feature', 404);

  const { data: result, error } = await supabase
    .from('feature_quotas')
    .update(patch)
    .eq('feature', feature)
    .select()
    .single();

  if (error) throw new Error(error.message);

  // A service-role write carries no auth.uid(), so the actor is recorded
  // explicitly from the verified token subject.
  await recordAdminAudit(actorId, 'access.quota.update', 'feature_quotas', feature, {
    before: {
      free_daily_limit: (existing as any).free_daily_limit,
      is_enabled: (existing as any).is_enabled,
    },
    after: patch,
  });

  return result;
};

const GRANT_STATUSES = ['active', 'scheduled', 'expired', 'revoked', 'all'] as const;
type GrantStatus = (typeof GRANT_STATUSES)[number];

const MAX_GRANT_PAGE_SIZE = 100;

const readPositiveInt = (value: unknown, fallback: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) return fallback;
  return parsed;
};

/** Applies the status filter in SQL so pagination counts stay correct. */
const applyGrantStatus = (query: any, status: GrantStatus, nowIso: string) => {
  if (status === 'revoked') return query.not('revoked_at', 'is', null);
  if (status === 'expired') {
    return query.is('revoked_at', null).not('expires_at', 'is', null).lte('expires_at', nowIso);
  }
  if (status === 'scheduled') {
    return query.is('revoked_at', null).gt('starts_at', nowIso);
  }
  if (status === 'active') {
    return query
      .is('revoked_at', null)
      .lte('starts_at', nowIso)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`);
  }
  return query;
};

export const getGrants = async (filters: any) => {
  const now = new Date();
  const nowIso = now.toISOString();

  const status = (GRANT_STATUSES as readonly string[]).includes(String(filters?.status))
    ? (filters.status as GrantStatus)
    : 'all';
  const scope = filters?.scope === 'all' || filters?.scope === 'user' ? filters.scope : null;
  const page = readPositiveInt(filters?.page, 1, 100_000);
  const pageSize = readPositiveInt(filters?.page_size, 20, MAX_GRANT_PAGE_SIZE);

  let query = supabase
    .from('access_grants')
    .select(
      `
      *,
      profiles:user_id(full_name, email, username)
    `,
      { count: 'exact' }
    )
    .order('created_at', { ascending: false });

  if (scope) query = query.eq('scope', scope);
  if (filters?.user_id) query = query.eq('user_id', filters.user_id);

  query = applyGrantStatus(query, status, nowIso);

  const from = (page - 1) * pageSize;
  const { data, error, count } = await query.range(from, from + pageSize - 1);
  if (error) throw new Error(error.message);

  // Status totals for the filter chips. `head: true` keeps them to counts.
  const countFor = async (value: GrantStatus): Promise<number> => {
    const base = supabase.from('access_grants').select('id', { count: 'exact', head: true });
    const scoped = scope ? base.eq('scope', scope) : base;
    const { count: total, error: countError } = await applyGrantStatus(scoped, value, nowIso);
    if (countError) return 0;
    return total ?? 0;
  };

  const [active, scheduled, expired, revoked] = await Promise.all([
    countFor('active'),
    countFor('scheduled'),
    countFor('expired'),
    countFor('revoked'),
  ]);

  return {
    items: (data || []).map((grant: any) => ({
      ...grant,
      user: grant.profiles,
    })),
    total: count ?? 0,
    page,
    page_size: pageSize,
    has_more: from + (data || []).length < (count ?? 0),
    counts: { active, scheduled, expired, revoked },
  };
};

const assertKnownFeatures = async (features: string[]): Promise<string[]> => {
  const unique = Array.from(new Set(features.map((feature) => String(feature).trim()).filter(Boolean)));

  if (unique.length === 0) return [];

  const { data, error } = await supabase.from('feature_quotas').select('feature').in('feature', unique);

  if (error) throw new Error(error.message);

  const known = new Set((data || []).map((row: any) => String(row.feature)));
  const unknown = unique.filter((feature) => !known.has(feature));

  if (unknown.length > 0) {
    throw new AccessError(`Unknown feature: ${unknown.join(', ')}`, 400, 'VALIDATION_FAILED', {
      unknown_features: unknown
    });
  }

  return unique;
};

export const createGrant = async (payload: any, adminId: string) => {
  if (!isNonEmptyString(adminId)) throw new AccessError('Administrator identity is required', 401);

  const scope = payload?.scope;
  if (!GRANT_SCOPES.includes(scope)) {
    throw new AccessError("scope must be either 'all' or 'user'");
  }

  const grantType = payload?.grant_type;
  if (!GRANT_TYPES.includes(grantType)) {
    throw new AccessError("grant_type must be either 'premium' or 'unlimited_quota'");
  }

  const userId = scope === 'user' ? payload?.user_id : null;
  if (scope === 'user' && !isNonEmptyString(userId)) {
    throw new AccessError('user_id is required when scope is user');
  }
  if (scope === 'all' && payload?.user_id) {
    throw new AccessError('user_id must not be set when scope is all');
  }

  if (!isNonEmptyString(payload?.reason)) {
    throw new AccessError('A reason is required');
  }

  const reason = String(payload.reason).trim();
  if (reason.length > MAX_REASON_LENGTH) {
    throw new AccessError(`Reason must be at most ${MAX_REASON_LENGTH} characters`);
  }

  const expiresAt = parseTimestamp(payload?.expires_at);
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    throw new AccessError('expires_at must be a future timestamp');
  }

  const startsAt = parseTimestamp(payload?.starts_at);

  const requestedFeatures = Array.isArray(payload?.features) ? payload.features : [];
  if (grantType === 'unlimited_quota' && requestedFeatures.length === 0) {
    throw new AccessError('At least one feature is required for an unlimited_quota grant');
  }

  const features = grantType === 'premium' ? null : await assertKnownFeatures(requestedFeatures);

  const insertData = {
    scope,
    user_id: scope === 'user' ? String(userId) : null,
    grant_type: grantType,
    features,
    reason,
    expires_at: expiresAt,
    granted_by: adminId,
    starts_at: startsAt ?? new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('access_grants')
    .insert([insertData])
    .select()
    .single();

  if (error) {
    // A dangling user reference is a client error, not a server failure.
    if ((error as any).code === '23503') {
      throw new AccessError('User not found', 400);
    }
    throw new Error(error.message);
  }

  await recordAdminAudit(adminId, 'access.grant.create', 'access_grants', String(data.id), {
    scope,
    user_id: insertData.user_id,
    grant_type: grantType,
    features,
    reason,
    expires_at: expiresAt,
  });

  if (scope === 'user' && userId) {
    void notifyPremiumGranted(String(userId), grantType as 'premium' | 'unlimited_quota');
  }

  return data;
};

export const revokeGrant = async (id: string, adminId: string) => {
  if (!isNonEmptyString(adminId)) throw new AccessError('Administrator identity is required', 401);

  const { data, error } = await supabase
    .from('access_grants')
    .update({
      revoked_at: new Date().toISOString(),
      revoked_by: adminId
    })
    .eq('id', id)
    .is('revoked_at', null)
    .select();

  if (error) throw new Error(error.message);

  if (!data || data.length === 0) {
    const { data: existing, error: lookupError } = await supabase
      .from('access_grants')
      .select('id, revoked_at')
      .eq('id', id)
      .maybeSingle();

    if (lookupError) throw new Error(lookupError.message);
    if (!existing) throw new AccessError('Grant not found', 404);
    // Revocation is terminal: a revoked grant can never be revoked again.
    throw new AccessError('Grant is already revoked', 409);
  }

  await recordAdminAudit(adminId, 'access.grant.revoke', 'access_grants', id, {
    user_id: (data[0] as any).user_id,
    grant_type: (data[0] as any).grant_type,
  });

  return data[0];
};

export const searchUsers = async (q: string) => {
  const raw = typeof q === 'string' ? q.trim() : '';

  if (raw.length < 2) {
    throw new AccessError('Search requires at least 2 characters');
  }

  // The term is validated (length cap, no filter syntax, no control chars) and
  // LIKE-escaped before it is interpolated into the `or` filter. Commas and
  // parentheses are PostgREST syntax and are rejected outright.
  let term: string;

  try {
    term = normalizeSearchTerm(raw);
  } catch (error) {
    if (error instanceof SearchInputError) {
      throw new AccessError(error.message);
    }

    throw error;
  }

  if (!term) {
    throw new AccessError('Search requires at least 2 characters');
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, email, username, phone_number')
    .or(`full_name.ilike.%${term}%,email.ilike.%${term}%,username.ilike.%${term}%,phone_number.ilike.%${term}%`)
    .limit(20);

  if (error) throw new Error(error.message);
  return data;
};

export const getUserAccessDetails = async (userId: string) => {
  const [quota, grants, events] = await Promise.all([
    getQuotaStatus(userId),
    supabase.from('access_grants').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
    supabase.from('usage_events').select('*').eq('user_id', userId).order('usage_date', { ascending: false }).limit(30)
  ]);

  return {
    ...quota,
    grants: grants.data || [],
    recent_events: events.data || []
  };
};

/**
 * Resets today's metered usage for one feature by marking the day's events as
 * refunded. The day boundary is Asia/Dhaka (the quota boundary used by the
 * database), not the server's local timezone.
 */
export const resetUsage = async (userId: string, feature: string, now: Date = new Date()) => {
  if (!isNonEmptyString(userId)) throw new AccessError('User is required');
  if (!isNonEmptyString(feature)) throw new AccessError('Feature is required');

  const { data: knownFeature, error: lookupError } = await supabase
    .from('feature_quotas')
    .select('feature')
    .eq('feature', feature)
    .maybeSingle();

  if (lookupError) throw new Error(lookupError.message);
  if (!knownFeature) throw new AccessError('Unknown feature', 404);

  const since = startOfDhakaDayIso(now);
  const dayKey = dhakaDayKey(now);

  const { data, error } = await supabase
    .from('usage_events')
    .update({ refunded_at: now.toISOString() })
    .eq('user_id', userId)
    .eq('feature', feature)
    .eq('usage_date', dayKey)
    .is('refunded_at', null)
    .select('id');

  if (error) throw new Error(error.message);

  return {
    feature,
    since,
    refunded: (data || []).length
  };
};

const USAGE_WINDOW_DAYS = 14;
const USAGE_PAGE_SIZE = 1_000;
const TODAY_USAGE_ROW_LIMIT = 50_000;
const GRANT_PAGE_SIZE = 1_000;
const GRANT_ROW_LIMIT = 5_000;

interface GrantRow {
  id: string;
  user_id: string | null;
  scope: string;
  grant_type: string;
  features: string[] | null;
  starts_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

const isActiveGrant = (grant: GrantRow, now: number): boolean => {
  if (grant.revoked_at) return false;
  if (grant.starts_at && Date.parse(grant.starts_at) > now) return false;
  if (grant.expires_at && Date.parse(grant.expires_at) <= now) return false;
  return true;
};

/**
 * Every page of grants that can still be active. PostgREST caps a single
 * response (1000 rows by default), so the bounds here are request-side, not a
 * replacement for the server cap.
 */
const readGrantRows = async (nowIso: string): Promise<GrantRow[]> => {
  const rows: GrantRow[] = [];

  for (let from = 0; from < GRANT_ROW_LIMIT; from += GRANT_PAGE_SIZE) {
    const to = Math.min(from + GRANT_PAGE_SIZE - 1, GRANT_ROW_LIMIT - 1);
    const { data, error } = await supabase
      .from('access_grants')
      .select('id, user_id, scope, grant_type, features, starts_at, expires_at, revoked_at')
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to);

    if (error) throw new Error(error.message);
    const page = (data ?? []) as GrantRow[];
    rows.push(...page);
    if (page.length < GRANT_PAGE_SIZE) break;
  }

  return rows;
};

/** Counted separately because readGrantRows only fetches grants that can still be active. */
const countExpiredGrants = async (nowIso: string): Promise<number> => {
  const { count, error } = await supabase
    .from('access_grants')
    .select('id', { count: 'exact', head: true })
    .not('expires_at', 'is', null)
    .lte('expires_at', nowIso)
    .is('revoked_at', null);

  if (error) {
    console.error('[access] expired grant count unavailable:', error.message);
    return 0;
  }
  return count ?? 0;
};

interface UsageSummary {
  usersAtLimit: number;
  usersApproachingLimit: number;
  trend: Array<{ date: string; metered_uses: number }>;
}

interface TodayUsageRow {
  user_id: string;
  feature: string;
}

/** Today's per-user usage, read page by page so a busy day is not truncated. */
const readTodayUsage = async (
  todayKey: string,
  tomorrowKey: string
): Promise<TodayUsageRow[] | null> => {
  const rows: TodayUsageRow[] = [];

  for (let from = 0; from < TODAY_USAGE_ROW_LIMIT; from += USAGE_PAGE_SIZE) {
    const to = Math.min(from + USAGE_PAGE_SIZE - 1, TODAY_USAGE_ROW_LIMIT - 1);
    const { data, error } = await supabase
      .from('usage_events')
      .select('id, user_id, feature')
      .gte('usage_date', todayKey)
      .lt('usage_date', tomorrowKey)
      .is('refunded_at', null)
      .order('id', { ascending: true })
      .range(from, to);

    if (error) return null;
    const page = data ?? [];
    rows.push(
      ...page.map((event: any) => ({
        user_id: String(event.user_id),
        feature: String(event.feature),
      }))
    );
    if (page.length < USAGE_PAGE_SIZE) break;
  }

  return rows;
};

/**
 * Today's quota pressure and a 14-day metered-usage trend. Daily totals use
 * `count=exact` so PostgREST's row cap cannot undercount the trend; only today's
 * per-user rows are read in full, because the at-limit counts need grouping.
 */
const loadUsageSummary = async (now: Date): Promise<UsageSummary> => {
  const todayStart = startOfDhakaDay(now);
  const todayKey = dhakaDayKey(now);
  const tomorrowKey = dhakaDayKey(new Date(todayStart.getTime() + 24 * 60 * 60 * 1000));

  const days = Array.from({ length: USAGE_WINDOW_DAYS }, (_, index) => {
    const start = new Date(
      todayStart.getTime() - (USAGE_WINDOW_DAYS - 1 - index) * 24 * 60 * 60 * 1000
    );
    return {
      date: dhakaDayKey(start),
      startKey: dhakaDayKey(start),
      endKey: dhakaDayKey(new Date(start.getTime() + 24 * 60 * 60 * 1000)),
    };
  });

  const [quotasResult, todayRows, ...dailyCounts] = await Promise.all([
    supabase.from('feature_quotas').select('feature, free_daily_limit, is_enabled'),
    readTodayUsage(todayKey, tomorrowKey),
    ...days.map((day) =>
      supabase
        .from('usage_events')
        .select('id', { count: 'exact', head: true })
        .gte('usage_date', day.startKey)
        .lt('usage_date', day.endKey)
        .is('refunded_at', null)
    ),
  ]);

  const trend = days.map((day, index) => ({
    date: day.date,
    metered_uses: dailyCounts[index]?.count ?? 0,
  }));

  const empty: UsageSummary = {
    usersAtLimit: 0,
    usersApproachingLimit: 0,
    trend,
  };

  if (quotasResult.error || !todayRows) return empty;

  const limits = new Map<string, number>();
  (quotasResult.data ?? []).forEach((quota: any) => {
    const limit = Number(quota.free_daily_limit);
    if (quota.is_enabled === true && Number.isFinite(limit) && limit > 0) {
      limits.set(String(quota.feature), limit);
    }
  });

  const usedToday = new Map<string, Map<string, number>>();

  todayRows.forEach((event) => {
    const byUser = usedToday.get(event.feature) ?? new Map<string, number>();
    byUser.set(event.user_id, (byUser.get(event.user_id) ?? 0) + 1);
    usedToday.set(event.feature, byUser);
  });

  const atLimit = new Set<string>();
  const approaching = new Set<string>();

  usedToday.forEach((byUser, feature) => {
    const limit = limits.get(feature);
    if (!limit) return;
    const nearThreshold = Math.max(1, Math.ceil(limit * 0.8));

    byUser.forEach((used, userId) => {
      if (used >= limit) {
        atLimit.add(userId);
        return;
      }
      if (used >= nearThreshold) approaching.add(userId);
    });
  });

  return {
    usersAtLimit: atLimit.size,
    usersApproachingLimit: [...approaching].filter((userId) => !atLimit.has(userId)).length,
    trend,
  };
};

/**
 * Access distribution.
 *
 * Every number comes from the tables the entitlement functions read
 * (profiles.subscription_status, access_grants, usage_events and
 * feature_quotas). No second entitlement model is introduced: `premium` is the
 * subscription flag, and grant metrics count recorded grant rows.
 */
export const getOverview = async () => {
  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const soonIso = new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString();
  const since = startOfDhakaDayIso(now);

  const [premiumUsers, totalUsers, grantRows, expiredGrantCount, usage] = await Promise.all([
    supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('subscription_status', 'premium'),
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    readGrantRows(nowIso),
    countExpiredGrants(nowIso),
    loadUsageSummary(now),
  ]);

  if (premiumUsers.error) throw new Error(premiumUsers.error.message);
  if (totalUsers.error) throw new Error(totalUsers.error.message);

  const total = totalUsers.count ?? 0;
  const active = grantRows.filter((grant) => isActiveGrant(grant, nowMs));

  const manualPremium = active.filter(
    (grant) => grant.grant_type === 'premium' && grant.scope === 'user' && grant.user_id
  );
  const promotions = active.filter(
    (grant) => grant.grant_type === 'premium' && grant.scope === 'all'
  );
  const unlimitedGrants = active.filter((grant) => grant.grant_type === 'unlimited_quota');

  const unlimitedAllScope = unlimitedGrants.some(
    (grant) => grant.scope === 'all' && (!grant.features || grant.features.length === 0)
  );
  const unlimitedUsers = unlimitedAllScope
    ? total
    : new Set(unlimitedGrants.map((grant) => grant.user_id).filter(Boolean)).size;

  const expiringSoon = active.filter(
    (grant) => grant.expires_at && grant.expires_at > nowIso && grant.expires_at <= soonIso
  );

  return {
    total_users: total,
    premium_users: premiumUsers.count ?? 0,
    free_users: total - (premiumUsers.count ?? 0),
    active_grants: active.length,
    manual_premium_users: new Set(manualPremium.map((grant) => grant.user_id)).size,
    promotion_grants: promotions.length,
    unlimited_quota_grants: unlimitedGrants.length,
    unlimited_users: unlimitedUsers,
    expired_grants: expiredGrantCount,
    expiring_soon_grants: expiringSoon.length,
    users_who_hit_limit_today: usage.usersAtLimit,
    users_approaching_limit_today: usage.usersApproachingLimit,
    access_trend: usage.trend,
    day_start: since,
  };
};
