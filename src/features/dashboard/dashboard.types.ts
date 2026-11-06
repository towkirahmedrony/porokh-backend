import type { DashboardBucket, DatePoint } from './dashboard.metrics';

export type DashboardServiceStatus = 'healthy' | 'degraded' | 'unavailable' | 'unknown';
export type MetricScope = 'all_time' | 'range' | 'live';
export type ActionPriority = 'critical' | 'high' | 'medium' | 'low';

export interface DashboardMetric {
  value: number;
  previous: number | null;
  changePercent: number | null;
  comparisonLabel: string;
  scope: MetricScope;
  note?: string;
}

export interface DashboardRangeMeta {
  fromIso: string;
  toIso: string;
  bucket: DashboardBucket;
  days: number;
}

export interface DashboardCapabilities {
  auditLogs: boolean;
  securityAlerts: boolean;
  finance: boolean;
}

export interface ActionCenterItem {
  id: string;
  label: string;
  count: number;
  priority: ActionPriority;
  href: string;
}

export interface LiveExam {
  id: string;
  title: string;
  participants: number;
}

export interface LiveActivity {
  activeExams: LiveExam[];
  studentsInExams: number;
  activeGroups: number;
  ongoingBattles: number;
  focusSessions: number;
  recentRegistrations: Array<{ id: string; name: string; at: string }>;
  recentPurchases: Array<{ id: string; name: string; amount: number; at: string }>;
}

export interface OverviewStats {
  totalUsers: DashboardMetric;
  activeUsers: DashboardMetric;
  totalQuestions: DashboardMetric;
  totalExams: DashboardMetric;
  activeSubscriptions: DashboardMetric;
  totalRevenue: DashboardMetric;
  pendingPayments: DashboardMetric;
  examsToday: DashboardMetric;
}

export interface OverviewResponse {
  generatedAt: string;
  range: DashboardRangeMeta;
  platform: {
    status: 'operational' | 'maintenance';
    maintenanceMode: boolean;
    minAppVersion: string | null;
    latestNativeVersion: string | null;
    latestOtaVersion: string | null;
  };
  stats: OverviewStats;
  actionCenter: ActionCenterItem[];
  live: LiveActivity;
  capabilities: DashboardCapabilities;
  freshness: { overviewSeconds: number; liveSeconds: number };
  truncated: string[];
}

export interface AnalyticsResponse {
  generatedAt: string;
  range: DashboardRangeMeta;
  users: {
    dau: number;
    wau: number;
    mau: number;
    retentionRate: number | null;
    freeVsPremium: { free: number; premium: number; other: number };
    registrationSeries: DatePoint[];
    growthSeries: DatePoint[];
  };
  exams: {
    totalAttempts: number;
    liveCount: number;
    upcomingCount: number;
    averageScorePercent: number | null;
    participationSeries: DatePoint[];
    topExams: Array<{ id: string; title: string; attempts: number; averageScorePercent: number | null }>;
    peakHours: Array<{ hour: number; attempts: number }>;
  };
  revenue: {
    gross: number;
    confirmed: number;
    pending: number;
    failed: number;
    today: number;
    thisMonth: number;
    confirmedCount: number;
    pendingCount: number;
    failedCount: number;
    refundsSupported: boolean;
    series: DatePoint[];
    byPlan: Array<{ planId: string; name: string; revenue: number; payments: number }>;
  };
  content: {
    total: number;
    addedInRange: number;
    addedToday: number;
    pendingReview: number;
    aiFlagged: number;
    bySubject: Array<{ subjectId: string | null; name: string; count: number }>;
    recent: Array<{ id: string; action: string; targetId: string; at: string }>;
  };
  notifications: {
    totalSent: number;
    accepted: number;
    delivered: number;
    failed: number;
    unknown: number;
    deliveryRate: number | null;
    scheduled: number;
    recent: Array<{
      id: string;
      title: string;
      status: string;
      sentAt: string | null;
      accepted: number;
      delivered: number;
      failed: number;
    }>;
  };
  insights: {
    topSubjects: Array<{ name: string; count: number }>;
    topExams: Array<{ title: string; attempts: number }>;
    topPlans: Array<{ name: string; revenue: number; payments: number }>;
    peakHours: Array<{ hour: number; attempts: number }>;
    reviewActivity: DatePoint[];
    mostActiveGroups: Array<{ id: string; name: string; members: number; xp: number }>;
  };
  truncated: string[];
}

export interface HealthService {
  id: string;
  label: string;
  status: DashboardServiceStatus;
  detail: string;
  latencyMs: number | null;
}

export interface SecuritySection {
  permitted: boolean;
  suspiciousLogins: number;
  highRiskAccounts: number;
  accountSharingAlerts: number;
  criticalErrors: number;
  unusualApiActivity: { supported: boolean; detail: string };
  recentAlerts: Array<{
    id: string;
    title: string;
    message: string;
    priority: string;
    type: string;
    at: string;
    href: string | null;
  }>;
}

export interface HealthResponse {
  generatedAt: string;
  uptimeSeconds: number;
  services: HealthService[];
  security: SecuritySection | null;
}

export interface AdminActivityItem {
  id: string;
  actor: { id: string; name: string } | null;
  action: string;
  targetTable: string;
  targetId: string;
  at: string;
  href: string | null;
}

export interface ActivityResponse {
  items: AdminActivityItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}
