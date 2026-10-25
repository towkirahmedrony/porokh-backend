import crypto from 'crypto';
import { supabaseAdmin } from '../../config/supabaseAdmin';
import { groupError, mapDataError } from './groups.errors';
import { getGroupsConfig } from './groups.service';

type AnyObject = Record<string, any>;

/**
 * Administrative group management.
 *
 * Every query here runs with the service-role client, which is why the router
 * must prove an active admin role before any controller is reached. Projections
 * are allow-listed so a future column (for example a private join code) is not
 * exposed by accident.
 */
const GROUP_ADMIN_FIELDS =
  'id, slug, name, icon, description, group_type, max_members, visibility, member_count, total_xp, group_level, current_streak, last_activity_date, is_active, created_by, created_at, updated_at';

const GROUP_DETAIL_FIELDS = `${GROUP_ADMIN_FIELDS}, join_code`;

const USER_FIELDS =
  'id, full_name, username, email, avatar_url, institution, total_xp, account_status, current_group_id';

const MEMBER_FIELDS =
  'id, group_id, user_id, role, status, contribution_xp, joined_at, banned_until';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_NAME_LENGTH = 50;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_ICON_LENGTH = 16;
const MAX_JOIN_CODE_LENGTH = 16;
const ADMIN_GROUP_CAP = 500;

const GROUP_SORTS = [
  'created_at',
  'updated_at',
  'name',
  'member_count',
  'total_xp',
  'group_level',
] as const;

export type GroupSort = (typeof GROUP_SORTS)[number];

export type GroupStatusFilter = 'active' | 'inactive' | 'all';

const normalizeId = (value: unknown): string => String(value ?? '').trim();
const normalizeText = (value: unknown): string => String(value ?? '').trim();

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): boolean =>
  typeof value === 'string' && UUID_PATTERN.test(value);

/**
 * PostgREST embeds search terms inside an `or=(...)` expression, so commas and
 * parentheses are structural characters, not data. Strip them instead of
 * trying to escape a syntax we do not control.
 */
