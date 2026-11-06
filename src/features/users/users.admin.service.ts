import { supabase } from '../../config/supabase';
import { createUserSupabaseClient } from '../../config/userSupabase';
import { recordAdminAudit } from '../../lib/utils/adminAudit';
import { isUuid } from '../../lib/utils/search';
import { evaluateAccountRisk, type RiskAuditRow, type RiskDeviceRow } from './users.risk';
import {
  UsersAdminError,
  type DirectoryAccess,
  type DirectoryQuery,
  type DirectoryResult,
  type DirectoryRow,
  type User360Response,
} from './users.admin.types';

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

const DIRECTORY_COLUMNS =
  'id, full_name, email, username, phone_number, account_status, subscription_status, class_level, institution, created_at, last_active_at, total_xp, coin_balance, current_streak';

const GRANT_COLUMNS = 'id, user_id, scope, grant_type, features, starts_at, expires_at, revoked_at';

const MAX_GRANT_ROWS = 5000;
const MAX_RISK_ROWS = 5000;
const RISK_PAGE_SIZE = 1000;
const ID_CHUNK_SIZE = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Reads evidence page by page instead of relying on a single capped response. */
const fetchRiskRows = async <T>(
  build: (from: number, to: number) => any,
  label: string
): Promise<T[]> => {
  const rows: T[] = [];

  for (let from = 0; from < MAX_RISK_ROWS; from += RISK_PAGE_SIZE) {
    const to = Math.min(from + RISK_PAGE_SIZE - 1, MAX_RISK_ROWS - 1);
    const { data, error } = await build(from, to);
    if (error) {
      console.error(`[users] risk ${label} unavailable:`, error.message);
      throw new UsersAdminError('Risk data is temporarily unavailable', 503);
    }
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < RISK_PAGE_SIZE) break;
  }

  return rows;
};

const chunkIds = (ids: string[]): string[][] => {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += ID_CHUNK_SIZE) {
    chunks.push(ids.slice(index, index + ID_CHUNK_SIZE));
  }
  return chunks;
};

const isGrantActive = (grant: GrantRow, now: number): boolean => {
  if (grant.revoked_at) return false;
  if (grant.starts_at && Date.parse(grant.starts_at) > now) return false;
  if (grant.expires_at && Date.parse(grant.expires_at) <= now) return false;
  return true;
};

/**
 * Reads the grants that could currently grant something. Bounded and filtered
 * in SQL first so the directory never loads the whole history.
 */
const readActiveGrants = async (now: number): Promise<GrantRow[]> => {
  const rows: GrantRow[] = [];

  for (let from = 0; from < MAX_GRANT_ROWS; from += RISK_PAGE_SIZE) {
    const to = Math.min(from + RISK_PAGE_SIZE - 1, MAX_GRANT_ROWS - 1);
    const { data, error } = await supabase
      .from('access_grants')
      .select(GRANT_COLUMNS)
      .is('revoked_at', null)
      .or(`expires_at.is.null,expires_at.gt.${new Date(now).toISOString()}`)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to);

    if (error) {
      console.error('[users] active grants unavailable:', error.message);
      throw new UsersAdminError('Access data is temporarily unavailable', 503);
    }

    const page = (data ?? []) as GrantRow[];
    rows.push(...page);
    if (page.length < RISK_PAGE_SIZE) break;
  }

  return rows.filter((grant) => isGrantActive(grant, now));
};

const accessFromGrants = (
  subscriptionStatus: string | null,
  ownGrants: GrantRow[],
  globalGrants: GrantRow[],
  unlimitedAllScope: boolean
): DirectoryAccess => {
  const premium = [...ownGrants, ...globalGrants].filter((grant) => grant.grant_type === 'premium');

  const unlimitedFeatures = new Set<string>();
  let unlimitedAll = unlimitedAllScope;
  ownGrants
    .filter((grant) => grant.grant_type === 'unlimited_quota')
    .forEach((grant) => {
      if (!grant.features || grant.features.length === 0) unlimitedAll = true;
      else grant.features.forEach((feature) => unlimitedFeatures.add(feature));
    });
  globalGrants
    .filter((grant) => grant.grant_type === 'unlimited_quota')
    .forEach((grant) => {
      if (!grant.features || grant.features.length === 0) unlimitedAll = true;
      else grant.features.forEach((feature) => unlimitedFeatures.add(feature));
    });

  const expiries = premium
    .map((grant) => grant.expires_at)
    .filter((value): value is string => Boolean(value))
    .sort();

  return {
    subscription_status: subscriptionStatus,
    subscription_premium: subscriptionStatus === 'premium',
    active_grant_count: ownGrants.length,
    premium_grant: premium.length > 0,
    unlimited_features: unlimitedFeatures.size > 0 ? [...unlimitedFeatures] : null,
    unlimited_all: unlimitedAll,
    access_expires_at: premium.some((grant) => !grant.expires_at)
      ? null
      : expiries.at(-1) ?? null,
  };
};

