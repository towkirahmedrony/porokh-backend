import { supabase } from '../../config/supabase';
import { parseUpdatePolicy, UPDATE_POLICY_KEY } from '../system/update-policy';
import {
  averageScorePercent,
  bucketSeries,
  buildBucketKeys,
  calculateTrend,
  dhakaDayKey,
  dhakaDayStart,
  dhakaHourKey,
  dhakaHourOfDay,
  dhakaMonthStart,
  percentOf,
  previousRange,
  roundMoney,
  sumBucketSeries,
  summarizePayments,
  type DashboardRange,
  type PaymentAmountRow,
} from './dashboard.metrics';
import type {
  ActivityResponse,
  AnalyticsResponse,
  DashboardCapabilities,
  DashboardMetric,
  HealthResponse,
  HealthService,
  MetricScope,
  OverviewResponse,
  SecuritySection,
} from './dashboard.types';

type Row = Record<string, unknown>;
type QueryError = { message: string } | null;

/** Bounded reads: a series is capped so one huge table cannot exhaust memory. */
const SERIES_LIMIT = 20_000;
const DEVICE_LIMIT = 5_000;
const MAX_ACTIVITY_LIMIT = 50;
const IN_EXAM_WINDOW_MS = 15 * 60_000;
const HEALTH_TIMEOUT_MS = 4_000;

interface StatusError extends Error {
  status?: number;
}

const fail = (context: string, error: QueryError): never => {
  console.error(`[dashboard] ${context} unavailable:`, error?.message ?? 'unknown error');
  const wrapped: StatusError = new Error(`Dashboard data is temporarily unavailable (${context})`);
  wrapped.status = 503;
  throw wrapped;
};

const readCount = async (
  work: PromiseLike<{ count: number | null; error: QueryError }>,
  context: string
): Promise<number> => {
  const { count, error } = await work;
  if (error) fail(context, error);
  return count ?? 0;
};

const readRows = async (
  table: string,
  columns: string,
  context: string,
  limit = 2_000
): Promise<Row[]> => {
  const { data, error } = await supabase.from(table).select(columns).limit(limit);
  if (error) fail(context, error);
  return (data ?? []) as unknown as Row[];
};

interface WindowResult {
  rows: Row[];
  truncated: boolean;
}

const readWindow = async (
  table: string,
  columns: string,
  dateColumn: string,
  fromIso: string,
  toIso: string,
  context: string,
  limit = SERIES_LIMIT
): Promise<WindowResult> => {
  const { data, error } = await supabase
    .from(table)
    .select(columns)
    .gte(dateColumn, fromIso)
    .lt(dateColumn, toIso)
    .order(dateColumn, { ascending: true })
    .limit(limit);

  if (error) fail(context, error);

  const rows = (data ?? []) as unknown as Row[];
  return { rows, truncated: rows.length >= limit };
};

const readMoneyRows = async (
  work: PromiseLike<{ data: Row[] | null; error: QueryError }>,
  context: string
): Promise<Row[]> => {
  const { data, error } = await work;
  if (error) fail(context, error);
  return data ?? [];
};

