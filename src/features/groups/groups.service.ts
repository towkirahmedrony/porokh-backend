import type { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../../config/supabaseAdmin';
import { groupError, mapDataError } from './groups.errors';
import { notifyGroupUsers } from './groups.notifications';
import { buildReplyMeta, containsBlockedContact } from './groups.chat';
import { isUuid, isValidSlug, normalizeReportReason, normalizeSlug } from './groups.validation';

type AnyObject = Record<string, any>;

/**
 * Column allowlists. `join_code` is deliberately absent from every group
 * projection: it is only readable through the owner/admin RPC.
 */
const GROUP_FIELDS =
  'id, slug, name, icon, description, group_type, max_members, visibility, member_count, total_xp, group_level, current_streak, last_activity_date, is_active, created_by, created_at, updated_at';

const SAFE_PROFILE_FIELDS = 'id, full_name, username, avatar_url, institution, total_xp';

const MEMBERSHIP_FIELDS = 'id, group_id, user_id, role, status, contribution_xp, joined_at, banned_until';

const MESSAGE_FIELDS =
  'id, group_id, sender_id, message_type, content, meta_data, created_at, is_flagged, deleted_at';

const DISCOVER_LIMIT = 200;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_MESSAGE_LENGTH = 500;
const MIN_MESSAGE_LENGTH = 1;

const CONFIG_DEFAULTS = {
  group_squad_default_members: 30,
  group_squad_max_members: 50,
  group_community_max_members: 200,
  group_battle_participation_xp: 10,
  group_battle_winner_bonus_xp: 20,
  group_leaderboard_min_members: 3,
} as const;

const toBoundedInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
};

const normalizeId = (value: unknown): string => String(value ?? '').trim();
const normalizeText = (value: unknown): string => String(value ?? '').trim();

export const isSafeProfile = (row: AnyObject | null | undefined): AnyObject | null => {
  if (!row || typeof row !== 'object') return null;
  return {
    id: normalizeId(row.id),
    full_name: row.full_name ?? null,
    username: row.username ?? null,
    avatar_url: row.avatar_url ?? null,
    institution: row.institution ?? null,
    total_xp: typeof row.total_xp === 'number' ? row.total_xp : Number(row.total_xp ?? 0),
  };
};

/** Reads other users' safe profile fields with the service-role client. */
export const loadSafeProfiles = async (
  userIds: Array<string | null | undefined>
): Promise<Map<string, AnyObject>> => {
  const ids = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return new Map();

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select(SAFE_PROFILE_FIELDS)
    .in('id', ids);

  if (error) {
    console.error('[groups:profiles] lookup failed:', error.message);
    return new Map();
  }

  const map = new Map<string, AnyObject>();
  (data || []).forEach((row: AnyObject) => {
    const safe = isSafeProfile(row);
    if (safe) map.set(normalizeId(row.id), safe);
  });
  return map;
};

export const isPlatformAdmin = async (userId: string): Promise<boolean> => {
  if (!userId) return false;
  try {
    const { data, error } = await supabaseAdmin
      .from('user_roles')
      .select('role, is_active')
      .eq('user_id', userId)
      .eq('is_active', true);
    if (error) return false;
    return (data || []).some((row: AnyObject) => row.role === 'admin' || row.role === 'super_admin');
  } catch {
    return false;
  }
};

export const getGroupRow = async (
  client: SupabaseClient,
  identifier: string
): Promise<AnyObject | null> => {
  const value = normalizeId(identifier);
  if (!value) return null;

  let query = client.from('study_groups').select(GROUP_FIELDS);
  query = isUuid(value) ? query.eq('id', value) : query.eq('slug', normalizeSlug(value));

  const { data, error } = await query.maybeSingle();
  if (error) throw mapDataError(error);
  return data ?? null;
};

export const getMembership = async (
  client: SupabaseClient,
  groupId: string,
  userId: string
): Promise<AnyObject | null> => {
  const { data, error } = await client
    .from('group_members')
    .select(MEMBERSHIP_FIELDS)
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') throw mapDataError(error);
  return data ?? null;
};