const EMPTY_RESULT = (query: DirectoryQuery): DirectoryResult => ({
  items: [],
  total: 0,
  page: query.page,
  page_size: query.page_size,
  has_more: false,
});

/**
 * Paginated, filtered and sorted user directory.
 *
 * Filtering happens in Postgres through PostgREST; the page's roles and grants
 * are then hydrated in two batched `in` queries so a page costs a constant
 * number of round trips instead of one per row.
 */
export const listUsers = async (query: DirectoryQuery): Promise<DirectoryResult> => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const activeGrants = await readActiveGrants(now);
  const unlimitedAllScope = activeGrants.some(
    (grant) =>
      grant.scope === 'all' &&
      grant.grant_type === 'unlimited_quota' &&
      (!grant.features || grant.features.length === 0)
  );

  const userGrantIds = [
    ...new Set(
      activeGrants
        .filter((grant) => grant.scope === 'user' && grant.user_id)
        .map((grant) => grant.user_id as string)
    ),
  ];
  const unlimitedUserIds = [
    ...new Set(
      activeGrants
        .filter(
          (grant) =>
            grant.scope === 'user' && grant.grant_type === 'unlimited_quota' && grant.user_id
        )
        .map((grant) => grant.user_id as string)
    ),
  ];

  let queryBuilder = supabase.from('profiles').select(DIRECTORY_COLUMNS, { count: 'exact' });

  if (query.status !== 'all') queryBuilder = queryBuilder.eq('account_status', query.status);

  if (query.access === 'premium') {
    // Matches the access overview's definition of a premium user: an active
    // subscription. Grant-only access is filtered separately as `grant`.
    queryBuilder = queryBuilder.eq('subscription_status', 'premium');
  } else if (query.access === 'free') {
    queryBuilder = queryBuilder.or('subscription_status.is.null,subscription_status.neq.premium');
  } else if (query.access === 'grant') {
    if (userGrantIds.length === 0) return EMPTY_RESULT(query);
    queryBuilder = queryBuilder.in('id', userGrantIds);
  } else if (query.access === 'unlimited') {
    if (unlimitedAllScope) {
      // Everyone has unlimited usage; the filter is a no-op.
    } else if (unlimitedUserIds.length === 0) {
      return EMPTY_RESULT(query);
    } else {
      queryBuilder = queryBuilder.in('id', unlimitedUserIds);
    }
  }

  if (query.role !== 'all') {
    const { data: roleRows, error: roleError } = await supabase
      .from('user_roles')
      .select('user_id')
      .eq('role', query.role)
      .eq('is_active', true)
      .limit(MAX_GRANT_ROWS);

    if (roleError) {
      console.error('[users] role filter unavailable:', roleError.message);
      throw new UsersAdminError('Role data is temporarily unavailable', 503);
    }

    const roleIds = [
      ...new Set((roleRows ?? []).map((row: any) => String(row.user_id)).filter(Boolean)),
    ];
    if (roleIds.length === 0) return EMPTY_RESULT(query);
    queryBuilder = queryBuilder.in('id', roleIds);
  }

  if (query.created_from) queryBuilder = queryBuilder.gte('created_at', query.created_from);
  if (query.created_to) queryBuilder = queryBuilder.lte('created_at', query.created_to);

  if (query.q) {
    const term = query.q;
    const clauses = [
      `full_name.ilike.%${term}%`,
      `email.ilike.%${term}%`,
      `username.ilike.%${term}%`,
      `phone_number.ilike.%${term}%`,
    ];
    if (isUuid(term)) clauses.push(`id.eq.${term}`);
    queryBuilder = queryBuilder.or(clauses.join(','));
  }

  const from = (query.page - 1) * query.page_size;
  const to = from + query.page_size - 1;

  const { data, count, error } = await queryBuilder
    .order(query.sort, { ascending: query.direction === 'asc', nullsFirst: false })
    .range(from, to);

  if (error) {
    console.error('[users] directory query failed:', error.message);
    throw new UsersAdminError('User directory is temporarily unavailable', 503);
  }

  const profiles = (data ?? []) as any[];
  const ids = profiles.map((profile) => String(profile.id));

  const rolesById = new Map<string, string>();
  const grantsByUser = new Map<string, GrantRow[]>();
  let globalGrants: GrantRow[] = [];

  if (ids.length > 0) {
    const [roles, grants] = await Promise.all([
      supabase.from('user_roles').select('user_id, role').in('user_id', ids).eq('is_active', true),
      supabase
        .from('access_grants')
        .select(GRANT_COLUMNS)
        .in('user_id', ids)
        .is('revoked_at', null)
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`),
    ]);

    if (roles.error) console.error('[users] role hydration failed:', roles.error.message);
    if (grants.error) console.error('[users] grant hydration failed:', grants.error.message);

    (roles.data ?? []).forEach((row: any) => rolesById.set(String(row.user_id), String(row.role)));

    const globalPremium = activeGrants.filter(
      (grant) => grant.scope === 'all' && grant.grant_type === 'premium'
    );
    const globalUnlimited = activeGrants.filter(
      (grant) => grant.scope === 'all' && grant.grant_type === 'unlimited_quota'
    );

    ids.forEach((id) => {
      const own = ((grants.data ?? []) as GrantRow[])
        .filter((grant) => grant.user_id === id)
        .filter((grant) => isGrantActive(grant, now));
      grantsByUser.set(id, own);
    });

    globalGrants = [...globalPremium, ...globalUnlimited];
  }

  const items: DirectoryRow[] = profiles.map((profile) => ({
    id: String(profile.id),
    full_name: profile.full_name ?? null,
    email: profile.email ?? null,
    username: profile.username ?? null,
    phone_number: profile.phone_number ?? null,
    account_status: profile.account_status ?? null,
    role: rolesById.get(String(profile.id)) ?? 'student',
    class_level: profile.class_level ?? null,
    institution: profile.institution ?? null,
    created_at: profile.created_at ?? null,
    last_active_at: profile.last_active_at ?? null,
    total_xp: profile.total_xp ?? 0,
    coin_balance: profile.coin_balance ?? 0,
    current_streak: profile.current_streak ?? 0,
    access: accessFromGrants(
      profile.subscription_status ?? null,
      grantsByUser.get(String(profile.id)) ?? [],
      globalGrants,
      unlimitedAllScope
    ),
  }));

  const total = count ?? 0;

  return {
    items,
    total,
    page: query.page,
    page_size: query.page_size,
    has_more: from + items.length < total,
  };
};

/** Same filters as the directory, capped, for the CSV export. */
export const listUsersForExport = async (
  query: DirectoryQuery,
  limit: number
): Promise<DirectoryRow[]> => {
  const result = await listUsers({ ...query, page: 1, page_size: Math.min(limit, 100) });

  if (result.total <= result.items.length) return result.items;

  const chunks: DirectoryRow[] = [...result.items];
  let page = 1;

  while (chunks.length < limit && chunks.length < result.total) {
    page += 1;
    const next = await listUsers({ ...query, page, page_size: 100 });
    if (next.items.length === 0) break;
    chunks.push(...next.items);
  }

  return chunks.slice(0, limit);
};

export const getUser360Profile = async (userId: string): Promise<User360Response> => {
  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (profileErr || !profile) throw new UsersAdminError('User not found', 404);

  const [queries, roleResult, accessResult] = await Promise.all([
    Promise.all([
      supabase
        .from('exam_history')
        .select('id, score, total_marks, rank, correct_count, wrong_count, skipped_count, time_taken, created_at, exam_papers(title)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(200),
      supabase.from('bookmarks').select('id', { count: 'exact', head: true }).eq('user_id', userId),
      supabase.from('wrong_answers').select('id', { count: 'exact', head: true }).eq('user_id', userId),
      supabase
        .from('group_members')
        .select('role, contribution_xp, joined_at, study_groups(id, name, icon, group_level)')
        .eq('user_id', userId)
        .maybeSingle(),
      supabase
        .from('user_subscriptions')
        .select('id, start_date, end_date, status, subscription_plans(name)')
        .eq('user_id', userId)
        .order('end_date', { ascending: false }),
      supabase
        .from('coin_transactions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20),
      supabase
        .from('payment_requests')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10),
      supabase
        .from('user_quest_progress')
        .select('id, is_completed, progress_count, daily_quests(title, target_count)')
        .eq('user_id', userId),
      supabase
        .from('user_devices')
        .select('*')
        .eq('user_id', userId)
        .order('last_active_at', { ascending: false }),
      supabase
        .from('user_reports')
        .select('id, type, status, created_at')
        .eq('reporter_user_id', userId)
        .order('created_at', { ascending: false }),
      supabase
        .from('audit_logs')
        .select('*')
        .eq('target_id', userId)
        .order('created_at', { ascending: false })
        .limit(20),
      supabase
        .from('user_warnings')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20),
      supabase
        .from('security_audit_logs')
        .select('id, actor_user_id, target_user_id, action, resource_type, resource_id, old_values, new_values, outcome, created_at')
        .eq('target_user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50),
      supabase.from('questions').select('id', { count: 'exact', head: true }).eq('created_by', userId),
    ]),
    supabase.from('user_roles').select('role').eq('user_id', userId).eq('is_active', true).limit(1).maybeSingle(),
    supabase.rpc('get_quota_status', { p_user_id: userId }),
  ]);

  const [
    exams,
    bookmarks,
    wrongAnswers,
    group,
    subscriptions,
    coins,
    payments,
    quests,
    devices,
    reports,
    audits,
    warnings,
    securityEvents,
    questions,
  ] = queries;

  const examRows = (exams.data ?? []) as any[];
  const totalCorrect = examRows.reduce((sum, row) => sum + (row.correct_count ?? 0), 0);
  const totalWrong = examRows.reduce((sum, row) => sum + (row.wrong_count ?? 0), 0);
  const answered = totalCorrect + totalWrong;
  const totalSeconds = examRows.reduce((sum, row) => sum + (row.time_taken ?? 0), 0);

  const riskAuditRows: RiskAuditRow[] = [
    ...(audits.data ?? []).map((row: any) => ({
      target_user_id: row.target_id ?? null,
      action: String(row.action ?? ''),
      outcome: 'success',
      created_at: row.created_at,
    })),
    ...(securityEvents.data ?? []).map((row: any) => ({
      target_user_id: row.target_user_id ?? null,
      action: String(row.action ?? ''),
      outcome: String(row.outcome ?? 'success'),
      created_at: row.created_at,
    })),
  ];

  const risk = evaluateAccountRisk(
    userId,
    (devices.data ?? []) as RiskDeviceRow[],
    riskAuditRows
  );

  return {
    profile: profile as User360Response['profile'],
    role: (roleResult.data as any)?.role ?? 'student',
    access: ((accessResult.data as any)?.access ?? {
      tier: 'free',
      premium: false,
      source: 'free',
      premium_expires_at: null,
      unlimited_all: false,
      unlimited_features: null,
    }) as User360Response['access'],
    recent_exams: examRows.slice(0, 5).map((exam) => ({
      ...exam,
      title: Array.isArray(exam.exam_papers)
        ? exam.exam_papers[0]?.title
        : exam.exam_papers?.title || 'Unknown Exam',
    })),
    exam_stats: {
      total_exams: examRows.length,
      total_correct: totalCorrect,
      total_wrong: totalWrong,
      accuracy_rate: answered > 0 ? Math.round((totalCorrect / answered) * 1000) / 10 : 0,
      avg_time_taken_mins:
        examRows.length > 0 ? Math.round((totalSeconds / examRows.length / 60) * 10) / 10 : 0,
      strong_subjects: [],
      weak_subjects: [],
    },
    academic_engagement: {
      bookmarks_count: bookmarks.count ?? 0,
      wrong_answers_count: wrongAnswers.count ?? 0,
    },
    support_activity: {
      reports_submitted: (reports.data ?? []).length,
      questions_created: questions.count ?? 0,
    },
    group_details: group.data
      ? {
          role: group.data.role,
          contribution_xp: group.data.contribution_xp,
          joined_at: group.data.joined_at,
          ...((Array.isArray(group.data.study_groups)
            ? group.data.study_groups[0]
            : group.data.study_groups) || {}),
        }
      : null,
    pvp_stats: {
      played: (profile as any).pvp_matches_played || 0,
      won: (profile as any).pvp_matches_won || 0,
    },
    subscription_history: (subscriptions.data ?? []).map((subscription: any) => ({
      ...subscription,
      plan_name: Array.isArray(subscription.subscription_plans)
        ? subscription.subscription_plans[0]?.name
        : subscription.subscription_plans?.name || 'Unknown Plan',
    })),
    coin_transactions: coins.data ?? [],
    fiat_payments: payments.data ?? [],
    quests: (quests.data ?? []).map((quest: any) => ({
      id: quest.id,
      is_completed: quest.is_completed,
      progress_count: quest.progress_count,
      title: Array.isArray(quest.daily_quests)
        ? quest.daily_quests[0]?.title
        : quest.daily_quests?.title || 'Quest',
      target_count: Array.isArray(quest.daily_quests)
        ? quest.daily_quests[0]?.target_count
        : quest.daily_quests?.target_count || 1,
    })),
    devices: devices.data ?? [],
    support_tickets: reports.data ?? [],
    warnings: warnings.data ?? [],
    audit_logs: audits.data ?? [],
    security_events: securityEvents.data ?? [],
    risk: { level: risk.level, signals: risk.signals },
  };
};

/** Suspends or reactivates an account through the authoritative RBAC RPC. */
export const setAccountStatus = async (
  actorId: string,
  userId: string,
  status: 'active' | 'suspended',
  accessToken: string
) => {
  if (!isUuid(userId)) throw new UsersAdminError('User not found', 404);
  if (status !== 'active' && status !== 'suspended') {
    throw new UsersAdminError('status must be active or suspended');
  }

  const client = createUserSupabaseClient(accessToken);
  const { data, error } = await client.rpc('set_user_account_status', {
    p_target_user_id: userId,
    p_status: status,
  });

  if (error) throw mapRpcError(error, 'The account status could not be changed');

  await recordAdminAudit(actorId, `users.account.${status === 'active' ? 'reactivate' : 'suspend'}`, 'profiles', userId);

  return { user_id: userId, account_status: status, result: data ?? null };
};

/** Ends every session of a target account through the revocation RPC. */
export const forceLogoutUser = async (actorId: string, userId: string, accessToken: string) => {
  if (!isUuid(userId)) throw new UsersAdminError('User not found', 404);

  const client = createUserSupabaseClient(accessToken);
  const { error } = await client.rpc('revoke_user_sessions', { p_target_user_id: userId });

  if (error) {
    if (isMissingFunction(error)) {
      throw new UsersAdminError(
        'Session revocation is not available on this database yet',
        503,
        'SESSION_REVOCATION_UNAVAILABLE'
      );
    }
    throw mapRpcError(error, 'The user sessions could not be revoked');
  }

  await recordAdminAudit(actorId, 'users.sessions.force_logout', 'profile', userId);

  return { user_id: userId, sessions_revoked: true };
};

interface RpcError {
  code?: string;
  message?: string;
  details?: string;
}

const isMissingFunction = (error: RpcError): boolean =>
  error.code === 'PGRST202' || /could not find the function/i.test(error.message ?? '');

const RPC_MESSAGES: Record<string, string> = {
  '42501': 'Your role does not permit this action',
  '23514': 'This change would leave the platform without an active Super Admin',
  '22023': 'The request is not valid for this account',
  P0002: 'User not found',
};

const mapRpcError = (error: RpcError, fallback: string): UsersAdminError => {
  const code = error.code ?? '';
  const message = RPC_MESSAGES[code];

  if (message) {
    const status = code === '42501' ? 403 : code === 'P0002' ? 404 : code === '23514' ? 409 : 400;
    return new UsersAdminError(message, status);
  }

  // The RPC raises plain (untranslated) errors for the remaining guard rails.
  const raised = (error.message ?? '').trim();
  if (raised && !/^[A-Z_]+$/.test(raised) && raised.length < 200) {
    return new UsersAdminError(raised, 400);
  }

  console.error('[users] authorization RPC failed:', error.code ?? 'unknown');
  return new UsersAdminError(fallback, 500);
};

/**
 * Manual coin adjustment.
 *
 * Uses compare-and-set on coin_balance so two simultaneous adjustments cannot
 * lose an update, refuses to drive the balance negative, and records both the
 * ledger row and the administrative audit entry.
 */
export const adjustCoinBalance = async (
  actorId: string,
  userId: string,
  amount: number,
  reason: string
) => {
  if (!isUuid(userId)) throw new UsersAdminError('User not found', 404);
  if (!Number.isInteger(amount) || amount === 0) {
    throw new UsersAdminError('amount must be a non-zero whole number');
  }
  if (Math.abs(amount) > 1_000_000) {
    throw new UsersAdminError('amount must be at most 1,000,000 coins');
  }

  const trimmedReason = reason.trim();
  if (trimmedReason.length < 3) throw new UsersAdminError('A reason is required');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: profile, error: readError } = await supabase
      .from('profiles')
      .select('coin_balance')
      .eq('id', userId)
      .maybeSingle();

    if (readError) {
      console.error('[users] balance read failed:', readError.message);
      throw new UsersAdminError('Coin balance is temporarily unavailable', 503);
    }
    if (!profile) throw new UsersAdminError('User not found', 404);

    const current = Number((profile as any).coin_balance ?? 0);
    const next = current + amount;

    if (next < 0) {
      throw new UsersAdminError(
        `The balance is ${current} coins; a deduction of ${Math.abs(amount)} is not possible`,
        409
      );
    }

    const { data: updated, error: writeError } = await supabase
      .from('profiles')
      .update({ coin_balance: next })
      .eq('id', userId)
      .eq('coin_balance', current)
      .select('coin_balance')
      .maybeSingle();

    if (writeError) {
      console.error('[users] balance write failed:', writeError.message);
      throw new UsersAdminError('Coin balance could not be updated', 503);
    }

    if (updated) {
      const { error: ledgerError } = await supabase.from('coin_transactions').insert({
        user_id: userId,
        amount,
        transaction_type: 'admin_adjustment',
        description: trimmedReason,
        meta_data: { admin_id: actorId },
      });

      if (ledgerError) {
        console.error('[users] coin ledger entry failed:', ledgerError.message);
      }

      await recordAdminAudit(actorId, 'users.balance.adjust', 'profiles', userId, {
        amount,
        reason: trimmedReason,
        balance_before: current,
        balance_after: next,
      });

      return { user_id: userId, amount, balance_before: current, balance_after: next };
    }
  }

  throw new UsersAdminError(
    'The balance changed while this adjustment was running; reload and try again',
    409
  );
};

export interface RiskAccountRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  username: string | null;
  phone_number: string | null;
  account_status: string | null;
  role: string;
  level: string;
  signals: Array<{ code: string; level: string; label: string; detail: string }>;
  active_devices_24h: number;
  active_devices_7d: number;
  distinct_ips_24h: number;
  untrusted_devices: number;
  last_active_at: string | null;
}

const riskLevelRank: Record<string, number> = { high: 3, medium: 2, info: 1, none: 0 };

/**
 * Accounts with at least one evidence-backed signal in the last seven days.
 * Accounts with no signal are omitted rather than shown as "clean", so the list
 * never implies monitoring coverage it does not have.
 */
export const listRiskAccounts = async (): Promise<RiskAccountRow[]> => {
  const now = Date.now();
  const since = new Date(now - 7 * DAY_MS).toISOString();

  const [deviceRows, auditRows] = await Promise.all([
    fetchRiskRows<RiskDeviceRow>(
      (from, to) =>
        supabase
          .from('user_devices')
          .select('user_id, device_name, platform, os_or_browser, ip_address, last_active_at, is_trusted')
          .gte('last_active_at', since)
          .order('last_active_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to),
      'devices'
    ),
    fetchRiskRows<RiskAuditRow>(
      (from, to) =>
        supabase
          .from('security_audit_logs')
          .select('target_user_id, action, outcome, created_at')
          .gte('created_at', since)
          .not('target_user_id', 'is', null)
          .or('outcome.eq.denied,action.eq.account.sessions_revoked')
          .order('created_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to),
      'security events'
    ),
  ]);

  const candidateIds = new Set<string>();
  deviceRows.forEach((row) => candidateIds.add(String(row.user_id)));
  auditRows.forEach((row) => {
    if (row.target_user_id) candidateIds.add(String(row.target_user_id));
  });

  if (candidateIds.size === 0) return [];

  const ids = [...candidateIds].slice(0, MAX_RISK_ROWS);

  const idChunks = chunkIds(ids);
  const [profilePages, rolePages] = await Promise.all([
    Promise.all(
      idChunks.map((chunk) =>
        supabase
          .from('profiles')
          .select('id, full_name, email, username, phone_number, account_status')
          .in('id', chunk)
      )
    ),
    Promise.all(
      idChunks.map((chunk) =>
        supabase
          .from('user_roles')
          .select('user_id, role')
          .in('user_id', chunk)
          .eq('is_active', true)
      )
    ),
  ]);

  const profileError = profilePages.find((page) => page.error);
  if (profileError) {
    console.error('[users] risk profiles unavailable:', profileError.error?.message);
    throw new UsersAdminError('Risk data is temporarily unavailable', 503);
  }

  const profilesById = new Map(
    profilePages.flatMap((page) => page.data ?? []).map((row: any) => [String(row.id), row])
  );
  const roleError = rolePages.find((page) => page.error);
  if (roleError) console.error('[users] risk roles unavailable:', roleError.error?.message);

  const rolesById = new Map(
    rolePages.flatMap((page) => page.data ?? []).map((row: any) => [String(row.user_id), String(row.role)])
  );

  const rows: RiskAccountRow[] = [];

  ids.forEach((id) => {
    const risk = evaluateAccountRisk(id, deviceRows, auditRows, now);
    if (risk.level === 'none') return;

    const profile = profilesById.get(id) as any;
    if (!profile) return;

    rows.push({
      user_id: id,
      full_name: profile.full_name ?? null,
      email: profile.email ?? null,
      username: profile.username ?? null,
      phone_number: profile.phone_number ?? null,
      account_status: profile.account_status ?? null,
      role: rolesById.get(id) ?? 'student',
      level: risk.level,
      signals: risk.signals,
      active_devices_24h: risk.active_devices_24h,
      active_devices_7d: risk.active_devices_7d,
      distinct_ips_24h: risk.distinct_ips_24h,
      untrusted_devices: risk.untrusted_devices,
      last_active_at: risk.last_active_at,
    });
  });

  return rows.sort(
    (left, right) =>
      riskLevelRank[right.level] - riskLevelRank[left.level] ||
      right.active_devices_24h - left.active_devices_24h
  );
};

/** Device and session evidence for one account. */
export const getAccountRiskDetail = async (userId: string) => {
  if (!isUuid(userId)) throw new UsersAdminError('User not found', 404);

  const now = Date.now();
  const since = new Date(now - 30 * DAY_MS).toISOString();

  const [profile, devices, audits, sessions] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, full_name, email, username, phone_number, account_status, last_active_at, sessions_revoked_at')
      .eq('id', userId)
      .maybeSingle(),
    supabase
      .from('user_devices')
      .select('id, user_id, device_name, platform, os_or_browser, ip_address, last_active_at, is_trusted, created_at')
      .eq('user_id', userId)
      .order('last_active_at', { ascending: false })
      .limit(100),
    supabase
      .from('security_audit_logs')
      .select('id, target_user_id, action, outcome, created_at, actor_user_id')
      .eq('target_user_id', userId)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('admin_auth_sessions')
      .select('id, created_at, last_seen_at, revoked_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  if (profile.error || !profile.data) throw new UsersAdminError('User not found', 404);

  const deviceRows = (devices.data ?? []) as RiskDeviceRow[];
  const auditRows = (audits.data ?? []) as RiskAuditRow[];
  const risk = evaluateAccountRisk(userId, deviceRows, auditRows, now);

  return {
    profile: profile.data,
    risk,
    devices: devices.data ?? [],
    security_events: (audits.data ?? []).filter(
      (row: any) => Date.parse(row.created_at) >= Date.parse(since)
    ),
    admin_sessions: sessions.data ?? [],
    /** Only rows that exist are reported; an empty list means no recorded device activity. */
    evidence_sources: ['user_devices', 'security_audit_logs', 'admin_auth_sessions'],
  };
};