export const sanitizeSearchTerm = (value: unknown, maxLength = 50): string =>
  normalizeText(value)
    .slice(0, maxLength)
    .replace(/[,()\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const toBoundedInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
};

const clampPositiveInt = (value: unknown, fallback: number, max: number): number =>
  toBoundedInt(value, fallback, 1, max);

const safeProfile = (row: AnyObject | null | undefined): AnyObject | null => {
  if (!row || typeof row !== 'object') return null;
  return {
    id: normalizeId(row.id),
    full_name: row.full_name ?? null,
    username: row.username ?? null,
    email: row.email ?? null,
    avatar_url: row.avatar_url ?? null,
    institution: row.institution ?? null,
    total_xp: Number(row.total_xp ?? 0),
    account_status: row.account_status ?? null,
    current_group_id: row.current_group_id ?? null,
  };
};

const loadProfiles = async (userIds: Array<string | null | undefined>): Promise<Map<string, AnyObject>> => {
  const ids = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return new Map();

  const { data, error } = await supabaseAdmin.from('profiles').select(USER_FIELDS).in('id', ids);
  if (error) throw mapDataError(error);

  const map = new Map<string, AnyObject>();
  (data || []).forEach((row: AnyObject) => {
    const safe = safeProfile(row);
    if (safe) map.set(normalizeId(row.id), safe);
  });
  return map;
};

const getGroupOrThrow = async (groupId: string): Promise<AnyObject> => {
  const { data, error } = await supabaseAdmin
    .from('study_groups')
    .select(GROUP_DETAIL_FIELDS)
    .eq('id', groupId)
    .maybeSingle();

  if (error) throw mapDataError(error);
  if (!data) throw groupError('GROUP_NOT_FOUND', 404);
  return data;
};

const getMembership = async (
  groupId: string,
  userId: string
): Promise<AnyObject | null> => {
  const { data, error } = await supabaseAdmin
    .from('group_members')
    .select(MEMBER_FIELDS)
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') throw mapDataError(error);
  return data ?? null;
};

const getProfileOrThrow = async (userId: string): Promise<AnyObject> => {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select(USER_FIELDS)
    .eq('id', userId)
    .maybeSingle();

  if (error) throw mapDataError(error);
  if (!data || data.account_status !== 'active') throw groupError('USER_NOT_FOUND', 404);
  return data;
};

const countActiveMembers = async (groupId: string): Promise<number> => {
  const { count, error } = await supabaseAdmin
    .from('group_members')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', groupId)
    .eq('status', 'active');

  if (error) throw mapDataError(error);
  return count ?? 0;
};

const syncMemberCount = async (groupId: string): Promise<number> => {
  const activeMembers = await countActiveMembers(groupId);
  const { error } = await supabaseAdmin
    .from('study_groups')
    .update({ member_count: activeMembers })
    .eq('id', groupId);

  if (error) throw mapDataError(error);
  return activeMembers;
};

const hasOtherActiveSquad = async (userId: string, groupId: string): Promise<boolean> => {
  const { data, error } = await supabaseAdmin
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .neq('group_id', groupId);

  if (error) throw mapDataError(error);

  const groupIds = (data || []).map((row: AnyObject) => normalizeId(row.group_id)).filter(Boolean);
  if (groupIds.length === 0) return false;

  const { data: groups, error: groupErrorResult } = await supabaseAdmin
    .from('study_groups')
    .select('id, group_type')
    .in('id', groupIds);

  if (groupErrorResult) throw mapDataError(groupErrorResult);

  return (groups || []).some((group: AnyObject) => group.group_type === 'squad');
};

const writeAudit = async (
  actorId: string,
  action: string,
  targetId: string,
  details: Record<string, unknown> = {}
): Promise<void> => {
  try {
    const { error } = await supabaseAdmin.from('audit_logs').insert({
      user_id: actorId,
      action,
      target_table: 'study_groups',
      target_id: targetId,
      details,
    });
    if (error) {
      console.error('[groups:admin] audit insert failed:', error.message);
    }
  } catch (error) {
    console.error(
      '[groups:admin] audit insert threw:',
      error instanceof Error ? error.message : 'unknown error'
    );
  }
};

const sanitizeJoinCode = (value: unknown): string =>
  normalizeText(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, MAX_JOIN_CODE_LENGTH);

const generateJoinCode = (): string => crypto.randomBytes(4).toString('hex').toUpperCase();

const resolveMaxMembersInput = (
  groupType: 'squad' | 'community',
  requested: unknown,
  defaultMembers: number,
  cap: number
): number => {
  if (requested === null || requested === undefined) {
    return Math.min(defaultMembers, cap);
  }
  return toBoundedInt(requested, defaultMembers, 2, cap);
};

export const getAdminGroupStats = async () => {
  const count = async (
    table: string,
    configure?: (query: any) => any
  ): Promise<number> => {
    let query = supabaseAdmin.from(table).select('id', { count: 'exact', head: true });
    if (configure) query = configure(query);
    const { count: result, error } = await query;
    if (error) throw mapDataError(error);
    return result ?? 0;
  };

  const [
    total,
    active,
    inactive,
    squads,
    communities,
    activeMembers,
    pendingRequests,
    ongoingBattles,
    battlesThisWeek,
    pendingReports,
  ] = await Promise.all([
    count('study_groups'),
    count('study_groups', (query) => query.eq('is_active', true)),
    count('study_groups', (query) => query.eq('is_active', false)),
    count('study_groups', (query) => query.eq('group_type', 'squad')),
    count('study_groups', (query) => query.eq('group_type', 'community')),
    count('group_members', (query) => query.eq('status', 'active')),
    count('group_members', (query) => query.eq('status', 'pending')),
    count('group_battles', (query) => query.eq('status', 'ongoing')),
    count('group_battles', (query) =>
      query.gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    ),
    count('flagged_messages', (query) => query.eq('status', 'pending')),
  ]);

  return {
    total,
    active,
    inactive,
    squads,
    communities,
    activeMembers,
    pendingRequests,
    ongoingBattles,
    battlesThisWeek,
    pendingReports,
  };
};

export const listAdminGroups = async (params: {
  page?: number;
  pageSize?: number;
  q?: string;
  type?: 'squad' | 'community';
  status?: GroupStatusFilter;
  visibility?: 'public' | 'code' | 'approval';
  sort?: GroupSort;
  direction?: 'asc' | 'desc';
}) => {
  const page = clampPositiveInt(params.page, 1, 100000);
  const pageSize = clampPositiveInt(params.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const status = params.status ?? 'all';
  const sort: GroupSort = GROUP_SORTS.includes(params.sort as GroupSort)
    ? (params.sort as GroupSort)
    : 'created_at';
  const direction = params.direction === 'asc' ? 'asc' : 'desc';

  let query = supabaseAdmin.from('study_groups').select(GROUP_ADMIN_FIELDS, { count: 'exact' });

  if (params.type === 'squad' || params.type === 'community') {
    query = query.eq('group_type', params.type);
  }
  if (status === 'active' || status === 'inactive') {
    query = query.eq('is_active', status === 'active');
  }
  if (params.visibility) {
    query = query.eq('visibility', params.visibility);
  }

  const term = sanitizeSearchTerm(params.q);
  if (term) {
    if (isUuid(term)) {
      query = query.eq('id', term);
    } else {
      const code = sanitizeJoinCode(term);
      const filters = [
        `name.ilike.%${term}%`,
        `slug.ilike.%${term}%`,
        `description.ilike.%${term}%`,
      ];
      if (code) filters.push(`join_code.eq.${code}`);
      query = query.or(filters.join(','));
    }
  }

  const start = (page - 1) * pageSize;
  const [{ data, error, count }, stats] = await Promise.all([
    query
      .order(sort, { ascending: direction === 'asc' })
      .range(start, start + pageSize - 1),
    getAdminGroupStats(),
  ]);

  if (error) throw mapDataError(error);

  const rows = (data || []) as AnyObject[];
  const profileMap = await loadProfiles(rows.map((row) => row.created_by));

  const items = rows.map((row) => ({
    ...row,
    owner: profileMap.get(normalizeId(row.created_by)) ?? null,
  }));
  const total = typeof count === 'number' ? count : items.length;

  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    hasMore: start + items.length < total,
    stats,
  };
};

export const getAdminGroupDetail = async (groupId: string) => {
  const group = await getGroupOrThrow(groupId);

  const count = async (table: string, configure: (query: any) => any): Promise<number> => {
    let query = supabaseAdmin.from(table).select('id', { count: 'exact', head: true });
    query = configure(query);
    const { count: result, error } = await query;
    if (error) throw mapDataError(error);
    return result ?? 0;
  };

  const [
    ownerMap,
    activeMembers,
    pendingRequests,
    totalBattles,
    ongoingBattles,
    messages,
    recentBattlesResult,
  ] = await Promise.all([
    loadProfiles([group.created_by]),
    countActiveMembers(groupId),
    count('group_members', (query) => query.eq('group_id', groupId).eq('status', 'pending')),
    count('group_battles', (query) => query.eq('group_id', groupId)),
    count('group_battles', (query) => query.eq('group_id', groupId).eq('status', 'ongoing')),
    count('group_chats', (query) => query.eq('group_id', groupId)),
    supabaseAdmin
      .from('group_battles')
      .select('id, status, created_at, start_time, end_time, winner_id')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(5),
  ]);

  if (recentBattlesResult.error) throw mapDataError(recentBattlesResult.error);

  return {
    group,
    owner: ownerMap.get(normalizeId(group.created_by)) ?? null,
    stats: {
      activeMembers,
      pendingRequests,
      totalBattles,
      ongoingBattles,
      messages,
    },
    recentBattles: recentBattlesResult.data || [],
  };
};

export const listAdminGroupMembers = async (
  groupId: string,
  params: {
    page?: number;
    pageSize?: number;
    q?: string;
    status?: 'active' | 'pending' | 'invited' | 'left' | 'kicked';
    role?: 'admin' | 'member';
  }
) => {
  await getGroupOrThrow(groupId);

  const page = clampPositiveInt(params.page, 1, 100000);
  const pageSize = clampPositiveInt(params.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const start = (page - 1) * pageSize;
  const term = sanitizeSearchTerm(params.q);

  let userIds: string[] | null = null;
  if (term) {
    const { data: profiles, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .or(`full_name.ilike.%${term}%,username.ilike.%${term}%,email.ilike.%${term}%`)
      .limit(100);

    if (profileError) throw mapDataError(profileError);
    userIds = (profiles || []).map((row: AnyObject) => normalizeId(row.id)).filter(Boolean);
    if (userIds.length === 0) {
      return {
        items: [],
        page,
        pageSize,
        total: 0,
        totalPages: 1,
        hasMore: false,
      };
    }
  }

  let query = supabaseAdmin
    .from('group_members')
    .select(MEMBER_FIELDS, { count: 'exact' })
    .eq('group_id', groupId);

  if (params.status) query = query.eq('status', params.status);
  if (params.role) query = query.eq('role', params.role);
  if (userIds) query = query.in('user_id', userIds);

  const { data, error, count } = await query
    .order('joined_at', { ascending: false })
    .range(start, start + pageSize - 1);

  if (error) throw mapDataError(error);

  const rows = (data || []) as AnyObject[];
  const profileMap = await loadProfiles(rows.map((row) => row.user_id));
  const items = rows.map((row) => ({
    ...row,
    profile: profileMap.get(normalizeId(row.user_id)) ?? null,
  }));
  const total = typeof count === 'number' ? count : items.length;

  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    hasMore: start + items.length < total,
  };
};

export const searchGroupUsers = async (q: string, groupId?: string) => {
  const term = sanitizeSearchTerm(q);
  if (term.length < 2) return { items: [] };

  if (groupId) await getGroupOrThrow(groupId);

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select(USER_FIELDS)
    .or(`full_name.ilike.%${term}%,username.ilike.%${term}%,email.ilike.%${term}%`)
    .eq('account_status', 'active')
    .order('full_name', { ascending: true })
    .limit(20);

  if (error) throw mapDataError(error);

  let users = ((data || []) as AnyObject[]).map(safeProfile).filter(Boolean) as AnyObject[];

  if (groupId && users.length > 0) {
    const ids = users.map((user) => normalizeId(user.id));
    const { data: memberships, error: membershipError } = await supabaseAdmin
      .from('group_members')
      .select('user_id')
      .eq('group_id', groupId)
      .in('user_id', ids)
      .in('status', ['active', 'pending', 'invited']);

    if (membershipError) throw mapDataError(membershipError);

    const existing = new Set(
      (memberships || []).map((row: AnyObject) => normalizeId(row.user_id))
    );
    users = users.filter((user) => !existing.has(normalizeId(user.id)));
  }

  return { items: users };
};

export const createAdminGroup = async (
  actorId: string,
  input: {
    name: string;
    icon?: string | null;
    description?: string | null;
    groupType?: 'squad' | 'community';
    maxMembers?: number;
    visibility?: 'public' | 'code' | 'approval';
    slug?: string | null;
  }
) => {
  const name = normalizeText(input.name);
  if (name.length < 2 || name.length > MAX_NAME_LENGTH) throw groupError('INVALID_NAME', 400);

  const groupType = input.groupType === 'community' ? 'community' : 'squad';
  const config = await getGroupsConfig();
  const defaultMax =
    groupType === 'community' ? config.communityMaxMembers : config.squadDefaultMembers;
  const cap = ADMIN_GROUP_CAP;
  const maxMembers = resolveMaxMembersInput(groupType, input.maxMembers, defaultMax, cap);

  const description =
    normalizeText(input.description).slice(0, MAX_DESCRIPTION_LENGTH) || null;
  const icon = normalizeText(input.icon).slice(0, MAX_ICON_LENGTH) || null;
  const joinCode = generateJoinCode();

  const { data: created, error } = await supabaseAdmin
    .from('study_groups')
    .insert({
      name,
      icon,
      description,
      group_type: groupType,
      max_members: maxMembers,
      visibility: input.visibility ?? 'code',
      ...(input.slug ? { slug: normalizeText(input.slug).toLowerCase() } : {}),
      created_by: actorId,
      join_code: joinCode,
      is_active: true,
    })
    .select(GROUP_DETAIL_FIELDS)
    .single();

  if (error) throw mapDataError(error);

  const groupId = normalizeId(created.id);
  const { error: membershipError } = await supabaseAdmin.from('group_members').insert({
    group_id: groupId,
    user_id: actorId,
    role: 'admin',
    status: 'active',
    contribution_xp: 0,
    joined_at: new Date().toISOString(),
  });

  if (membershipError) {
    // Compensate so a failed owner membership never leaves an orphan group.
    await supabaseAdmin.from('study_groups').delete().eq('id', groupId);
    throw mapDataError(membershipError);
  }

  await syncMemberCount(groupId);
  if (groupType === 'squad') {
    await supabaseAdmin
      .from('profiles')
      .update({ current_group_id: groupId })
      .eq('id', actorId);
  }

  await writeAudit(actorId, 'group.create', groupId, { groupType, maxMembers });

  return { group: await getGroupOrThrow(groupId) };
};

export const updateAdminGroup = async (
  actorId: string,
  groupId: string,
  input: {
    name?: string;
    icon?: string | null;
    description?: string | null;
    visibility?: 'public' | 'code' | 'approval';
    slug?: string;
    maxMembers?: number;
    isActive?: boolean;
    regenerateJoinCode?: boolean;
  }
) => {
  const group = await getGroupOrThrow(groupId);
  const patch: AnyObject = {};

  if (input.name !== undefined) {
    const name = normalizeText(input.name);
    if (name.length < 2 || name.length > MAX_NAME_LENGTH) throw groupError('INVALID_NAME', 400);
    patch.name = name;
  }

  if (input.icon !== undefined) {
    patch.icon = normalizeText(input.icon).slice(0, MAX_ICON_LENGTH) || null;
  }
  if (input.description !== undefined) {
    patch.description = normalizeText(input.description).slice(0, MAX_DESCRIPTION_LENGTH) || null;
  }
  if (input.visibility !== undefined) patch.visibility = input.visibility;
  if (input.slug !== undefined) patch.slug = normalizeText(input.slug).toLowerCase();
  if (input.isActive !== undefined) patch.is_active = input.isActive;

  if (input.maxMembers !== undefined) {
    const cap = ADMIN_GROUP_CAP;
    const activeMembers = await countActiveMembers(groupId);
    const requested = toBoundedInt(input.maxMembers, Number(group.max_members ?? cap), 2, cap);

    if (requested < activeMembers) throw groupError('INVALID_MAX_MEMBERS', 400);
    patch.max_members = requested;
  }

  if (input.regenerateJoinCode) patch.join_code = generateJoinCode();

  if (Object.keys(patch).length > 0) {
    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('study_groups')
      .update(patch)
      .eq('id', groupId)
      .select(GROUP_DETAIL_FIELDS)
      .maybeSingle();

    if (error) throw mapDataError(error);
    if (!data) throw groupError('GROUP_NOT_FOUND', 404);

    await writeAudit(actorId, 'group.update', groupId, {
      fields: Object.keys(patch).filter((key) => key !== 'updated_at'),
      isActive: patch.is_active,
    });

    return { group: data };
  }

  return { group };
};

export const setAdminGroupStatus = async (
  actorId: string,
  groupId: string,
  isActive: boolean
) => {
  const { group } = await updateAdminGroup(actorId, groupId, { isActive });
  await writeAudit(actorId, isActive ? 'group.activate' : 'group.archive', groupId, {
    isActive,
  });
  return { group };
};

export const addAdminGroupMember = async (
  actorId: string,
  groupId: string,
  input: { userId: string; role?: 'admin' | 'member' }
) => {
  const group = await getGroupOrThrow(groupId);
  if (group.is_active === false) throw groupError('GROUP_INACTIVE', 400);

  const userId = normalizeId(input.userId);
  const profile = await getProfileOrThrow(userId);
  const existing = await getMembership(groupId, userId);

  if (existing && existing.status === 'active') throw groupError('ALREADY_MEMBER', 409);

  if (group.group_type === 'squad') {
    const conflict = await hasOtherActiveSquad(userId, groupId);
    if (conflict) throw groupError('ALREADY_IN_SQUAD', 409);
  }

  const activeMembers = await countActiveMembers(groupId);
  const maxMembers = Number(group.max_members ?? 0);
  if (maxMembers > 0 && activeMembers >= maxMembers) throw groupError('GROUP_FULL', 409);

  const role = input.role === 'admin' ? 'admin' : 'member';
  const now = new Date().toISOString();

  let memberId: string;
  let previous: AnyObject | null = null;

  if (existing) {
    previous = { ...existing };
    const { data, error } = await supabaseAdmin
      .from('group_members')
      .update({
        role,
        status: 'active',
        joined_at: now,
        banned_until: null,
      })
      .eq('id', existing.id)
      .select(MEMBER_FIELDS)
      .single();

    if (error) throw mapDataError(error);
    memberId = normalizeId(data.id);
  } else {
    const { data, error } = await supabaseAdmin
      .from('group_members')
      .insert({
        group_id: groupId,
        user_id: userId,
        role,
        status: 'active',
        contribution_xp: 0,
        joined_at: now,
      })
      .select(MEMBER_FIELDS)
      .single();

    if (error) {
      if (error.code === '23505') throw groupError('ALREADY_MEMBER', 409);
      throw mapDataError(error);
    }
    memberId = normalizeId(data.id);
  }

  const newCount = await syncMemberCount(groupId);

  if (maxMembers > 0 && newCount > maxMembers) {
    // A concurrent request filled the last slot. Revert this membership so the
    // hard limit is never exceeded.
    if (previous) {
      await supabaseAdmin
        .from('group_members')
        .update({
          role: previous.role,
          status: previous.status,
          joined_at: previous.joined_at,
          banned_until: previous.banned_until,
        })
        .eq('id', previous.id);
    } else {
      await supabaseAdmin.from('group_members').delete().eq('id', memberId);
    }
    await syncMemberCount(groupId);
    throw groupError('GROUP_FULL', 409);
  }

  if (group.group_type === 'squad') {
    await supabaseAdmin
      .from('profiles')
      .update({ current_group_id: groupId })
      .eq('id', userId);
  }

  await writeAudit(actorId, 'group.member.add', groupId, { userId, role });

  return {
    member: {
      id: memberId,
      group_id: groupId,
      user_id: userId,
      role,
      status: 'active',
      profile: safeProfile(profile),
    },
  };
};

export const removeAdminGroupMember = async (
  actorId: string,
  groupId: string,
  userId: string
) => {
  const group = await getGroupOrThrow(groupId);
  const membership = await getMembership(groupId, userId);
  if (!membership) throw groupError('MEMBER_NOT_FOUND', 404);
  if (normalizeId(group.created_by) === normalizeId(userId)) {
    throw groupError('CANNOT_REMOVE_OWNER', 409);
  }

  const { error } = await supabaseAdmin
    .from('group_members')
    .update({ status: 'left', banned_until: null, role: 'member' })
    .eq('id', membership.id);

  if (error) throw mapDataError(error);

  await syncMemberCount(groupId);

  if (group.group_type === 'squad') {
    await supabaseAdmin
      .from('profiles')
      .update({ current_group_id: null })
      .eq('id', userId)
      .eq('current_group_id', groupId);
  }

  await writeAudit(actorId, 'group.member.remove', groupId, { userId });

  return { removed: true };
};

export const setAdminGroupMemberRole = async (
  actorId: string,
  groupId: string,
  userId: string,
  role: 'admin' | 'member'
) => {
  const group = await getGroupOrThrow(groupId);
  const membership = await getMembership(groupId, userId);
  if (!membership || membership.status !== 'active') {
    throw groupError('MEMBER_NOT_ACTIVE', 409);
  }
  if (normalizeId(group.created_by) === normalizeId(userId)) {
    throw groupError('OWNER_ROLE_FIXED', 409);
  }

  const { data, error } = await supabaseAdmin
    .from('group_members')
    .update({ role })
    .eq('id', membership.id)
    .select(MEMBER_FIELDS)
    .single();

  if (error) throw mapDataError(error);

  await writeAudit(actorId, 'group.member.role', groupId, { userId, role });

  return { member: data };
};

export const transferAdminGroupOwnership = async (
  actorId: string,
  groupId: string,
  userId: string
) => {
  const group = await getGroupOrThrow(groupId);
  const target = await getMembership(groupId, userId);
  if (!target || target.status !== 'active') throw groupError('OWNER_NOT_MEMBER', 409);

  if (normalizeId(group.created_by) === normalizeId(userId)) {
    return { group, transferred: false };
  }

  const previousOwnerId = normalizeId(group.created_by);
  const now = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('study_groups')
    .update({ created_by: userId, updated_at: now })
    .eq('id', groupId)
    .select(GROUP_DETAIL_FIELDS)
    .maybeSingle();

  if (error) throw mapDataError(error);
  if (!data) throw groupError('GROUP_NOT_FOUND', 404);

  const { error: targetError } = await supabaseAdmin
    .from('group_members')
    .update({ role: 'admin' })
    .eq('id', target.id);

  if (targetError) throw mapDataError(targetError);

  if (previousOwnerId && previousOwnerId !== userId) {
    const previousOwner = await getMembership(groupId, previousOwnerId);
    if (previousOwner) {
      const { error: demoteError } = await supabaseAdmin
        .from('group_members')
        .update({ role: 'member' })
        .eq('id', previousOwner.id);
      if (demoteError) throw mapDataError(demoteError);
    }
  }

  await writeAudit(actorId, 'group.owner.transfer', groupId, {
    from: previousOwnerId || null,
    to: userId,
  });

  return { group: data, transferred: true };
};

const FLAG_FIELDS =
  'id, chat_id, group_id, sender_id, offense_type, flagged_by_system, status, action_taken, created_at, resolved_by, reported_by, reason';

const MODERATION_PAGE_SIZE = 20;
const MODERATION_MAX_PAGE_SIZE = 50;

type FlagContext = {
  flag: AnyObject;
  message: AnyObject;
  group: AnyObject;
};

const getFlagContext = async (flagId: string): Promise<FlagContext> => {
  const { data: flag, error } = await supabaseAdmin
    .from('flagged_messages')
    .select(FLAG_FIELDS)
    .eq('id', flagId)
    .maybeSingle();

  if (error) throw mapDataError(error);
  if (!flag) throw groupError('MESSAGE_NOT_FOUND', 404);

  const [{ data: message, error: messageError }, { data: group, error: groupErrorResult }] =
    await Promise.all([
      supabaseAdmin
        .from('group_chats')
        .select('id, group_id, sender_id, message_type, content, created_at, deleted_at, is_flagged')
        .eq('id', flag.chat_id)
        .maybeSingle(),
      supabaseAdmin
        .from('study_groups')
        .select('id, slug, name, created_by, group_type')
        .eq('id', flag.group_id)
        .maybeSingle(),
    ]);

  if (messageError) throw mapDataError(messageError);
  if (groupErrorResult) throw mapDataError(groupErrorResult);
  if (!message || !group) throw groupError('MESSAGE_NOT_FOUND', 404);

  return { flag, message, group };
};

export const listModerationQueue = async (params: {
  status?: 'pending' | 'reviewed' | 'ignored' | 'all';
  page?: number;
  pageSize?: number;
}) => {
  const page = clampPositiveInt(params.page, 1, 100000);
  const pageSize = clampPositiveInt(
    params.pageSize,
    MODERATION_PAGE_SIZE,
    MODERATION_MAX_PAGE_SIZE
  );
  const status = params.status ?? 'pending';
  const start = (page - 1) * pageSize;

  let query = supabaseAdmin
    .from('flagged_messages')
    .select(FLAG_FIELDS, { count: 'exact' });

  if (status !== 'all') query = query.eq('status', status);

  const { data, error, count } = await query
    .order('created_at', { ascending: true })
    .range(start, start + pageSize - 1);

  if (error) throw mapDataError(error);

  const rows = (data || []) as AnyObject[];
  const chatIds = rows.map((row) => normalizeId(row.chat_id)).filter(Boolean);
  const groupIds = Array.from(new Set(rows.map((row) => normalizeId(row.group_id)).filter(Boolean)));
  const userIds = rows.flatMap((row) => [row.sender_id, row.reported_by]);

  const [chatsResult, groupsResult, profileMap] = await Promise.all([
    chatIds.length
      ? supabaseAdmin
          .from('group_chats')
          .select('id, content, message_type, created_at, deleted_at, sender_id, group_id')
          .in('id', chatIds)
      : Promise.resolve({ data: [], error: null } as AnyObject),
    groupIds.length
      ? supabaseAdmin
          .from('study_groups')
          .select('id, slug, name, group_type')
          .in('id', groupIds)
      : Promise.resolve({ data: [], error: null } as AnyObject),
    loadProfiles(userIds),
  ]);

  if (chatsResult.error) throw mapDataError(chatsResult.error);
  if (groupsResult.error) throw mapDataError(groupsResult.error);

  const chatMap = new Map<string, AnyObject>(
    ((chatsResult.data || []) as AnyObject[]).map((row) => [normalizeId(row.id), row])
  );
  const groupMap = new Map<string, AnyObject>(
    ((groupsResult.data || []) as AnyObject[]).map((row) => [normalizeId(row.id), row])
  );

  const items = rows.map((row) => ({
    ...row,
    chat: chatMap.get(normalizeId(row.chat_id)) ?? null,
    group: groupMap.get(normalizeId(row.group_id)) ?? null,
    sender: profileMap.get(normalizeId(row.sender_id)) ?? null,
    reporter: profileMap.get(normalizeId(row.reported_by)) ?? null,
    resolver: profileMap.get(normalizeId(row.resolved_by)) ?? null,
  }));

  const total = typeof count === 'number' ? count : items.length;
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    hasMore: start + items.length < total,
    pendingCount:
      status === 'pending'
        ? total
        : await supabaseAdmin
            .from('flagged_messages')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'pending')
            .then((result) => result.count ?? 0),
  };
};