export const requireActiveMember = async (
  client: SupabaseClient,
  groupId: string,
  userId: string
): Promise<AnyObject> => {
  const membership = await getMembership(client, groupId, userId);
  if (!membership || membership.status !== 'active') {
    throw groupError('NOT_A_MEMBER', 403);
  }
  return membership;
};

export const requireGroupAdmin = async (
  client: SupabaseClient,
  group: AnyObject,
  userId: string
): Promise<AnyObject> => {
  const [membership, platformAdmin] = await Promise.all([
    getMembership(client, normalizeId(group.id), userId),
    isPlatformAdmin(userId),
  ]);

  const isOwner = normalizeId(group.created_by) === userId;
  const isGroupAdmin = membership?.status === 'active' && membership?.role === 'admin';

  if (!isOwner && !isGroupAdmin && !platformAdmin) {
    throw groupError('FORBIDDEN', 403);
  }

  return membership ?? { role: 'admin', status: 'active', group_id: group.id, user_id: userId };
};

/** Reads configs through the service-role client and applies safe defaults. */
export const getGroupsConfig = async () => {
  const keys = Object.keys(CONFIG_DEFAULTS);
  const { data, error } = await supabaseAdmin
    .from('app_configs')
    .select('key, value')
    .in('key', keys);

  if (error) {
    console.error('[groups:config] lookup failed:', error.message);
  }

  const values = new Map<string, unknown>(
    (data || []).map((row: AnyObject) => [String(row.key), row.value])
  );

  const readNumber = (key: keyof typeof CONFIG_DEFAULTS): number => {
    const raw = values.get(key);
    const value =
      raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in (raw as AnyObject)
        ? (raw as AnyObject).value
        : raw;
    return toBoundedInt(value, CONFIG_DEFAULTS[key], 1, 500);
  };

  const squadDefault = readNumber('group_squad_default_members');
  const squadMax = Math.min(50, readNumber('group_squad_max_members'));
  const communityMax = Math.min(200, readNumber('group_community_max_members'));

  return {
    squadDefaultMembers: Math.min(squadDefault, squadMax),
    squadMaxMembers: Math.max(2, squadMax),
    communityMaxMembers: Math.max(2, communityMax),
    battleParticipationXp: readNumber('group_battle_participation_xp'),
    battleWinnerBonusXp: readNumber('group_battle_winner_bonus_xp'),
    leaderboardMinMembers: readNumber('group_leaderboard_min_members'),
  };
};

const mapGroupWriteError = (error: any, slugRequested: boolean): never => {
  if (slugRequested && error?.code === '23505') {
    throw groupError('SLUG_TAKEN', 409);
  }
  throw mapDataError(error);
};

const withMembershipGroup = async (
  client: SupabaseClient,
  memberships: AnyObject[]
): Promise<AnyObject[]> => {
  const groupIds = Array.from(
    new Set(memberships.map((row) => normalizeId(row.group_id)).filter(Boolean))
  );
  if (groupIds.length === 0) return [];

  const { data: groups, error } = await client
    .from('study_groups')
    .select(GROUP_FIELDS)
    .in('id', groupIds);

  if (error) throw mapDataError(error);

  const groupMap = new Map<string, AnyObject>(
    (groups || []).map((group: AnyObject) => [normalizeId(group.id), group])
  );

  return memberships.map((membership) => ({
    ...membership,
    group: groupMap.get(normalizeId(membership.group_id)) ?? null,
  }));
};

export const getMyGroups = async (client: SupabaseClient, userId: string) => {
  const { data, error } = await client
    .from('group_members')
    .select(MEMBERSHIP_FIELDS)
    .eq('user_id', userId)
    .in('status', ['active', 'invited', 'pending'])
    .order('joined_at', { ascending: false });

  if (error) throw mapDataError(error);

  const memberships = await withMembershipGroup(client, data || []);
  const active = memberships.filter((row) => row.status === 'active');
  const pending = memberships.filter((row) => row.status === 'pending' || row.status === 'invited');

  const squad =
    active.find((row) => row.group?.group_type === 'squad' && row.group?.is_active !== false) ?? null;

  const communities = memberships.filter((row) => row.group?.group_type === 'community');

  return {
    squad,
    communities,
    pending,
    memberships,
  };
};

