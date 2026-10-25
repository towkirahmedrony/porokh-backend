import { createClient } from '@supabase/supabase-js';

/**
 * Anonymous client for RPCs that are explicitly callable without a session
 * (for example `get_group_preview`). Never use the service-role client for a
 * public endpoint: doing so would bypass the `auth.uid()`-based response fields.
 */
export const createPublicSupabaseClient = () => {
  const url = process.env.SUPABASE_URL || '';
  const apiKey = process.env.SUPABASE_ANON_KEY || '';
  if (!url || !apiKey) throw new Error('Public data service unavailable');
  return createClient(url, apiKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
};