export const ignoreFlaggedMessage = async (actorId: string, flagId: string) => {
  const { flag } = await getFlagContext(flagId);
  if (flag.status !== 'pending') throw groupError('VALIDATION_FAILED', 409);

  const { error } = await supabaseAdmin
    .from('flagged_messages')
    .update({ status: 'ignored', resolved_by: actorId })
    .eq('id', flagId);

  if (error) throw mapDataError(error);
  await writeAudit(actorId, 'group.moderation.ignore', normalizeId(flag.group_id), {
    flagId,
  });
  return { ignored: true };
};

export const warnFlaggedMessage = async (
  actorId: string,
  flagId: string,
  reason?: string | null
) => {
  const { flag, message } = await getFlagContext(flagId);
  if (flag.status !== 'pending') throw groupError('VALIDATION_FAILED', 409);

  const warningReason =
    normalizeText(reason).slice(0, 300) ||
    `Community guideline violation (${normalizeText(flag.offense_type) || 'Other'})`;

  const { error: warningError } = await supabaseAdmin.from('user_warnings').insert({
    user_id: message.sender_id,
    issued_by: actorId,
    warning_reason: warningReason,
    strike_weight: 1,
    target_chat_id: message.id,
  });
  if (warningError) throw mapDataError(warningError);

  const { error } = await supabaseAdmin
    .from('flagged_messages')
    .update({ status: 'reviewed', action_taken: 'warned', resolved_by: actorId })
    .eq('id', flagId);
  if (error) throw mapDataError(error);

  await writeAudit(actorId, 'group.moderation.warn', normalizeId(flag.group_id), {
    flagId,
    userId: normalizeId(message.sender_id),
  });
  return { warned: true };
};