export const discoverGroups = async (
  client: SupabaseClient,
  params: { type?: string; q?: string; page?: number; pageSize?: number }
) => {
  const page = Math.max(1, Math.floor(Number(params.page) || 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(Number(params.pageSize) || DEFAULT_PAGE_SIZE))
  );

  let query = client
    .from('study_groups')
    .select(GROUP_FIELDS)
    .eq('is_active', true)
    .in('visibility', ['public', 'approval'])
    .order('member_count', { ascending: false })
    .limit(DISCOVER_LIMIT);

  if (params.type === 'squad' || params.type === 'community') {
    query = query.eq('group_type', params.type);
  }

  const search = normalizeText(params.q);
  if (search) {
    query = query.ilike('name', `%${search.slice(0, 50)}%`);
  }

  const { data, error } = await query;
  if (error) throw mapDataError(error);

  // "Not full" compares two columns, which PostgREST cannot express directly.
  const openGroups = (data || []).filter(
    (group: AnyObject) => Number(group.member_count ?? 0) < Number(group.max_members ?? 0)
  );

  const start = (page - 1) * pageSize;

  return {
    items: openGroups.slice(start, start + pageSize),
    page,
    pageSize,
    total: openGroups.length,
    hasMore: start + pageSize < openGroups.length,
  };
};

export const createGroup = async (
  client: SupabaseClient,
  userId: string,
  input: {
    name: string;
    icon?: string | null;
    description?: string | null;
    groupType?: 'squad' | 'community';
    maxMembers?: number | null;
    visibility?: 'public' | 'code' | 'approval';
    slug?: string | null;
  }
) => {
  if (input.groupType === 'community' && !(await isPlatformAdmin(userId))) {
    throw groupError('COMMUNITY_ADMIN_ONLY', 403);
  }

  const name = normalizeText(input.name);
  if (name.length < 2 || name.length > 50) throw groupError('INVALID_NAME', 400);

  const description = normalizeText(input.description).slice(0, 300);
  const slug = input.slug === null || input.slug === undefined ? null : normalizeSlug(input.slug);
  if (slug !== null && !isValidSlug(slug)) throw groupError('INVALID_SLUG', 400);
  const config = await getGroupsConfig();
  const cap = input.groupType === 'community' ? config.communityMaxMembers : config.squadMaxMembers;
  const requestedMax =
    input.maxMembers === null || input.maxMembers === undefined
      ? input.groupType === 'community'
        ? cap
        : config.squadDefaultMembers
      : toBoundedInt(input.maxMembers, config.squadDefaultMembers, 2, cap);

  const { data: groupId, error } = await client.rpc('create_study_group', {
    p_name: name,
    p_icon: input.icon ?? null,
    p_description: description || null,
    p_group_type: input.groupType ?? 'squad',
    p_max_members: Math.min(requestedMax, cap),
    p_visibility: input.visibility ?? 'code',
    ...(slug !== null ? { p_slug: slug } : {}),
  });

  if (error) mapGroupWriteError(error, slug !== null);

  const createdId = typeof groupId === 'string' ? groupId : normalizeId(groupId);
  const group = await getGroupRow(client, createdId);

  return {
    id: createdId,
    group,
  };
};

export const joinGroup = async (
  client: SupabaseClient,
  groupId: string,
  joinCode?: string | null
) => {
  const params: AnyObject = { p_group_id: groupId };
  if (joinCode) params.p_join_code = joinCode;

  const { data, error } = await client.rpc('join_group', params);
  if (error) throw mapDataError(error);

  const result = typeof data === 'string' ? data : 'joined';

  if (result === 'pending') {
    const group = await getGroupRow(client, groupId).catch(() => null);
    if (group) {
      await notifyGroupAdmins(group);
    }
  }

  return { result };
};

