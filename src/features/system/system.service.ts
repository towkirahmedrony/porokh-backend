import { supabase } from '../../config/supabase';
import { supabaseAdmin } from '../../config/supabaseAdmin';
import {
  UPDATE_POLICY_KEY,
  parseUpdatePolicy,
  type UpdatePolicy,
} from './update-policy';

// ==========================================
// Home Grids (Dynamic Homepage Builder)
// ==========================================
export const getActiveHomeGrids = async () => {
  const { data, error } = await supabase
    .from('home_grids')
    .select('*')
    .eq('is_active', true)
    .order('serial_order', { ascending: true });
    
  if (error) throw error;
  return data;
};

export const upsertHomeGrid = async (gridPayload: any) => {
  const { data, error } = await supabaseAdmin.from('home_grids').upsert(gridPayload).select().single();
  if (error) throw error;
  return data;
};

export const deleteHomeGrid = async (id: string) => {
  const { error } = await supabaseAdmin.from('home_grids').delete().eq('id', id);
  if (error) throw error;
  return true;
};

export const reorderHomeGrids = async (reorderPayload: { id: string, serial_order: number }[]) => {
  for (const item of reorderPayload) {
    const { error } = await supabaseAdmin.from('home_grids').update({ serial_order: item.serial_order }).eq('id', item.id);
    if(error) throw error;
  }
  return true;
};

// ==========================================
// Global Configs & Remote Controls
// ==========================================
// Only these configuration records may be read without an admin token.
const PUBLIC_SYSTEM_CONFIG_KEYS = [
  'global_settings',
  'global_notice',
  'theme_config',
  'daily_quote',
  'xp_rules',
  UPDATE_POLICY_KEY,
] as const;

const PUBLIC_SYSTEM_CONFIG_COLUMNS =
  'key, value, maintenance_mode, maintenance_message, maintenance_message_en, is_force_update_required, min_app_version, update_redirect_url';

export const getGlobalConfigs = async () => {
  const { data, error } = await supabase
    .from('app_configs')
    .select(PUBLIC_SYSTEM_CONFIG_COLUMNS)
    .in('key', [...PUBLIC_SYSTEM_CONFIG_KEYS]);
  if (error) throw error;
  return data;
};

export const getAppConfigByKey = async (key: string) => {
  if (!(PUBLIC_SYSTEM_CONFIG_KEYS as readonly string[]).includes(key)) {
    // Fail closed for private/administrative configuration keys.
    return null;
  }

  const { data, error } = await supabase
    .from('app_configs')
    .select(PUBLIC_SYSTEM_CONFIG_COLUMNS)
    .eq('key', key)
    .maybeSingle();
  if (error) throw error;
  return data;
};

export const upsertAppConfig = async (key: string, valuePayload: any) => {
  const { data, error } = await supabaseAdmin.from('app_configs').upsert({ key, ...valuePayload }, { onConflict: 'key' }).select().single();
  if (error) throw error;
  return data;
};

export const getUpdatePolicy = async (): Promise<UpdatePolicy> => {
  const { data, error } = await supabase
    .from('app_configs')
    .select('value')
    .eq('key', UPDATE_POLICY_KEY)
    .maybeSingle();

  // A missing row is the normal state before any admin has saved a policy.
  if (error && error.code !== 'PGRST116') throw error;
  return parseUpdatePolicy(data?.value);
};

/**
 * Where the public build identities are published. Both documents are already
 * public and are exactly what the clients read, so nothing secret is involved.
 */
const PRODUCTION_WEB_URL = 'https://porokhbd.vercel.app';
const OTA_POINTER_URL =
  'https://raw.githubusercontent.com/towkirahmedrony/porokh-ota/main/channels/production-android.json';

const VERSION_STATUS_TTL_MS = 30_000;

let versionStatusCache: { at: number; value: VersionStatus } | null = null;

export type VersionStatus = {
  website: { version: string; buildId: string | null; builtAt: string | null } | null;
  ota: {
    version: string;
    minNativeVersion: string | null;
    publishedAt: string | null;
  } | null;
  policy: UpdatePolicy;
};

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'porokh-backend',
    },
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) return null;
  return (await response.json()) as unknown;
};

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/**
 * Snapshot of the currently published identities, for the admin panel.
 *
 * Read-only and best-effort: a GitHub/Vercel hiccup must render as "unknown"
 * in the admin UI, never as a failed settings page.
 */