export const deleteFlaggedMessage = async (actorId: string, flagId: string) => {
  const { flag, message } = await getFlagContext(flagId);
  if (flag.status !== 'pending') throw groupError('VALIDATION_FAILED', 409);

  if (!message.deleted_at) {
    const { error } = await supabaseAdmin
      .from('group_chats')
      .update({ deleted_at: new Date().toISOString(), deleted_by: actorId })
      .eq('id', message.id);
    if (error) throw mapDataError(error);
  }

  const { error } = await supabaseAdmin
    .from('flagged_messages')
    .update({ status: 'reviewed', action_taken: 'deleted', resolved_by: actorId })
    .eq('id', flagId);
  if (error) throw mapDataError(error);

  await writeAudit(actorId, 'group.moderation.delete', normalizeId(flag.group_id), {
    flagId,
    messageId: normalizeId(message.id),
  });
  return { deleted: true };
};

const banGroupSender = async (
  actorId: string,
  group: AnyObject,
  userId: string,
  banHours: number,
  reason: string
): Promise<{ bannedUntil: string }> => {
  if (normalizeId(group.created_by) === userId) {
    throw groupError('CANNOT_REMOVE_OWNER', 409);
  }

  const membership = await getMembership(normalizeId(group.id), userId);
  if (!membership || (membership.status !== 'active' && membership.status !== 'pending')) {
    throw groupError('MEMBER_NOT_FOUND', 404);
  }

  const bannedUntil = new Date(Date.now() + banHours * 60 * 60 * 1000).toISOString();
  const { error } = await supabaseAdmin
    .from('group_members')
    .update({
      status: 'kicked',
      banned_until: bannedUntil,
      role: 'member',
    })
    .eq('id', membership.id);
  if (error) throw mapDataError(error);

  await syncMemberCount(normalizeId(group.id));

  if (group.group_type === 'squad') {
    await supabaseAdmin
      .from('profiles')
      .update({ current_group_id: null })
      .eq('id', userId)
      .eq('current_group_id', normalizeId(group.id));
  }

  await writeAudit(actorId, 'group.moderation.ban', normalizeId(group.id), {
    userId,
    banHours,
    reason,
  });

  return { bannedUntil };
};