export const joinGroupByCode = async (client: SupabaseClient, joinCode: string) => {
  const { data, error } = await client.rpc('join_group_by_code', {
    p_join_code: normalizeText(joinCode).toUpperCase(),
  });
  if (error) throw mapDataError(error);

  const result = typeof data === 'string' ? data : 'joined';

  if (result === 'pending') {
    const groupId = normalizeId((data as AnyObject)?.group_id);
    if (groupId) {
      const group = await getGroupRow(client, groupId).catch(() => null);
      if (group) await notifyGroupAdmins(group);
    }
  }

  return { result };
};

const notifyGroupAdmins = async (group: AnyObject): Promise<void> => {
  try {
    const { data } = await supabaseAdmin
      .from('group_members')
      .select('user_id, role, status')
      .eq('group_id', normalizeId(group.id))
      .eq('status', 'active')
      .eq('role', 'admin');

    const adminIds = (data || []).map((row: AnyObject) => row.user_id);
    if (normalizeId(group.created_by)) adminIds.push(group.created_by);

    await notifyGroupUsers(adminIds, {
      type: 'group_join_request',
      titleBn: 'নতুন জয়েন অনুরোধ',
      titleEn: 'New join request',
      bodyBn: `"${group.name}" গ্রুপে নতুন সদস্য যোগদানের অনুরোধ করেছেন।`,
      bodyEn: `Someone requested to join "${group.name}".`,
      actionLink: `/groups/${group.slug ?? group.id}?tab=members`,
    });
  } catch (error) {
    console.error(
      '[groups:notification] join request failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
  }
};

export const leaveGroup = async (client: SupabaseClient, groupId: string) => {
  const { error } = await client.rpc('leave_group', { p_group_id: groupId });
  if (error) throw mapDataError(error);
  return { left: true };
};

export const getGroupDetail = async (
  client: SupabaseClient,
  userId: string,
  identifier: string
) => {
  const group = await getGroupRow(client, identifier);
  if (!group || group.is_active === false) throw groupError('GROUP_NOT_FOUND', 404);

  const groupId = normalizeId(group.id);
  const membership = await getMembership(client, groupId, userId);
  const isActiveMember = membership?.status === 'active';

  let members: AnyObject[] = [];
  if (isActiveMember) {
    const { data, error } = await client
      .from('group_members')
      .select(MEMBERSHIP_FIELDS)
      .eq('group_id', groupId)
      .eq('status', 'active')
      .order('contribution_xp', { ascending: false });

    if (error) throw mapDataError(error);

    const rows = data || [];
    const profileMap = await loadSafeProfiles(rows.map((row: AnyObject) => row.user_id));

    members = rows.map((row: AnyObject) => ({
      ...row,
      profile: profileMap.get(normalizeId(row.user_id)) ?? null,
    }));
  }

  return {
    group,
    myMembership: membership,
    isActiveMember,
    isAdmin:
      isActiveMember && (membership?.role === 'admin' || normalizeId(group.created_by) === userId),
    isOwner: normalizeId(group.created_by) === userId,
    members,
    serverNow: new Date().toISOString(),
  };
};

export const getGroupPreview = async (
  client: SupabaseClient,
  identifier: string
) => {
  const value = normalizeId(identifier);
  if (!value) throw groupError('GROUP_NOT_FOUND', 404);

  const params: AnyObject = isUuid(value)
    ? { p_group_id: value, p_slug: null }
    : { p_slug: normalizeSlug(value), p_group_id: null };

  const { data, error } = await client.rpc('get_group_preview', params);
  if (error) throw mapDataError(error);
  if (!data) throw groupError('GROUP_NOT_FOUND', 404);

  return { preview: data };
};

export const updateGroup = async (
  client: SupabaseClient,
  userId: string,
  groupId: string,
  input: {
    name?: string;
    icon?: string | null;
    description?: string | null;
    visibility?: 'public' | 'code' | 'approval';
    slug?: string;
    maxMembers?: number;
    regenerateJoinCode?: boolean;
    disband?: boolean;
    isActive?: boolean;
  }
) => {
  const group = await getGroupRow(client, groupId);
  if (!group) throw groupError('GROUP_NOT_FOUND', 404);

  await requireGroupAdmin(client, group, userId);

  const resolvedGroupId = normalizeId(group.id);
  const patch: AnyObject = {};

  if (input.slug !== undefined) {
    const slug = normalizeSlug(input.slug);
    if (!isValidSlug(slug)) throw groupError('INVALID_SLUG', 400);
    if (slug !== group.slug) patch.slug = slug;
  }

  if (input.name !== undefined) {
    const name = normalizeText(input.name);
    if (name.length < 2 || name.length > 50) throw groupError('INVALID_NAME', 400);
    patch.name = name;
  }

  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.description !== undefined) patch.description = normalizeText(input.description).slice(0, 300);
  if (input.visibility !== undefined) patch.visibility = input.visibility;

  if (input.maxMembers !== undefined) {
    const config = await getGroupsConfig();
    const cap = group.group_type === 'community' ? config.communityMaxMembers : config.squadMaxMembers;
    const memberCount = Number(group.member_count ?? 0);
    const requested = toBoundedInt(input.maxMembers, Number(group.max_members ?? cap), 2, cap);

    if (requested < memberCount || requested > cap) {
      throw groupError('INVALID_MAX_MEMBERS', 400);
    }
    patch.max_members = requested;
  }

  if (input.disband === true || input.isActive === false) {
    patch.is_active = false;
  } else if (input.isActive === true) {
    patch.is_active = true;
  }

  let updatedGroup = group;

  if (Object.keys(patch).length > 0) {
    const { data, error } = await client
      .from('study_groups')
      .update(patch)
      .eq('id', resolvedGroupId)
      .select(GROUP_FIELDS)
      .maybeSingle();

    if (error) mapGroupWriteError(error, input.slug !== undefined);
    if (!data) throw groupError('FORBIDDEN', 403);
    updatedGroup = data;
  }

  // Authorization is already proven above. The code itself is written with the
  // service-role client because the RLS update policy deliberately omits
  // join_code; the value never leaves the server except through the owner RPC.
  if (input.regenerateJoinCode) {
    const joinCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const { error } = await supabaseAdmin
      .from('study_groups')
      .update({ join_code: joinCode })
      .eq('id', resolvedGroupId);

    if (error) throw mapDataError(error);
  }

  return { group: updatedGroup };
};

