import type { Database } from '../../types/database.type';

export type UserProfile = Database['public']['Tables']['profiles']['Row'];
export type Device = Database['public']['Tables']['user_devices']['Row'];
export type CoinTransaction = Database['public']['Tables']['coin_transactions']['Row'];
export type PaymentRequest = Database['public']['Tables']['payment_requests']['Row'];

export const ACCOUNT_STATUSES = ['active', 'suspended', 'deleted'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * Directory access filters. These describe recorded facts, not a computed
 * entitlement: `premium` is the profiles.subscription_status flag, `grant` is an
 * active user-scoped access grant and `unlimited` is an active unlimited-quota
 * grant. The authoritative entitlement for one user is still
 * get_quota_status()/get_user_access() (see access.service.ts).
 */
export const ACCESS_FILTERS = ['all', 'premium', 'free', 'grant', 'unlimited'] as const;
export type AccessFilter = (typeof ACCESS_FILTERS)[number];

export const DIRECTORY_SORTS = ['created_at', 'last_active_at', 'full_name', 'total_xp'] as const;
export type DirectorySort = (typeof DIRECTORY_SORTS)[number];

export interface DirectoryQuery {
  page: number;
  page_size: number;
  q: string;
  status: AccountStatus | 'all';
  access: AccessFilter;
  role: string | 'all';
  created_from?: string;
  created_to?: string;
  sort: DirectorySort;
  direction: 'asc' | 'desc';
}

export interface DirectoryAccess {
  subscription_status: string | null;
  subscription_premium: boolean;
  active_grant_count: number;
  premium_grant: boolean;
  unlimited_features: string[] | null;
  unlimited_all: boolean;
  access_expires_at: string | null;
}

export interface DirectoryRow {
  id: string;
  full_name: string | null;
  email: string | null;
  username: string | null;
  phone_number: string | null;
  account_status: string | null;
  role: string;
  class_level: string | null;
  institution: string | null;
  created_at: string | null;
  last_active_at: string | null;
  total_xp: number | null;
  coin_balance: number | null;
  current_streak: number | null;
  access: DirectoryAccess;
}

export interface DirectoryResult {
  items: DirectoryRow[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

export interface User360Response {
  profile: UserProfile;
  role: string;
  access: {
    tier: string;
    premium: boolean;
    source: string;
    premium_expires_at: string | null;
    unlimited_all: boolean;
    unlimited_features: string[] | null;
  };
  recent_exams: any[];
  exam_stats: {
    total_exams: number;
    total_correct: number;
    total_wrong: number;
    accuracy_rate: number;
    avg_time_taken_mins: number;
    strong_subjects: string[];
    weak_subjects: string[];
  };
  academic_engagement: {
    bookmarks_count: number;
    wrong_answers_count: number;
  };
  support_activity: {
    reports_submitted: number;
    questions_created: number;
  };
  group_details: any;
  pvp_stats: {
    played: number;
    won: number;
  };
  subscription_history: any[];
  coin_transactions: CoinTransaction[];
  fiat_payments: PaymentRequest[];
  quests: any[];
  devices: Device[];
  support_tickets: any[];
  warnings: any[];
  audit_logs: any[];
  security_events: any[];
  risk: {
    level: 'high' | 'medium' | 'info' | 'none';
    signals: Array<{ code: string; level: string; label: string; detail: string }>;
  };
}

export interface RoleSummary {
  role: string;
  label: string;
  description: string;
  users: number;
  permissions: string[];
  /** Permission the acting administrator needs before assigning this role. */
  required_permission: string | null;
}

export interface RolesOverview {
  actor: { role: string | null; permissions: string[] };
  roles: RoleSummary[];
  permissions: Array<{ action: string; description: string | null; roles: string[] }>;
}

/** HTTP-facing error for the users admin surface (mirrors AccessError). */
export class UsersAdminError extends Error {
  status: number;
  code: string;
  details?: unknown;
  /** Messages are hand-written constants, so even a 503 can be shown to the operator. */
  exposeMessage = true;

  constructor(message: string, status = 400, code = 'VALIDATION_FAILED', details?: unknown) {
    super(message);
    this.name = 'UsersAdminError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