const readFiltered = async (
  build: () => PromiseLike<{ data: Row[] | null; error: QueryError }>,
  context: string
): Promise<Row[]> => {
  const { data, error } = await build();
  if (error) fail(context, error);
  return data ?? [];
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const numberOf = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const displayName = (row: Row): string =>
  text(row.full_name) || text(row.username) || 'Unnamed learner';

const sumAmounts = (rows: Row[]): number =>
  roundMoney(rows.reduce((total, row) => total + numberOf(row.amount), 0));

const buildMetric = (
  value: number,
  previous: number | null,
  comparisonLabel: string,
  scope: MetricScope,
  note?: string
): DashboardMetric => ({
  value: roundMoney(value),
  previous: previous === null ? null : roundMoney(previous),
  changePercent: calculateTrend(value, previous),
  comparisonLabel,
  scope,
  ...(note ? { note } : {}),
});

const safeHref = (value: unknown): string | null =>
  typeof value === 'string' && value.startsWith('/') ? value : null;

const roundHourSeries = (rows: Row[]): Array<{ hour: number; attempts: number }> => {
  const counts = Array.from({ length: 24 }, () => 0);

  for (const row of rows) {
    const hour = dhakaHourOfDay(text(row.created_at));
    if (hour === null) continue;
    counts[hour] += 1;
  }

  return counts.map((attempts, hour) => ({ hour, attempts }));
};

/**
 * Platform overview. Two rows in this payload are deliberately absent rather
 * than invented: pending-payment history and refunds are not stored, so the
 * response marks the first with no comparison and the second as unsupported.
 */
export const getOverview = async (
  range: DashboardRange,
  capabilities: DashboardCapabilities
): Promise<OverviewResponse> => {
  const now = new Date();
  const nowIso = now.toISOString();
  const todayStart = dhakaDayStart(now);
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
  const activeSince = new Date(now.getTime() - 86_400_000).toISOString();
  const previousActiveSince = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  const inExamSince = new Date(now.getTime() - IN_EXAM_WINDOW_MS).toISOString();
  const truncated: string[] = [];

  const [
    totalUsers,
    usersBeforeRange,
    activeUsers,
    previousActiveUsers,
    totalQuestions,
    previousQuestions,
    totalExams,
    previousExams,
    activeSubscriptions,
    previousSubscriptions,
    pendingPayments,
    examsToday,
    examsYesterday,
    paidRows,
    paidBeforeRows,
    pendingReview,
    flaggedQuestions,
    reportedMessages,
    pendingTickets,
    pendingExports,
    liveExamRows,
    inExamRows,
    activeGroups,
    ongoingBattles,
    focusSessions,
    recentRegistrationRows,
    recentPurchaseRows,
    settingsResult,
    policyResult,
  ] = await Promise.all([
    readCount(
      supabase.from('profiles').select('*', { count: 'exact', head: true }).is('deleted_at', null),
      'total users'
    ),
    readCount(
      supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .lt('created_at', range.fromIso)
        .is('deleted_at', null),
      'users before range'
    ),
    readCount(
      supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('account_status', 'active')
        .gte('last_active_at', activeSince),
      'active users'
    ),
    readCount(
      supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('account_status', 'active')
        .gte('last_active_at', previousActiveSince)
        .lt('last_active_at', activeSince),
      'previous active users'
    ),
    readCount(
      supabase.from('questions').select('*', { count: 'exact', head: true }).is('deleted_at', null),
      'total questions'
    ),
    readCount(
      supabase
        .from('questions')
        .select('*', { count: 'exact', head: true })
        .lt('created_at', range.fromIso)
        .is('deleted_at', null),
      'questions before range'
    ),
    readCount(supabase.from('exam_papers').select('*', { count: 'exact', head: true }), 'total exams'),
    readCount(
      supabase.from('exam_papers').select('*', { count: 'exact', head: true }).lt('created_at', range.fromIso),
      'exams before range'
    ),
    readCount(
      supabase
        .from('user_subscriptions')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'active')
        .gt('end_date', nowIso),
      'active subscriptions'
    ),
    readCount(
      supabase
        .from('user_subscriptions')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'active')
        .lte('start_date', range.fromIso)
        .gt('end_date', range.fromIso),
      'subscriptions at period start'
    ),
    readCount(
      supabase.from('payment_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      'pending payments'
    ),
    readCount(
      supabase
        .from('exam_history')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', todayStart.toISOString()),
      'exams today'
    ),
    readCount(
      supabase
        .from('exam_history')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', yesterdayStart.toISOString())
        .lt('created_at', todayStart.toISOString()),
      'exams yesterday'
    ),
    readMoneyRows(
      supabase.from('payment_requests').select('amount').eq('status', 'paid').limit(SERIES_LIMIT),
      'confirmed revenue'
    ),
    readMoneyRows(
      supabase
        .from('payment_requests')
        .select('amount')
        .eq('status', 'paid')
        .lt('updated_at', range.fromIso)
        .limit(SERIES_LIMIT),
      'revenue before range'
    ),
    readCount(
      supabase
        .from('questions')
        .select('*', { count: 'exact', head: true })
        .in('status', ['pending', 'review'])
        .is('deleted_at', null),
      'pending question reviews'
    ),
    readCount(
      supabase
        .from('questions')
        .select('*', { count: 'exact', head: true })
        .or('status.eq.flagged,confidence_score.lt.0.5')
        .is('deleted_at', null),
      'flagged questions'
    ),
    readCount(
      supabase.from('flagged_messages').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      'reported messages'
    ),
    readCount(
      supabase.from('user_reports').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      'pending support tickets'
    ),
    readCount(
      supabase.from('report_exports').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      'pending exports'
    ),
    readFiltered(
      () =>
        supabase
          .from('exam_papers')
          .select('id,title,title_en,start_time,end_time')
          .eq('is_published', true)
          .lte('start_time', nowIso)
          .gte('end_time', nowIso)
          .order('start_time', { ascending: false })
          .limit(10),
      'live exams'
    ),
    readFiltered(
      () =>
        supabase
          .from('exam_progress')
          .select('exam_id,user_id,last_updated_at')
          .eq('status', 'in_progress')
          .gte('last_updated_at', inExamSince)
          .limit(5_000),
      'students in exams'
    ),
    readCount(
      supabase.from('study_groups').select('*', { count: 'exact', head: true }).eq('is_active', true),
      'active groups'
    ),
    readCount(
      supabase.from('group_battles').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      'ongoing battles'
    ),
    readCount(
      supabase.from('group_focus_sessions').select('*', { count: 'exact', head: true }).gt('end_time', nowIso),
      'focus sessions'
    ),
    readRows('profiles', 'id,full_name,username,created_at', 'recent registrations', 5),
    readMoneyRows(
      supabase
        .from('payment_requests')
        .select('id,user_id,amount,plan_id,updated_at')
        .eq('status', 'paid')
        .order('updated_at', { ascending: false })
        .limit(5),
      'recent purchases'
    ),
    supabase
      .from('app_configs')
      .select('maintenance_mode,min_app_version')
      .eq('key', 'global_settings')
      .maybeSingle(),
    supabase.from('app_configs').select('value').eq('key', UPDATE_POLICY_KEY).maybeSingle(),
  ]);

  if (paidRows.length >= SERIES_LIMIT) truncated.push('confirmed revenue');
  if (paidBeforeRows.length >= SERIES_LIMIT) truncated.push('historical revenue');
  if (inExamRows.length >= 5_000) truncated.push('students in exams');

  // Only exams whose window contains "now" are live. The rows below are
  // bounded and the participant counts come from one grouped read instead of
  // one query per exam (no N+1).
  const liveNow = new Date();
  const activeExamRows = liveExamRows.filter((row) => {
    const start = text(row.start_time);
    const end = text(row.end_time);
    return start !== '' && end !== '' && Date.parse(start) <= liveNow.getTime() && Date.parse(end) >= liveNow.getTime();
  });

  const participantsByExam = new Map<string, number>();
  let studentsInExams = 0;

  for (const row of inExamRows) {
    const updatedAt = text(row.last_updated_at);
    if (updatedAt && Date.parse(updatedAt) < Date.now() - IN_EXAM_WINDOW_MS) continue;
    const examId = text(row.exam_id);
    if (examId === '') continue;
    participantsByExam.set(examId, (participantsByExam.get(examId) ?? 0) + 1);
    studentsInExams += 1;
  }

  const purchaseUserIds = Array.from(
    new Set(recentPurchaseRows.map((row) => text(row.user_id)).filter((id) => id !== ''))
  );
  const purchaseNames = new Map<string, string>();

  if (purchaseUserIds.length > 0) {
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id,full_name,username')
      .in('id', purchaseUserIds);

    if (error) fail('recent purchaser names', error);
    for (const profile of (profiles ?? []) as unknown as Row[]) {
      purchaseNames.set(text(profile.id), displayName(profile));
    }
  }

  const settings = (settingsResult.data ?? {}) as Row;
  const policy = parseUpdatePolicy(policyResult.data?.value);
  const maintenanceMode = settings.maintenance_mode === true;

  const revenue = sumAmounts(paidRows);
  const previousRevenue = sumAmounts(paidBeforeRows);
  const periodLabel = range.days === 1 ? 'the previous day' : `the previous ${range.days} days`;

  return {
    generatedAt: nowIso,
    range: {
      fromIso: range.fromIso,
      toIso: range.toIso,
      bucket: range.bucket,
      days: range.days,
    },
    platform: {
      status: maintenanceMode ? 'maintenance' : 'operational',
      maintenanceMode,
      minAppVersion: typeof settings.min_app_version === 'string' ? settings.min_app_version : null,
      latestNativeVersion: policy.latest_native_version || null,
      latestOtaVersion: policy.latest_ota_version || null,
    },
    stats: {
      totalUsers: buildMetric(totalUsers, usersBeforeRange, 'added this period', 'all_time'),
      activeUsers: buildMetric(activeUsers, previousActiveUsers, 'vs previous 24h', 'live'),
      totalQuestions: buildMetric(totalQuestions, previousQuestions, 'added this period', 'all_time'),
      totalExams: buildMetric(totalExams, previousExams, 'added this period', 'all_time'),
      activeSubscriptions: buildMetric(
        activeSubscriptions,
        previousSubscriptions,
        'vs period start',
        'all_time'
      ),
      totalRevenue: buildMetric(revenue, previousRevenue, `vs before ${periodLabel}`, 'all_time'),
      pendingPayments: buildMetric(pendingPayments, null, 'live approval queue', 'live'),
      examsToday: buildMetric(examsToday, examsYesterday, 'vs yesterday', 'live'),
    },
    actionCenter: [
      {
        id: 'payments',
        label: 'Payment approvals',
        count: pendingPayments,
        priority: 'critical',
        href: '/finance?tab=payments',
      },
      {
        id: 'flagged-questions',
        label: 'Flagged questions',
        count: flaggedQuestions,
        priority: 'high',
        href: '/content?tab=audit',
      },
      {
        id: 'question-reviews',
        label: 'Questions awaiting review',
        count: pendingReview,
        priority: 'medium',
        href: '/content?tab=audit',
      },
      {
        id: 'reported-messages',
        label: 'Reported community messages',
        count: reportedMessages,
        priority: 'high',
        href: '/community?tab=monitor',
      },
      {
        id: 'support-tickets',
        label: 'Pending support tickets',
        count: pendingTickets,
        priority: 'medium',
        href: '/system?tab=support',
      },
      {
        id: 'exports',
        label: 'Pending data exports',
        count: pendingExports,
        priority: 'low',
        href: '/enterprise?tab=reports',
      },
    ],
    live: {
      activeExams: activeExamRows.map((row) => ({
        id: text(row.id),
        title: text(row.title_en) || text(row.title) || text(row.id),
        participants: participantsByExam.get(text(row.id)) ?? 0,
      })),
      studentsInExams,
      activeGroups,
      ongoingBattles,
      focusSessions,
      recentRegistrations: recentRegistrationRows.map((row) => ({
        id: text(row.id),
        name: displayName(row),
        at: text(row.created_at),
      })),
      recentPurchases: recentPurchaseRows.map((row) => ({
        id: text(row.id),
        name: purchaseNames.get(text(row.user_id)) ?? 'Unknown learner',
        amount: roundMoney(numberOf(row.amount)),
        at: text(row.updated_at),
      })),
    },
    capabilities,
    freshness: { overviewSeconds: 30, liveSeconds: 30 },
    truncated,
  };
};