export const banFlaggedSender = async (
  actorId: string,
  flagId: string,
  banHours: number
) => {
  const { flag, message, group } = await getFlagContext(flagId);
  if (flag.status !== 'pending') throw groupError('VALIDATION_FAILED', 409);

  const { bannedUntil } = await banGroupSender(
    actorId,
    group,
    normalizeId(message.sender_id),
    banHours,
    `Moderation case ${flagId}`
  );

  const { error } = await supabaseAdmin
    .from('flagged_messages')
    .update({ status: 'reviewed', action_taken: 'banned', resolved_by: actorId })
    .eq('id', flagId);
  if (error) throw mapDataError(error);

  await writeAudit(actorId, 'group.moderation.flagged_ban', normalizeId(flag.group_id), {
    flagId,
    userId: normalizeId(message.sender_id),
    banHours,
  });

  return { banned: true, banned_until: bannedUntil };
};

export const listAdminGroupFlags = async (groupId: string) => {
  await getGroupOrThrow(groupId);
  const { data, error } = await supabaseAdmin
    .from('flagged_messages')
    .select(FLAG_FIELDS)
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw mapDataError(error);

  const rows = (data || []) as AnyObject[];
  const profileMap = await loadProfiles(
    rows.flatMap((row) => [row.sender_id, row.reported_by])
  );

  return {
    items: rows.map((row) => ({
      ...row,
      sender: profileMap.get(normalizeId(row.sender_id)) ?? null,
      reporter: profileMap.get(normalizeId(row.reported_by)) ?? null,
    })),
  };
};

