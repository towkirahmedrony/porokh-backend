import { supabase } from '../../config/supabase';
import { supabaseAdmin } from '../../config/supabaseAdmin';
import { supabaseAuth } from '../../config/supabaseAuth';
import { createUserSupabaseClient } from '../../config/userSupabase';
import { Profile } from './auth.types';
import crypto from 'crypto';

/** Roles that may use the administrator login flow. */
export const ADMIN_ROLES = ['admin', 'super_admin'] as const;

/** A pending 2FA login challenge is single-use and expires after 5 minutes. */
export const LOGIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

const withoutSensitiveSettings = (profile: Record<string, any> | null): Profile => {
  if (!profile) return profile as unknown as Profile;

  const settings = profile.settings;

  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return profile as Profile;
  }

  const safeSettings = { ...settings };
  delete safeSettings.two_factor_secret;

  return { ...profile, settings: safeSettings } as Profile;
};

export const authService = {
  async revokeApplicationSession(accessToken: string): Promise<void> {
    const { error } = await createUserSupabaseClient(accessToken).rpc('revoke_current_admin_auth_session');
    if (error) throw new Error('Application session revocation failed');
  },

  async getProfile(userId: string): Promise<Profile> {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
    if (error) throw new Error(`Profile fetch error: ${error.message}`);
    return withoutSensitiveSettings(data as Record<string, any>);
  },

  async updateLastActive(userId: string): Promise<void> {
    await supabase.from('profiles').update({ last_active_at: new Date().toISOString() }).eq('id', userId);
  },

  async getUserRole(userId: string): Promise<string> {
    const { data, error } = await supabase.from('user_roles').select('role').eq('user_id', userId).eq('is_active', true).single();
    if (error) return 'student'; // Default role fallback
    return data?.role || 'student';
  },

  async getUserPermissions(role: string): Promise<string[]> {
    const { data, error } = await supabase.from('role_permissions').select('permissions(action)').eq('role', role);
    if (error) return [];
    return data?.map((item: any) => item.permissions?.action).filter(Boolean) || [];
  },

  async save2FASecret(userId: string, secret: string): Promise<void> {
    const { data: profile } = await supabase.from('profiles').select('settings').eq('id', userId).single();
    const currentSettings = (profile?.settings as Record<string, any>) || {};
    await supabase.from('profiles').update({ 
      settings: { ...currentSettings, two_factor_secret: secret } 
    }).eq('id', userId);
  },

  async enable2FA(userId: string): Promise<void> {
    await supabase.from('profiles').update({ is_2fa_enabled: true }).eq('id', userId);
  },

  async get2FASecret(userId: string): Promise<string | null> {
    const { data } = await supabase.from('profiles').select('settings').eq('id', userId).single();
    const settings = data?.settings as Record<string, any> | null;
    return settings?.two_factor_secret || null;
  },

  async saveTrustedDevice(userId: string, deviceToken: string, ipAddress: string): Promise<void> {
    await supabase.from('admin_sessions').insert({ 
      admin_id: userId, 
      device_id: deviceToken, 
      is_2fa_verified: true, 
      last_active: new Date().toISOString() 
    });
  },

  async saveUserDevice(payload: any): Promise<void> {
    // The install id is stable (sent by the app); the random fallback only
    // covers very old clients that never sent one.
    const deviceId = String(payload.device_id || '').trim() || crypto.randomUUID();
    const ipToSave =
      payload.ip_address && String(payload.ip_address).trim() !== ''
        ? String(payload.ip_address).trim()
        : '0.0.0.0';
    const platform = payload.platform === 'android' ? 'android' : 'web';
    const device = {
      user_id: payload.user_id,
      device_name: payload.device_name || 'Unknown',
      device_id: deviceId,
      fcm_token: payload.fcm_token || null,
      last_active_at: new Date().toISOString(),
      is_trusted: true,
      os_or_browser: payload.os_or_browser || 'Unknown',
      platform,
      ip_address: ipToSave,
    };

    const { data: existing } = await supabaseAdmin
      .from('user_devices')
      .select('id')
      .eq('user_id', payload.user_id)
      .eq('device_id', deviceId)
      .maybeSingle();

    const { error } = existing?.id
      ? await supabaseAdmin
          .from('user_devices')
          .update(device)
          .eq('id', existing.id)
      : await supabaseAdmin.from('user_devices').insert([device]);

    if (error) throw new Error(`Device save error: ${error.message}`);
  },

  async isDeviceTrusted(userId: string, deviceToken: string): Promise<boolean> {
    const { data, error } = await supabase.from('admin_sessions')
      .select('id')
      .eq('admin_id', userId)
      .eq('device_id', deviceToken)
      .eq('is_2fa_verified', true)
      .single();
    return !error && !!data;
  },

  /**
   * Creates an account with email + password only. Profile details are
   * collected later in onboarding, after the email is verified.
   */
  async registerWithEmail(email: string, password: string, referredByCode?: string | null) {
    const { data, error } = await supabaseAuth.auth.signUp({
      email,
      password,
      options: {
        data: referredByCode ? { referred_by_code: referredByCode } : {},
      },
    });

    return { data, error };
  },

  /**
   * Verifies real credentials through Supabase Auth. Returns null on any
   * failure so callers can answer with a single generic 401.
   */
  async authenticateWithPassword(email: string, password: string) {
    if (!email || !password) return null;

    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });

    if (error || !data?.user || !data?.session) return null;

    return data;
  },

  /** Resolve a normalized username only inside the trusted backend boundary. */
  async findActiveAccountEmailByUsername(username: string): Promise<string | null> {
    const normalized = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(normalized)) return null;

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('email, account_status')
      .eq('username', normalized)
      .maybeSingle();

    if (error) throw new Error('Username authentication lookup failed');
    if (data?.account_status !== 'active' || typeof data?.email !== 'string' || !data.email) {
      return null;
    }

    return data.email;
  },

  /** Revokes a Supabase session that must not be used (e.g. pre-2FA login). */
  async revokeSession(accessToken: string): Promise<void> {
    if (!accessToken) return;

    try {
      await supabaseAdmin.auth.admin.signOut(accessToken);
    } catch {
      // Best effort: the caller discards the token either way.
    }
  },

  /**
   * Persists a single-use, short-lived 2FA challenge. The token is opaque and
   * server-generated; it is never derived from client input.
   */
  async createLoginChallenge(userId: string): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex');

    const { error } = await supabaseAdmin.from('admin_sessions').insert({
      admin_id: userId,
      device_id: token,
      is_2fa_verified: false,
      last_active: new Date().toISOString(),
    });

    if (error) throw new Error(`Failed to create login challenge: ${error.message}`);

    return token;
  },

  /**
   * Consumes a 2FA challenge, returning its owner only if it is unexpired and
   * unused. The row is deleted so a challenge can never be replayed.
   */
  async consumeLoginChallenge(token: string): Promise<string | null> {
    if (!token) return null;

    const cutoff = new Date(Date.now() - LOGIN_CHALLENGE_TTL_MS).toISOString();

    const { data, error } = await supabaseAdmin
      .from('admin_sessions')
      .select('id, admin_id')
      .eq('device_id', token)
      .eq('is_2fa_verified', false)
      .gte('last_active', cutoff)
      .maybeSingle();

    if (error || !data?.admin_id) return null;

    await supabaseAdmin.from('admin_sessions').delete().eq('id', data.id);

    return data.admin_id;
  },

  /**
   * Mints a real Supabase session for an already-verified administrator.
   *
   * Supabase does not expose a server-side "create session" API, so a one-time
   * magic-link token hash is generated with the service-role client and
   * exchanged for a genuine session. No custom token format is introduced.
   */
  async mintSessionForEmail(email: string | null) {
    if (!email) return null;

    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });

    const tokenHash = (linkData as any)?.properties?.hashed_token;

    if (linkError || !tokenHash) return null;

    const { data, error } = await supabaseAuth.auth.verifyOtp({
      type: 'magiclink',
      token_hash: tokenHash,
    });

    if (error || !data?.session) return null;

    return data.session;
  }
};