export const getVersionStatus = async (): Promise<VersionStatus> => {
  const cached = versionStatusCache;
  if (cached && Date.now() - cached.at < VERSION_STATUS_TTL_MS) {
    return cached.value;
  }

  const [webRaw, otaRaw, policy] = await Promise.all([
    fetchJson(`${PRODUCTION_WEB_URL}/version.json`).catch(() => null),
    fetchJson(OTA_POINTER_URL).catch(() => null),
    getUpdatePolicy(),
  ]);

  const web = (webRaw ?? {}) as Record<string, unknown>;
  const ota = (otaRaw ?? {}) as Record<string, unknown>;

  const value: VersionStatus = {
    website: str(web.version)
      ? {
          version: str(web.version) as string,
          buildId: str(web.buildId),
          builtAt: str(web.builtAt),
        }
      : null,
    ota: str(ota.version)
      ? {
          version: str(ota.version) as string,
          minNativeVersion: str(ota.minNativeVersion),
          publishedAt: str(ota.publishedAt),
        }
      : null,
    policy,
  };

  versionStatusCache = { at: Date.now(), value };
  return value;
};

export const getGlobalThemeConfig = async () => {
  const { data, error } = await supabase
    .from('app_configs')
    .select('value')
    .eq('key', 'theme_config') // 🟢 FIXED KEY
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data?.value || null;
};

// ==========================================
// XP Rules (New specific service)
// ==========================================
export const updateXPRules = async (rules: any) => {
  const { data, error } = await supabaseAdmin
    .from('app_configs')
    .upsert({ key: 'xp_rules', value: rules }, { onConflict: 'key' })
    .select()
    .single();

  if (error) throw error;
  return data;
};

// ==========================================
// Emergency Flags (Kill Switches)
// ==========================================
export const getEmergencyFlags = async () => {
  const { data, error } = await supabase.from('emergency_flags').select('*').order('key', { ascending: true });
  if (error) throw error;
  return data;
};

export const createEmergencyFlag = async (flagPayload: any) => {
  const { data, error } = await supabaseAdmin.from('emergency_flags').insert(flagPayload).select().single();
  if (error) throw error;
  return data;
};

export const toggleEmergencyFlag = async (key: string, is_active: boolean) => {
  const { data, error } = await supabaseAdmin
    .from('emergency_flags')
    .update({ is_active, activated_at: is_active ? new Date().toISOString() : null })
    .eq('key', key)
    .select()
    .single();
  if (error) throw error;
  return data;
};

// ==========================================
// Support Desk (User Reports)
// ==========================================
export const getSupportTickets = async () => {
  const { data, error } = await supabase.from('user_reports').select(`*, profiles!fk_reporter_user(full_name)`).order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const updateSupportTicket = async (id: string, updates: any) => {
  const { data, error } = await supabaseAdmin.from('user_reports').update(updates).eq('id', id).select().single();
  if (error) throw error;
  return data;
};

// ==========================================
// Audit Logs
// ==========================================
export const getAuditLogs = async () => {
  const { data, error } = await supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return data;
};

export const createAuditLog = async (adminId: string, action: string, targetTable: string, targetId: string, details: any) => {
  const { error } = await supabaseAdmin.from('audit_logs').insert({ user_id: adminId, action, target_table: targetTable, target_id: targetId, details });
  if (error) console.error('Failed to create audit log:', error);
};

// ==========================================
// Admin Action Center (Alerts)
// ==========================================
export const getAdminAlerts = async () => {
  const { data, error } = await supabase.from('admin_alerts').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const resolveAdminAlert = async (id: string, adminId: string) => {
  const { data, error } = await supabaseAdmin.from('admin_alerts').update({ is_read: true, status: 'resolved', resolved_by: adminId, resolved_at: new Date().toISOString() }).eq('id', id).select().single();
  if (error) throw error;
  return data;
};

// ==========================================
// Global Notice (Merged from Admin System)
// ==========================================
export const updateGlobalNotice = async (noticeData: any) => {
  const { data, error } = await supabaseAdmin
    .from('app_configs')
    .upsert({ key: 'global_notice', value: noticeData }, { onConflict: 'key' })
    .select()
    .single();

  if (error) throw error;
  return data;
};