export const getJoinCode = async (client: SupabaseClient, groupId: string) => {
  const { data, error } = await client.rpc('get_group_join_code', { p_group_id: groupId });
  if (error) throw mapDataError(error);

  return { joinCode: typeof data === 'string' ? data : '' };
};

export const getJoinRequests = async (
  client: SupabaseClient,
  userId: string,
  groupId: string
) => {
  const group = await getGroupRow(client, groupId);
  if (!group) throw groupError('GROUP_NOT_FOUND', 404);

  await requireGroupAdmin(client, group, userId);

  const { data, error } = await client
    .from('group_members')
    .select(MEMBERSHIP_FIELDS)
    .eq('group_id', groupId)
    .eq('status', 'pending')
    .order('joined_at', { ascending: true });

  if (error) throw mapDataError(error);

  const rows = data || [];
  const profileMap = await loadSafeProfiles(rows.map((row: AnyObject) => row.user_id));

  return {
    requests: rows.map((row: AnyObject) => ({
      ...row,
      profile: profileMap.get(normalizeId(row.user_id)) ?? null,
    })),
  };
};

export const reviewJoinRequest = async (
  client: SupabaseClient,
  userId: string,
  groupId: string,
  targetUserId: string,
  approve: boolean
) => {
  const group = await getGroupRow(client, groupId);
  if (!group) throw groupError('GROUP_NOT_FOUND', 404);

  await requireGroupAdmin(client, group, userId);

  const { data, error } = await client.rpc('review_join_request', {
    p_group_id: groupId,
    p_user_id: targetUserId,
    p_approve: approve,
  });

  if (error) throw mapDataError(error);

  await notifyGroupUsers([targetUserId], {
    type: approve ? 'group_request_approved' : 'group_request_rejected',
    titleBn: approve ? 'অনুরোধ অনুমোদিত' : 'অনুরোধ প্রত্যাখ্যাত',
    titleEn: approve ? 'Request approved' : 'Request rejected',
    bodyBn: approve
      ? `"${group.name}" গ্রুপে আপনার যোগদানের অনুরোধ অনুমোদিত হয়েছে।`
      : `"${group.name}" গ্রুপে আপনার যোগদানের অনুরোধ প্রত্যাখ্যান করা হয়েছে।`,
    bodyEn: approve
      ? `Your request to join "${group.name}" was approved.`
      : `Your request to join "${group.name}" was rejected.`,
    actionLink: `/groups/${group.slug ?? group.id}`,
  });

  return { result: typeof data === 'string' ? data : approve ? 'approved' : 'rejected' };
};