export const getAdminGroupMessages = async (
  groupId: string,
  params: { limit?: number; before?: string }
) => {
  await getGroupOrThrow(groupId);
  const limit = clampPositiveInt(params.limit, 50, 100);

  let query = supabaseAdmin
    .from('group_chats')
    .select('id, group_id, sender_id, message_type, content, meta_data, created_at, deleted_at, is_flagged')
    .eq('group_id', groupId)
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

  const rows = ((data || []) as AnyObject[]).slice().reverse();
  const profileMap = await loadProfiles(rows.map((row) => row.sender_id));

  return {
    items: rows.map((row) => ({
      ...row,
      sender: profileMap.get(normalizeId(row.sender_id)) ?? null,
    })),
  };
};

export const adminDeleteGroupMessage = async (
  actorId: string,
  groupId: string,
  messageId: string
) => {
  const group = await getGroupOrThrow(groupId);

  const { data, error } = await supabaseAdmin
    .from('group_chats')
    .update({ deleted_at: new Date().toISOString(), deleted_by: actorId })
    .eq('id', messageId)
    .eq('group_id', groupId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();

  if (error) throw mapDataError(error);
  if (!data) throw groupError('MESSAGE_NOT_FOUND', 404);

  await supabaseAdmin
    .from('flagged_messages')
    .update({ status: 'reviewed', action_taken: 'deleted', resolved_by: actorId })
    .eq('chat_id', messageId)
    .eq('status', 'pending');

  await writeAudit(actorId, 'group.message.delete', normalizeId(group.id), {
    messageId,
  });
  return { deleted: true };
};

export const adminCancelGroupBattle = async (
  actorId: string,
  groupId: string,
  battleId: string
) => {
  const group = await getGroupOrThrow(groupId);

  const { data, error } = await supabaseAdmin
    .from('group_battles')
    .update({ status: 'cancelled' })
    .eq('id', battleId)
    .eq('group_id', groupId)
    .in('status', ['pending', 'ongoing'])
    .select('id')
    .maybeSingle();

  if (error) throw mapDataError(error);
  if (!data) throw groupError('BATTLE_NOT_FOUND', 404);

  await writeAudit(actorId, 'group.battle.cancel', normalizeId(group.id), {
    battleId,
  });
  return { cancelled: true };
};

export const adminKickGroupMember = async (
  actorId: string,
  groupId: string,
  userId: string,
  banHours: number
) => {
  const group = await getGroupOrThrow(groupId);
  const result = await banGroupSender(
    actorId,
    group,
    normalizeId(userId),
    banHours,
    'Admin panel action'
  );
  return { kicked: true, banned_until: result.bannedUntil };
};

export const listDictionaryEntries = async () => {
  const { data, error } = await supabaseAdmin
    .from('auto_ban_dictionary')
    .select('id, word, match_type, auto_delete, created_by, created_at')
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) throw mapDataError(error);
  return { items: data || [] };
};

