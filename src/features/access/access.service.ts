import { supabase } from '../../config/supabase';
import { startOfDhakaDayIso } from '../../lib/utils/time';
import { SearchInputError, normalizeSearchTerm } from '../../lib/utils/search';

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
  data: { free_daily_limit?: number; is_enabled?: boolean }
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
    .select('feature')
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
  return result;
};

export const getGrants = async (filters: any) => {
  let query = supabase
    .from('access_grants')
    .select(`
      *,
      profiles:user_id(full_name, email, username)
    `)
    .order('created_at', { ascending: false });

  if (filters.scope) query = query.eq('scope', filters.scope);
  if (filters.user_id) query = query.eq('user_id', filters.user_id);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return (data || []).map((grant: any) => ({
    ...grant,
    user: grant.profiles
  }));
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

  const { data, error } = await supabase
    .from('usage_events')
    .update({ refunded_at: now.toISOString() })
    .eq('user_id', userId)
    .eq('feature', feature)
    .gte('usage_date', since)
    .is('refunded_at', null)
    .select('id');

  if (error) throw new Error(error.message);

  return {
    feature,
    since,
    refunded: (data || []).length
  };
};

/**
 * Number of distinct users who reached an enabled free daily limit today.
 *
 * The database function is authoritative. If it is unavailable the same number
 * is derived from today's usage events and the current quota configuration so
 * the overview card never reports a hardcoded zero.
 */
const countUsersAtLimit = async (since: string): Promise<number> => {
  try {
    const { data: quotas, error: quotaError } = await supabase
      .from('feature_quotas')
      .select('feature, free_daily_limit, is_enabled');

    if (quotaError) return 0;

    const limits = new Map<string, number>();
    (quotas || []).forEach((quota: any) => {
      const limit = Number(quota.free_daily_limit);
      if (quota.is_enabled === true && Number.isFinite(limit) && limit > 0) {
        limits.set(String(quota.feature), limit);
      }
    });

    if (limits.size === 0) return 0;

    const { data: events, error: eventError } = await supabase
      .from('usage_events')
      .select('user_id, feature')
      .gte('usage_date', since)
      .is('refunded_at', null)
      .limit(20000);

    if (eventError) return 0;

    const counts = new Map<string, Map<string, number>>();
    (events || []).forEach((event: any) => {
      const feature = String(event.feature);
      if (!limits.has(feature)) return;
      const userId = String(event.user_id);
      const byUser = counts.get(feature) ?? new Map<string, number>();
      byUser.set(userId, (byUser.get(userId) ?? 0) + 1);
      counts.set(feature, byUser);
    });

    const atLimit = new Set<string>();
    counts.forEach((byUser, feature) => {
      const limit = limits.get(feature) ?? 0;
      byUser.forEach((used, userId) => {
        if (used >= limit) atLimit.add(userId);
      });
    });

    return atLimit.size;
  } catch {
    return 0;
  }
};

export const getOverview = async () => {
  const since = startOfDhakaDayIso();
  const now = new Date().toISOString();

  const [premiumUsers, freeUsers, activeGrants, limitHitToday] = await Promise.all([
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('subscription_status', 'premium'),
    supabase.from('profiles').select('id', { count: 'exact', head: true }).neq('subscription_status', 'premium'),
    supabase
      .from('access_grants')
      .select('id', { count: 'exact', head: true })
      .is('revoked_at', null)
      // A grant without an expiry never expires, so it must not be dropped by
      // an `expires_at >= now` filter.
      .or(`expires_at.is.null,expires_at.gte.${now}`)
      .or(`starts_at.is.null,starts_at.lte.${now}`),
    supabase.rpc('count_users_at_limit_today', { p_date: since })
  ]);

  if (activeGrants.error) throw new Error(activeGrants.error.message);

  let limitHitCount = Number(limitHitToday.count ?? limitHitToday.data ?? 0);

  if (limitHitToday.error) {
    limitHitCount = await countUsersAtLimit(since);
  }

  return {
    premium_users: premiumUsers.count || 0,
    free_users: freeUsers.count || 0,
    active_grants: activeGrants.count || 0,
    users_who_hit_limit_today: limitHitCount,
    day_start: since
  };
};