const titleMap = async (examIds: string[]): Promise<Map<string, string>> => {
  if (examIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from('exam_papers')
    .select('id,title,title_en')
    .in('id', examIds);

  if (error) fail('exam titles', error);

  const map = new Map<string, string>();
  for (const row of (data ?? []) as unknown as Row[]) {
    map.set(text(row.id), text(row.title_en) || text(row.title) || text(row.id));
  }
  return map;
};

export const getAnalytics = async (range: DashboardRange): Promise<AnalyticsResponse> => {
  const now = new Date();
  const keys = buildBucketKeys(range);
  const keyOf = range.bucket === 'hour' ? dhakaHourKey : dhakaDayKey;
  const previous = previousRange(range);
  const todayStart = dhakaDayStart(now);
  const monthStart = dhakaMonthStart(now);
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const truncated: string[] = [];

  const [
    registrationWindow,
    activityWindow,
    examWindow,
    paymentWindow,
    paidWindow,
    questionWindow,
    questionSubjectRows,
    notificationWindow,
    planRows,
    subjectRows,
    groupRows,
    dau,
    wau,
    mau,
    premiumCount,
    freeCount,
    totalProfiles,
    previousRegistrations,
    totalQuestions,
    liveCount,
    upcomingCount,
    pendingReview,
    aiFlagged,
    addedToday,
    scheduledCount,
    monthPaidRows,
    todayPaidRows,
    reviewWindow,
    recentActivityRows,
  ] = await Promise.all([
    readWindow('profiles', 'created_at', 'created_at', range.fromIso, range.toIso, 'registrations'),
    readWindow('user_daily_activities', 'user_id,activity_date', 'activity_date', dhakaDayKey(range.from), dhakaDayKey(range.to), 'daily activity'),
    readWindow(
      'exam_history',
      'created_at,score,total_marks,exam_id',
      'created_at',
      range.fromIso,
      range.toIso,
      'exam attempts'
    ),
    readWindow(
      'payment_requests',
      'created_at,updated_at,status,amount,plan_id',
      'created_at',
      range.fromIso,
      range.toIso,
      'payment requests'
    ),
    readWindow(
      'payment_requests',
      'updated_at,status,amount,plan_id',
      'updated_at',
      range.fromIso,
      range.toIso,
      'confirmed payments'
    ),
    readWindow(
      'questions',
      'created_at,subject_id,status',
      'created_at',
      range.fromIso,
      range.toIso,
      'new questions'
    ),
    readRows('questions', 'subject_id', 'questions by subject', SERIES_LIMIT),
    supabase
      .from('notifications')
      .select('created_at,status,total_sent,delivered_count,failed_count,title_bn,title_en,sent_at,target_user_id,created_by')
      .or('created_by.not.is.null,target_user_id.is.null')
      .gte('created_at', range.fromIso)
      .lt('created_at', range.toIso)
      .order('created_at', { ascending: true })
      .limit(SERIES_LIMIT),
    readRows('subscription_plans', 'id,name,name_en', 'subscription plans', 200),
    readRows('subjects', 'id,name_bn,name_en', 'subjects', 500),
    readFiltered(
      () =>
        supabase
          .from('study_groups')
          .select('id,name,member_count,total_xp')
          .order('total_xp', { ascending: false })
          .limit(500),
      'active groups'
    ),
    readCount(
      supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .gte('last_active_at', dayAgo),
      'daily active users'
    ),
    readCount(
      supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .gte('last_active_at', new Date(now.getTime() - 7 * 86_400_000).toISOString()),
      'weekly active users'
    ),
    readCount(
      supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .gte('last_active_at', new Date(now.getTime() - 30 * 86_400_000).toISOString()),
      'monthly active users'
    ),
    readCount(
      supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('subscription_status', 'premium')
        .is('deleted_at', null),
      'premium users'
    ),
    readCount(
      supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('subscription_status', 'free')
        .is('deleted_at', null),
      'free users'
    ),
    readCount(
      supabase.from('profiles').select('*', { count: 'exact', head: true }).is('deleted_at', null),
      'total profiles'
    ),
    readCount(
      supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', previous.fromIso)
        .lt('created_at', previous.toIso),
      'previous registrations'
    ),
    readCount(
      supabase.from('questions').select('*', { count: 'exact', head: true }).is('deleted_at', null),
      'total questions'
    ),
    readCount(
      supabase
        .from('exam_papers')
        .select('*', { count: 'exact', head: true })
        .eq('is_published', true)
        .lte('start_time', now.toISOString())
        .gte('end_time', now.toISOString()),
      'live exams'
    ),
    readCount(
      supabase
        .from('exam_papers')
        .select('*', { count: 'exact', head: true })
        .eq('is_published', true)
        .gt('start_time', now.toISOString()),
      'upcoming exams'
    ),
    readCount(
      supabase
        .from('questions')
        .select('*', { count: 'exact', head: true })
        .in('status', ['pending', 'review'])
        .is('deleted_at', null),
      'pending review'
    ),
    readCount(
      supabase
        .from('questions')
        .select('*', { count: 'exact', head: true })
        .or('status.eq.flagged,confidence_score.lt.0.5')
        .is('deleted_at', null),
      'AI flagged questions'
    ),
    readCount(
      supabase
        .from('questions')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', todayStart.toISOString())
        .is('deleted_at', null),
      'questions added today'
    ),
    readCount(
      supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'scheduled'),
      'scheduled notifications'
    ),
    readMoneyRows(
      supabase
        .from('payment_requests')
        .select('amount')
        .eq('status', 'paid')
        .gte('updated_at', monthStart.toISOString())
        .limit(SERIES_LIMIT),
      'monthly revenue'
    ),
    readMoneyRows(
      supabase
        .from('payment_requests')
        .select('amount')
        .eq('status', 'paid')
        .gte('updated_at', todayStart.toISOString())
        .limit(SERIES_LIMIT),
      'today revenue'
    ),
    readWindow(
      'audit_logs',
      'created_at',
      'created_at',
      range.fromIso,
      range.toIso,
      'question review activity'
    ),
    supabase
      .from('audit_logs')
      .select('id,user_id,action,target_table,target_id,created_at')
      .in('target_table', ['questions', 'exam_papers'])
      .order('created_at', { ascending: false })
      .limit(5),
  ]);

  const mark = (label: string, result: WindowResult): Row[] => {
    if (result.truncated) truncated.push(label);
    return result.rows;
  };

  const registrations = mark('registrations', registrationWindow);
  const attempts = mark('exam attempts', examWindow);
  const requests = mark('payment requests', paymentWindow);
  const approvals = mark('confirmed payments', paidWindow).filter((row) => text(row.status) === 'paid');
  const newQuestions = mark('new questions', questionWindow);
  if (questionSubjectRows.length >= SERIES_LIMIT) truncated.push('questions by subject');

  const registrationSeries = bucketSeries(
    keys,
    registrations.map((row) => text(row.created_at)),
    keyOf
  );

  const totalRegistered = Math.max(0, totalProfiles - registrations.length);
  let running = totalRegistered;
  const growthSeries = registrationSeries.map((point) => {
    running += point.value;
    return { key: point.key, value: running };
  });

  const activityByUser = new Map<string, Set<string>>();
  for (const row of activityWindow.rows) {
    const userId = text(row.user_id);
    if (userId === '') continue;
    const day = text(row.activity_date);
    const days = activityByUser.get(userId) ?? new Set<string>();
    days.add(day);
    activityByUser.set(userId, days);
  }

  const activeUserCount = activityByUser.size;
  const repeatUsers = Array.from(activityByUser.values()).filter((days) => days.size >= 2).length;

  const examGroups = new Map<string, { attempts: number; score: number; total: number }>();
  for (const row of attempts) {
    const examId = text(row.exam_id);
    if (examId === '') continue;
    const entry = examGroups.get(examId) ?? { attempts: 0, score: 0, total: 0 };
    entry.attempts += 1;
    const score = numberOf(row.score);
    const total = numberOf(row.total_marks);
    if (total > 0) {
      entry.score += score;
      entry.total += total;
    }
    examGroups.set(examId, entry);
  }

  const topExamIds = Array.from(examGroups.entries())
    .sort((left, right) => right[1].attempts - left[1].attempts)
    .slice(0, 5)
    .map(([id]) => id);

  const examTitles = await titleMap(topExamIds);
  const topExams = topExamIds.map((id) => {
    const entry = examGroups.get(id);
    return {
      id,
      title: examTitles.get(id) ?? id,
      attempts: entry?.attempts ?? 0,
      averageScorePercent: entry ? percentOf(entry.score, entry.total) : null,
    };
  });

  const peakHours = roundHourSeries(attempts);

  const subjectNames = new Map<string, string>();
  for (const row of subjectRows) {
    subjectNames.set(text(row.id), text(row.name_en) || text(row.name_bn) || text(row.id));
  }

  const subjectCounts = new Map<string, number>();
  for (const row of questionSubjectRows) {
    const subjectId = text(row.subject_id) || 'unassigned';
    subjectCounts.set(subjectId, (subjectCounts.get(subjectId) ?? 0) + 1);
  }

  const bySubject = Array.from(subjectCounts.entries())
    .map(([subjectId, count]) => ({
      subjectId: subjectId === 'unassigned' ? null : subjectId,
      name: subjectNames.get(subjectId) ?? (subjectId === 'unassigned' ? 'Unassigned' : subjectId),
      count,
    }))
    .sort((left, right) => right.count - left.count);

  const planNames = new Map<string, string>();
  for (const row of planRows) {
    planNames.set(text(row.id), text(row.name_en) || text(row.name) || text(row.id));
  }

  const paymentSummary = summarizePayments(requests as unknown as PaymentAmountRow[]);
  const revenueSeries = sumBucketSeries(
    keys,
    approvals,
    (row) => keyOf(text(row.updated_at) || text(row.created_at)),
    (row) => numberOf(row.amount)
  );

  const planTotals = new Map<string, { revenue: number; payments: number }>();
  for (const row of approvals) {
    const planId = text(row.plan_id) || 'unknown';
    const entry = planTotals.get(planId) ?? { revenue: 0, payments: 0 };
    entry.revenue += numberOf(row.amount);
    entry.payments += 1;
    planTotals.set(planId, entry);
  }

  const byPlan = Array.from(planTotals.entries())
    .map(([planId, entry]) => ({
      planId,
      name: planNames.get(planId) ?? (planId === 'unknown' ? 'Unassigned plan' : planId),
      revenue: roundMoney(entry.revenue),
      payments: entry.payments,
    }))
    .sort((left, right) => right.revenue - left.revenue);

  const notificationRows = (notificationWindow.data ?? []) as unknown as Row[];
  if (notificationRows.length >= SERIES_LIMIT) truncated.push('notifications');

  let accepted = 0;
  let delivered = 0;
  let failedDeliveries = 0;
  let sentCampaigns = 0;

  for (const row of notificationRows) {
    if (text(row.status) === 'sent') sentCampaigns += 1;
    accepted += Math.max(0, numberOf(row.total_sent));
    delivered += Math.max(0, numberOf(row.delivered_count));
    failedDeliveries += Math.max(0, numberOf(row.failed_count));
  }

  const recentNotifications = notificationRows
    .slice()
    .sort((left, right) => Date.parse(text(right.created_at)) - Date.parse(text(left.created_at)))
    .slice(0, 5)
    .map((row) => ({
      id: text(row.id),
      title: text(row.title_en) || text(row.title_bn) || 'Untitled notification',
      status: text(row.status) || 'unknown',
      sentAt: text(row.sent_at) || null,
      accepted: Math.max(0, numberOf(row.total_sent)),
      delivered: Math.max(0, numberOf(row.delivered_count)),
      failed: Math.max(0, numberOf(row.failed_count)),
    }));

  const recentContent = (recentActivityRows.data ?? []) as unknown as Row[];
  const recentReviews = mark('review activity', reviewWindow);

  return {
    generatedAt: now.toISOString(),
    range: {
      fromIso: range.fromIso,
      toIso: range.toIso,
      bucket: range.bucket,
      days: range.days,
    },
    users: {
      dau,
      wau,
      mau,
      // Repeat activity: share of active learners who studied on 2+ days.
      retentionRate: percentOf(repeatUsers, activeUserCount),
      freeVsPremium: {
        free: freeCount,
        premium: premiumCount,
        other: Math.max(0, totalProfiles - freeCount - premiumCount),
      },
      registrationSeries,
      growthSeries,
    },
    exams: {
      totalAttempts: attempts.length,
      liveCount,
      upcomingCount,
      averageScorePercent:      averageScorePercent(
        attempts as unknown as Array<{
          score?: number | string | null;
          total_marks?: number | string | null;
        }>
      ),
      participationSeries: bucketSeries(
        keys,
        attempts.map((row) => text(row.created_at)),
        keyOf
      ),
      topExams,
      peakHours,
    },
    revenue: {
      gross: paymentSummary.gross,
      confirmed: paymentSummary.confirmed,
      pending: paymentSummary.pending,
      failed: paymentSummary.failed,
      today: sumAmounts(todayPaidRows),
      thisMonth: sumAmounts(monthPaidRows),
      confirmedCount: paymentSummary.confirmedCount,
      pendingCount: paymentSummary.pendingCount,
      failedCount: paymentSummary.failedCount,
      refundsSupported: false,
      series: revenueSeries,
      byPlan,
    },
    content: {
      total: totalQuestions,
      addedInRange: newQuestions.length,
      addedToday,
      pendingReview,
      aiFlagged,
      bySubject,
      recent: recentContent.map((row) => ({
        id: text(row.id),
        action: text(row.action),
        targetId: text(row.target_id),
        at: text(row.created_at),
      })),
    },
    notifications: {
      totalSent: sentCampaigns,
      accepted,
      delivered,
      failed: failedDeliveries,
      unknown: Math.max(0, accepted - delivered - failedDeliveries),
      deliveryRate: percentOf(delivered, accepted),
      scheduled: scheduledCount,
      recent: recentNotifications,
    },
    insights: {
      topSubjects: bySubject.slice(0, 5).map((row) => ({ name: row.name, count: row.count })),
      topExams: topExams.map((row) => ({ title: row.title, attempts: row.attempts })),
      topPlans: byPlan.slice(0, 3).map((row) => ({
        name: row.name,
        revenue: row.revenue,
        payments: row.payments,
      })),
      peakHours: peakHours
        .slice()
        .sort((left, right) => right.attempts - left.attempts)
        .slice(0, 3),
      reviewActivity: bucketSeries(
        keys,
        recentReviews.map((row) => text(row.created_at)),
        keyOf
      ),
      mostActiveGroups: groupRows
        .slice()
        .sort((left, right) => numberOf(right.total_xp) - numberOf(left.total_xp))
        .slice(0, 5)
        .map((row) => ({
          id: text(row.id),
          name: text(row.name) || 'Untitled group',
          members: numberOf(row.member_count),
          xp: numberOf(row.total_xp),
        })),
    },
    truncated,
  };
};

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