export const createDictionaryEntry = async (
  actorId: string,
  input: { word: string; matchType?: 'contains' | 'exact'; autoDelete?: boolean }
) => {
  const word = normalizeText(input.word).slice(0, 100);
  if (word.length < 1) throw groupError('VALIDATION_FAILED', 400);

  const { data, error } = await supabaseAdmin
    .from('auto_ban_dictionary')
    .insert({
      word,
      match_type: input.matchType ?? 'contains',
      auto_delete: input.autoDelete ?? true,
      created_by: actorId,
    })
    .select('id, word, match_type, auto_delete, created_by, created_at')
    .single();

  if (error) throw mapDataError(error);
  await writeAudit(actorId, 'group.dictionary.create', normalizeId(data.id), { word });
  return { entry: data };
};

export const updateDictionaryEntry = async (
  actorId: string,
  entryId: string,
  input: { word?: string; matchType?: 'contains' | 'exact'; autoDelete?: boolean }
) => {
  const patch: AnyObject = {};
  if (input.word !== undefined) {
    const word = normalizeText(input.word).slice(0, 100);
    if (!word) throw groupError('VALIDATION_FAILED', 400);
    patch.word = word;
  }
  if (input.matchType !== undefined) patch.match_type = input.matchType;
  if (input.autoDelete !== undefined) patch.auto_delete = input.autoDelete;
  if (Object.keys(patch).length === 0) throw groupError('VALIDATION_FAILED', 400);

  const { data, error } = await supabaseAdmin
    .from('auto_ban_dictionary')
    .update(patch)
    .eq('id', entryId)
    .select('id, word, match_type, auto_delete, created_by, created_at')
    .maybeSingle();

  if (error) throw mapDataError(error);
  if (!data) throw groupError('VALIDATION_FAILED', 404);

  await writeAudit(actorId, 'group.dictionary.update', entryId, {
    fields: Object.keys(patch),
  });
  return { entry: data };
};