export const kickGroupMember = async (
  client: SupabaseClient,
  userId: string,
  groupId: string,
  targetUserId: string,
  banHours?: number | null
) => {
  const group = await getGroupRow(client, groupId);
  if (!group) throw groupError('GROUP_NOT_FOUND', 404);

  await requireGroupAdmin(client, group, userId);

  const params: AnyObject = { p_group_id: groupId, p_user_id: targetUserId };
  if (banHours !== undefined && banHours !== null) {
    params.p_ban_hours = Math.max(1, Math.floor(banHours));
  }

  const { error } = await client.rpc('kick_group_member', params);
  if (error) throw mapDataError(error);

  await notifyGroupUsers([targetUserId], {
    type: 'group_kicked',
    titleBn: 'গ্রুপ থেকে বের করা হয়েছে',
    titleEn: 'Removed from group',
    bodyBn: `আপনাকে "${group.name}" গ্রুপ থেকে বের করা হয়েছে।`,
    bodyEn: `You were removed from "${group.name}".`,
    actionLink: '/groups',
  });

  return { kicked: true };
};

export const getGroupLeaderboard = async (
  client: SupabaseClient,
  userId: string,
  params: { period: 'weekly' | 'monthly' | 'all_time'; page?: number; pageSize?: number }
) => {
  const page = Math.max(1, Math.floor(Number(params.page) || 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(Number(params.pageSize) || DEFAULT_PAGE_SIZE))
  );

  const { data, error, count } = await client
    .from('group_leaderboard_cache')
    .select('group_id, period_type, rank, previous_rank, total_xp, avg_xp, member_count, last_updated_at', {
      count: 'exact',
    })
    .eq('period_type', params.period)
    .order('rank', { ascending: true })
    .range((page - 1) * pageSize, (page - 1) * pageSize + pageSize - 1);

  if (error) throw mapDataError(error);

  const rows = data || [];
  const groupIds = rows.map((row: AnyObject) => normalizeId(row.group_id));

  let groupMap = new Map<string, AnyObject>();
  if (groupIds.length > 0) {
    const { data: groups, error: groupErrorResult } = await client
      .from('study_groups')
      .select(GROUP_FIELDS)
      .in('id', groupIds);
    if (groupErrorResult) throw mapDataError(groupErrorResult);
    groupMap = new Map(
      (groups || []).map((group: AnyObject) => [normalizeId(group.id), group])
    );
  }

  const { data: myMemberships } = await client
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId)
    .eq('status', 'active');

  const myGroupIds = (myMemberships || [])
    .map((row: AnyObject) => normalizeId(row.group_id))
    .filter(Boolean);

  return {
    period: params.period,
    items: rows.map((row: AnyObject) => ({
      ...row,
      group: groupMap.get(normalizeId(row.group_id)) ?? null,
      is_my_group: myGroupIds.includes(normalizeId(row.group_id)),
    })),
    myGroupIds,
    page,
    pageSize,
    total: typeof count === 'number' ? count : rows.length,
    hasMore: typeof count === 'number' ? page * pageSize < count : rows.length === pageSize,
  };
};

const AUTO_BAN_CACHE_MS = 5 * 60 * 1000;
let autoBanCache: { loadedAt: number; entries: AnyObject[] } | null = null;