interface Probe {
  latencyMs: number;
  error: string | null;
  result: unknown;
}

const probe = async (work: () => PromiseLike<unknown>): Promise<Probe> => {
  const started = Date.now();
  try {
    const result = await withTimeout(Promise.resolve(work()), HEALTH_TIMEOUT_MS);
    return { latencyMs: Date.now() - started, error: null, result };
  } catch (error) {
    return {
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'probe failed',
      result: null,
    };
  }
};

const probeStatus = (result: Probe, degradedAboveMs = 1_200) => {
  if (result.error) return 'unavailable' as const;
  return result.latencyMs > degradedAboveMs ? ('degraded' as const) : ('healthy' as const);
};

const probeDetail = (result: Probe, healthyDetail: string): string =>
  result.error ? `Check failed: ${result.error}` : healthyDetail;

export const getHealth = async (role: string): Promise<HealthResponse> => {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();

  const [database, api, auth, media, pushFailures, configs] = await Promise.all([
    probe(() => supabase.from('profiles').select('id', { count: 'exact', head: true }).limit(1)),
    probe(() => supabase.from('app_configs').select('key').limit(1)),
    probe(() => supabase.auth.admin.listUsers({ page: 1, perPage: 1 })),
    probe(() =>
      supabase.from('media_library').select('id', { count: 'exact', head: true }).is('deleted_at', null).limit(1)
    ),
    probe(() =>
      supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'failed')
        .gte('created_at', dayAgo)
    ),
    probe(() =>
      supabase
        .from('app_configs')
        .select('key,value,maintenance_mode,min_app_version')
        .in('key', ['global_settings', UPDATE_POLICY_KEY])
    ),
  ]);

  const configRows = (configs.result ?? []) as Row[];
  const globalSettings = configRows.find((row) => text(row.key) === 'global_settings') ?? {};
  const policy = parseUpdatePolicy(
    configRows.find((row) => text(row.key) === UPDATE_POLICY_KEY)?.value
  );

  const mediaRows = (media.result ?? null) as { count?: number | null } | null;
  const pushRows = (pushFailures.result ?? null) as { count?: number | null } | null;
  const failures = Math.max(0, Number(pushRows?.count ?? 0));

  const cloudinaryConfigured = Boolean(
    process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY
  );
  const firebaseConfigured = Boolean(
    process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY
  );

  const databaseStatus = probeStatus(database);
  const services: HealthService[] = [
    {
      id: 'api',
      label: 'Backend API',
      status: 'healthy',
      detail: 'Responding to dashboard requests',
      latencyMs: null,
    },
    {
      id: 'supabase',
      label: 'Supabase connectivity',
      status: probeStatus(api),
      detail: probeDetail(api, 'REST endpoint reachable'),
      latencyMs: api.latencyMs,
    },
    {
      id: 'database',
      label: 'Database',
      status: databaseStatus,
      detail: probeDetail(database, `${database.latencyMs} ms round trip`),
      latencyMs: database.latencyMs,
    },
    {
      id: 'auth',
      label: 'Authentication',
      status: probeStatus(auth),
      detail: probeDetail(auth, 'Auth admin API reachable'),
      latencyMs: auth.latencyMs,
    },
    {
      id: 'push',
      label: 'Push notifications',
      status: !firebaseConfigured ? 'unknown' : failures > 5 ? 'degraded' : 'healthy',
      detail: firebaseConfigured
        ? `${failures} failed send${failures === 1 ? '' : 's'} in the last 24h`
        : 'FCM is not configured for this environment',
      latencyMs: null,
    },
    {
      id: 'storage',
      label: 'Media storage',
      status: media.error
        ? 'unavailable'
        : !cloudinaryConfigured
          ? 'unknown'
          : 'healthy',
      detail: media.error
        ? probeDetail(media, '')
        : `${Number(mediaRows?.count ?? 0)} indexed assets${
            cloudinaryConfigured ? '' : ' · Cloudinary not configured'
          }`,
      latencyMs: media.latencyMs,
    },
    {
      id: 'ota',
      label: 'OTA bundle',
      status: configs.error ? 'unknown' : 'healthy',
      detail: configs.error
        ? probeDetail(configs, '')
        : policy.latest_ota_version || 'No OTA bundle published',
      latencyMs: configs.latencyMs,
    },
    {
      id: 'app-version',
      label: 'Latest app version',
      status: typeof globalSettings.min_app_version === 'string' ? 'healthy' : 'unknown',
      detail:
        typeof globalSettings.min_app_version === 'string'
          ? `Minimum supported ${globalSettings.min_app_version}`
          : 'No minimum app version configured',
      latencyMs: null,
    },
  ];

  let security: SecuritySection | null = null;

  if (role === 'super_admin') {
    const [failedLogins, suspended, devices, errors, alerts] = await Promise.all([
      readCount(
        supabase
          .from('admin_login_history')
          .select('*', { count: 'exact', head: true })
          .eq('login_status', 'failed')
          .gte('login_at', dayAgo),
        'suspicious admin logins'
      ),
      readCount(
        supabase
          .from('profiles')
          .select('*', { count: 'exact', head: true })
          .eq('account_status', 'suspended'),
        'suspended accounts'
      ),
      readRows('user_devices', 'user_id,device_id', 'shared devices', DEVICE_LIMIT),
      readCount(
        supabase
          .from('app_error_logs')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', dayAgo),
        'critical errors'
      ),
      readRows('admin_alerts', 'id,title,message,priority,type,created_at,action_link,is_read', 'security alerts', 50),
    ]);

    const usersByDevice = new Map<string, Set<string>>();
    for (const row of devices) {
      const deviceId = text(row.device_id);
      const userId = text(row.user_id);
      if (deviceId === '' || userId === '') continue;
      const users = usersByDevice.get(deviceId) ?? new Set<string>();
      users.add(userId);
      usersByDevice.set(deviceId, users);
    }

    const sharedDevices = Array.from(usersByDevice.values()).filter((users) => users.size > 1).length;

    security = {
      permitted: true,
      suspiciousLogins: failedLogins,
      highRiskAccounts: suspended,
      accountSharingAlerts: sharedDevices,
      criticalErrors: errors,
      unusualApiActivity: {
        supported: false,
        detail: 'Request-level API telemetry is not stored, so this cannot be reported.',
      },
      recentAlerts: alerts
        .filter((row) => row.is_read !== true)
        .slice(0, 5)
        .map((row) => ({
          id: text(row.id),
          title: text(row.title) || 'Alert',
          message: text(row.message),
          priority: text(row.priority) || 'info',
          type: text(row.type) || 'system',
          at: text(row.created_at),
          href: safeHref(row.action_link),
        })),
    };
  }

  return {
    generatedAt: now.toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    services,
    security,
  };
};