export const deleteDictionaryEntry = async (actorId: string, entryId: string) => {
  const { data, error } = await supabaseAdmin
    .from('auto_ban_dictionary')
    .delete()
    .eq('id', entryId)
    .select('id')
    .maybeSingle();

  if (error) throw mapDataError(error);
  if (!data) throw groupError('VALIDATION_FAILED', 404);

  await writeAudit(actorId, 'group.dictionary.delete', entryId);
  return { deleted: true };
};

const SETTING_KEYS = [
  'group_squad_default_members',
  'group_squad_max_members',
  'group_community_max_members',
  'group_battle_participation_xp',
  'group_battle_winner_bonus_xp',
  'group_leaderboard_min_members',
] as const;

export type GroupSettingKey = (typeof SETTING_KEYS)[number];

const SETTING_DEFAULTS: Record<GroupSettingKey, number> = {
  group_squad_default_members: 30,
  group_squad_max_members: 50,
  group_community_max_members: 200,
  group_battle_participation_xp: 10,
  group_battle_winner_bonus_xp: 20,
  group_leaderboard_min_members: 3,
};

const readSettingNumber = (value: unknown): number | null => {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value) && 'value' in (value as AnyObject)
      ? (value as AnyObject).value
      : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
};

export const getAdminGroupSettings = async () => {
  const { data, error } = await supabaseAdmin
    .from('app_configs')
    .select('key, value')
    .in('key', SETTING_KEYS);

  if (error) throw mapDataError(error);

  const values = new Map(
    (data || []).map((row: AnyObject) => [String(row.key), row.value])
  );

  const settings = Object.fromEntries(
    SETTING_KEYS.map((key) => [
      key,
      readSettingNumber(values.get(key)) ?? SETTING_DEFAULTS[key],
    ])
  ) as Record<GroupSettingKey, number>;

  return { settings, defaults: SETTING_DEFAULTS, caps: { min: 1, max: 500 } };
};

export const updateAdminGroupSettings = async (
  actorId: string,
  input: Partial<Record<GroupSettingKey, number>>
) => {
  const entries = Object.entries(input).filter(
    (entry): entry is [GroupSettingKey, number] =>
      SETTING_KEYS.includes(entry[0] as GroupSettingKey) && Number.isFinite(entry[1])
  );
  if (entries.length === 0) throw groupError('VALIDATION_FAILED', 400);

  const rows = entries.map(([key, rawValue]) => {
    const value = Math.floor(rawValue);
    if (value < 1 || value > 500) throw groupError('VALIDATION_FAILED', 400);
    return { key, value };
  });

  const { error } = await supabaseAdmin
    .from('app_configs')
    .upsert(rows, { onConflict: 'key' });

  if (error) throw mapDataError(error);

  await writeAudit(actorId, 'group.settings.update', 'group_settings', {
    keys: rows.map((row) => row.key),
  });

  return getAdminGroupSettings();
};

export const getAdminGroupLeaderboard = async (params: {
  period: 'weekly' | 'monthly' | 'all_time';
  page?: number;
  pageSize?: number;
}) => {
  const page = clampPositiveInt(params.page, 1, 100000);
  const pageSize = clampPositiveInt(params.pageSize, MODERATION_PAGE_SIZE, MODERATION_MAX_PAGE_SIZE);
  const start = (page - 1) * pageSize;

  const { data, error, count } = await supabaseAdmin
    .from('group_leaderboard_cache')
    .select(
      'group_id, period_type, rank, previous_rank, total_xp, avg_xp, member_count, last_updated_at',
      { count: 'exact' }
    )
    .eq('period_type', params.period)
    .order('rank', { ascending: true })
    .range(start, start + pageSize - 1);

  if (error) throw mapDataError(error);

  const rows = (data || []) as AnyObject[];
  const groupIds = rows.map((row) => normalizeId(row.group_id)).filter(Boolean);
  const { data: groups, error: groupsError } = groupIds.length
    ? await supabaseAdmin
        .from('study_groups')
        .select('id, slug, name, icon, group_type, member_count, is_active')
        .in('id', groupIds)
    : { data: [], error: null };

  if (groupsError) throw mapDataError(groupsError);

  const groupMap = new Map<string, AnyObject>(
    ((groups || []) as AnyObject[]).map((group) => [normalizeId(group.id), group])
  );

  const total = typeof count === 'number' ? count : rows.length;
  return {
    period: params.period,
    items: rows.map((row) => ({
      ...row,
      group: groupMap.get(normalizeId(row.group_id)) ?? null,
    })),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    hasMore: start + rows.length < total,
  };
};

export const refreshAdminGroupLeaderboard = async (actorId: string) => {
  const { error } = await supabaseAdmin.rpc('refresh_group_leaderboard');
  if (error) throw mapDataError(error);
  await writeAudit(actorId, 'group.leaderboard.refresh', 'group_leaderboard_cache');
  return { refreshed: true };
};