const loadAutoBanDictionary = async (): Promise<AnyObject[]> => {
  if (autoBanCache && Date.now() - autoBanCache.loadedAt < AUTO_BAN_CACHE_MS) {
    return autoBanCache.entries;
  }

  const { data, error } = await supabaseAdmin
    .from('auto_ban_dictionary')
    .select('word, match_type, auto_delete');

  if (error) {
    console.error('[groups:moderation] dictionary lookup failed:', error.message);
    return autoBanCache?.entries ?? [];
  }

  autoBanCache = { loadedAt: Date.now(), entries: data || [] };
  return autoBanCache.entries;
};

const findDictionaryMatch = (content: string, entries: AnyObject[]): AnyObject | null => {
  const normalized = content.trim().toLowerCase();

  for (const entry of entries) {
    const word = normalizeText(entry.word).toLowerCase();
    if (!word) continue;

    const matchType = normalizeText(entry.match_type || 'contains').toLowerCase();
    const matched =
      matchType === 'exact' ? normalized === word : normalized.includes(word);

    if (matched) return entry;
  }

  return null;
};

export const listMessages = async (
  client: SupabaseClient,
  userId: string,
  groupId: string,
  params: { before?: string; limit?: number }
) => {
  await requireActiveMember(client, groupId, userId);

  const limit = Math.min(50, Math.max(1, Math.floor(Number(params.limit) || 30)));

  let query = client
    .from('group_chats')
    .select(MESSAGE_FIELDS)
    .eq('group_id', groupId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (params.before) {
    const before = new Date(params.before);
    if (!Number.isNaN(before.getTime())) {
      query = query.lt('created_at', before.toISOString());
    }
  }

  const { data, error } = await query;
  if (error) throw mapDataError(error);

  const ordered = (data || []).slice().reverse();
  const profileMap = await loadSafeProfiles(
    ordered.map((row: AnyObject) => row.sender_id)
  );

  return {
    messages: ordered.map((row: AnyObject) => ({
      ...row,
      sender: profileMap.get(normalizeId(row.sender_id)) ?? null,
    })),
    hasMore: (data || []).length === limit,
    serverNow: new Date().toISOString(),
  };
};

export const createMessage = async (
  client: SupabaseClient,
  userId: string,
  groupId: string,
  input: { content: string; messageType?: string; replyToId?: string | null }
) => {
  await requireActiveMember(client, groupId, userId);

  const content = normalizeText(input.content);
  if (content.length < MIN_MESSAGE_LENGTH || content.length > MAX_MESSAGE_LENGTH) {
    throw groupError('VALIDATION_FAILED', 400);
  }

  const messageType = input.messageType ?? 'text';
  if (!['text', 'emoji', 'question_share'].includes(messageType)) {
    throw groupError('VALIDATION_FAILED', 400);
  }

  // The audience includes minors: links and phone numbers are blocked outright.
  if (containsBlockedContact(content)) {
    throw groupError('MESSAGE_BLOCKED', 400);
  }

  const dictionary = await loadAutoBanDictionary();
  const match = findDictionaryMatch(content, dictionary);
  const autoDelete = Boolean(match?.auto_delete);

  if (match && autoDelete) {
    throw groupError('MESSAGE_BLOCKED', 400);
  }

  let metaData: AnyObject | null = null;
  const replyToId = normalizeId(input.replyToId);
  if (replyToId) {
    if (!isUuid(replyToId)) throw groupError('MESSAGE_NOT_FOUND', 404);

    const { data: replied, error: replyError } = await client
      .from('group_chats')
      .select('id, group_id, sender_id, content, deleted_at')
      .eq('id', replyToId)
      .maybeSingle();

    if (replyError) throw mapDataError(replyError);
    if (!replied || normalizeId(replied.group_id) !== groupId || replied.deleted_at) {
      throw groupError('MESSAGE_NOT_FOUND', 404);
    }

    const replyProfile = (await loadSafeProfiles([replied.sender_id])).get(
      normalizeId(replied.sender_id)
    );
    metaData = {
      reply_to: buildReplyMeta({
        id: normalizeId(replied.id),
        senderName: String(replyProfile?.full_name || replyProfile?.username || 'Student'),
        content: String(replied.content ?? ''),
      }),
    };
  }

  const { data, error } = await client
    .from('group_chats')
    .insert({
      group_id: groupId,
      sender_id: userId,
      message_type: messageType,
      content,
      is_flagged: Boolean(match),
      meta_data: metaData,
    })
    .select(MESSAGE_FIELDS)
    .single();

  if (error) throw mapDataError(error);

  if (match && data) {
    try {
      const { error: flagError } = await supabaseAdmin.from('flagged_messages').insert({
        chat_id: data.id,
        group_id: groupId,
        sender_id: userId,
        offense_type: 'Other',
        flagged_by_system: true,
      });
      if (flagError) {
        console.error('[groups:moderation] flagged_messages insert failed:', flagError.message);
      }
    } catch (flagError) {
      console.error(
        '[groups:moderation] flagged_messages insert threw:',
        flagError instanceof Error ? flagError.message : 'unknown error'
      );
    }
  }

  const profileMap = await loadSafeProfiles([userId]);

  return {
    message: {
      ...data,
      sender: profileMap.get(userId) ?? null,
    },
  };
};

export const deleteMessage = async (
  client: SupabaseClient,
  userId: string,
  messageId: string
) => {
  if (!userId) throw groupError('AUTH_REQUIRED', 401);
  const { error } = await client.rpc('delete_group_message', { p_message_id: messageId });
  if (error) throw mapDataError(error);
  return { deleted: true };
};

export const reportMessage = async (
  client: SupabaseClient,
  userId: string,
  messageId: string,
  offenseType: string,
  reason?: string | null
) => {
  if (!userId) throw groupError('AUTH_REQUIRED', 401);
  const { error } = await client.rpc('report_group_message', {
    p_message_id: messageId,
    p_offense_type: offenseType,
    p_reason: normalizeReportReason(reason) || null,
  });
  if (error) throw mapDataError(error);
  return { reported: true };
};

export const getActiveGroupMemberIds = async (groupId: string): Promise<string[]> => {
  const { data, error } = await supabaseAdmin
    .from('group_members')
    .select('user_id')
    .eq('group_id', groupId)
    .eq('status', 'active');

  if (error) {
    console.error('[groups:members] lookup failed:', error.message);
    return [];
  }

  return (data || []).map((row: AnyObject) => row.user_id).filter(Boolean);
};

export const notifyBattleCreated = async (group: AnyObject, creatorId: string) => {
  const memberIds = await getActiveGroupMemberIds(normalizeId(group.id));
  await notifyGroupUsers(
    memberIds.filter((id) => id !== creatorId),
    {
      type: 'group_battle_created',
      titleBn: 'নতুন গ্রুপ ব্যাটল',
      titleEn: 'New group battle',
      bodyBn: `"${group.name}" গ্রুপে একটি নতুন ব্যাটল শুরু হয়েছে।`,
      bodyEn: `A new battle was created in "${group.name}".`,
      actionLink: `/groups/${group.slug ?? group.id}?tab=battles`,
    }
  );
};

export const notifyBattleFinished = async (
  groupId: string,
  groupName: string,
  winnerId: string | null
) => {
  const memberIds = await getActiveGroupMemberIds(groupId);
  let winnerName = '';

  if (winnerId) {
    const profileMap = await loadSafeProfiles([winnerId]);
    const winner = profileMap.get(winnerId);
    winnerName = normalizeText(winner?.full_name || winner?.username);
  }

  await notifyGroupUsers(memberIds, {
    type: 'group_battle_finished',
    titleBn: 'ব্যাটল শেষ হয়েছে',
    titleEn: 'Battle finished',
    bodyBn: winnerName
      ? `"${groupName}" গ্রুপের ব্যাটলে ${winnerName} জয়ী হয়েছে।`
      : `"${groupName}" গ্রুপের ব্যাটল শেষ হয়েছে।`,
    bodyEn: winnerName
      ? `${winnerName} won the battle in "${groupName}".`
      : `The battle in "${groupName}" has finished.`,
    actionLink: `/groups/${groupId}?tab=battles`,
  });
};