const activityHref = (table: string, targetId: string): string | null => {
  switch (table) {
    case 'questions':
      return '/content?tab=audit';
    case 'exam_papers':
      return '/exams?tab=manage';
    case 'user_roles':
      return '/users?tab=rbac';
    case 'profiles':
      return targetId ? `/users/${encodeURIComponent(targetId)}` : '/users';
    case 'payment_requests':
      return '/finance?tab=payments';
    case 'subscription_plans':
    case 'user_subscriptions':
      return '/monetization?tab=subscriptions';
    case 'notifications':
      return '/growth?tab=analytics';
    case 'app_configs':
      return '/system';
    case 'study_groups':
    case 'group_members':
      return '/groups';
    default:
      return null;
  }
};

export const getActivity = async (limit: number, offset: number): Promise<ActivityResponse> => {
  const capped = Math.min(Math.max(Math.trunc(limit) || 10, 1), MAX_ACTIVITY_LIMIT);
  const safeOffset = Math.max(Math.trunc(offset) || 0, 0);

  const { data, error, count } = await supabase
    .from('audit_logs')
    .select('id,user_id,action,target_table,target_id,created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(safeOffset, safeOffset + capped - 1);

  if (error) fail('recent admin activity', error);

  const rows = (data ?? []) as unknown as Row[];
  const actorIds = Array.from(
    new Set(rows.map((row) => text(row.user_id)).filter((id) => id !== ''))
  );
  const actorNames = new Map<string, string>();

  if (actorIds.length > 0) {
    const { data: profiles, error: profileError } = await supabase
      .from('profiles')
      .select('id,full_name,username')
      .in('id', actorIds);

    if (profileError) fail('activity actors', profileError);
    for (const profile of (profiles ?? []) as unknown as Row[]) {
      actorNames.set(text(profile.id), displayName(profile));
    }
  }

  const total = count ?? rows.length;

  return {
    items: rows.map((row) => {
      const actorId = text(row.user_id);
      return {
        id: text(row.id),
        actor: actorId
          ? { id: actorId, name: actorNames.get(actorId) ?? 'Unknown admin' }
          : null,
        action: text(row.action) || 'UPDATE',
        targetTable: text(row.target_table),
        targetId: text(row.target_id),
        at: text(row.created_at),
        href: activityHref(text(row.target_table), text(row.target_id)),
      };
    }),
    total,
    limit: capped,
    offset: safeOffset,
    hasMore: safeOffset + rows.length < total,
  };
};
