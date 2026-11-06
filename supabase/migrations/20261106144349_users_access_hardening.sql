-- Users & Access hardening.
--
-- Additive only: one nullable column, one SECURITY DEFINER RPC and indexes.
-- No table, column or policy is dropped, and no RLS policy is loosened.
BEGIN;

-- Timestamp of the last administrative session revocation. requireAuth compares
-- it with the token's `iat`, so a revoked access token stops working at once
-- instead of staying valid until it expires.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS sessions_revoked_at timestamptz;

-- Directory search and ordering. The admin directory filters on account status
-- and registration date, sorts on created_at/last_active_at, and searches name,
-- email, username and phone with a leading-wildcard ILIKE, which needs a
-- trigram index to avoid a sequential scan.
CREATE INDEX IF NOT EXISTS profiles_created_at_idx
  ON public.profiles (created_at DESC);
CREATE INDEX IF NOT EXISTS profiles_last_active_at_idx
  ON public.profiles (last_active_at DESC);
CREATE INDEX IF NOT EXISTS profiles_account_status_idx
  ON public.profiles (account_status);

-- access_grants is read per page of users and per grant list filter.
CREATE INDEX IF NOT EXISTS access_grants_user_id_idx
  ON public.access_grants (user_id);
CREATE INDEX IF NOT EXISTS access_grants_expires_at_idx
  ON public.access_grants (expires_at)
  WHERE revoked_at IS NULL;

-- Today's per-user usage is counted for the access overview and per-feature
-- quota status.
CREATE INDEX IF NOT EXISTS usage_events_user_feature_date_idx
  ON public.usage_events (user_id, feature, usage_date);
CREATE INDEX IF NOT EXISTS usage_events_usage_date_feature_idx
  ON public.usage_events (usage_date, feature);

-- Risk monitoring reads device activity per user and the audit trail per target.
CREATE INDEX IF NOT EXISTS user_devices_user_last_active_idx
  ON public.user_devices (user_id, last_active_at DESC);
CREATE INDEX IF NOT EXISTS security_audit_logs_target_created_idx
  ON public.security_audit_logs (target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_target_id_created_idx
  ON public.audit_logs (target_id, created_at DESC);

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS profiles_full_name_trgm_idx
  ON public.profiles USING gin (full_name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS profiles_email_trgm_idx
  ON public.profiles USING gin (email extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS profiles_username_trgm_idx
  ON public.profiles USING gin (username extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS profiles_phone_number_trgm_idx
  ON public.profiles USING gin (phone_number extensions.gin_trgm_ops);

-- Administrative session revocation.
--
-- Revokes every Supabase session of a target user: rows are removed from
-- auth.sessions (which invalidates refresh tokens through their cascade), the
-- profile timestamp makes already-issued access tokens unusable, and any admin
-- session record is marked revoked. The acting administrator is always
-- auth.uid(): the backend reaches this RPC with the caller's own JWT.
CREATE OR REPLACE FUNCTION public.revoke_user_sessions(p_target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_target_role text;
BEGIN
  IF v_actor IS NULL OR p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid session revocation request' USING ERRCODE='22023';
  END IF;
  SELECT ur.role INTO v_actor_role
    FROM public.user_roles ur
    JOIN public.profiles pr ON pr.id = ur.user_id AND pr.account_status = 'active'
   WHERE ur.user_id = v_actor AND ur.is_active IS TRUE
   LIMIT 1;
  IF v_actor_role IS NULL OR NOT public.has_permission('users.manage') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';
  END IF;
  IF p_target_user_id = v_actor THEN
    RAISE EXCEPTION 'self session revocation is forbidden' USING ERRCODE='42501';
  END IF;

  SELECT ur.role INTO v_target_role
    FROM public.user_roles ur
   WHERE ur.user_id = p_target_user_id AND ur.is_active IS TRUE
   LIMIT 1;
  IF v_actor_role = 'admin' AND v_target_role IN ('admin', 'super_admin') THEN
    RAISE EXCEPTION 'insufficient role authority' USING ERRCODE='42501';
  END IF;

  UPDATE public.profiles
     SET sessions_revoked_at = now()
   WHERE id = p_target_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE='P0002';
  END IF;

  DELETE FROM auth.sessions WHERE user_id = p_target_user_id;

  UPDATE public.admin_auth_sessions
     SET revoked_at = now(), revoked_by = v_actor
   WHERE user_id = p_target_user_id AND revoked_at IS NULL;

  INSERT INTO public.security_audit_logs(
    actor_user_id, target_user_id, action, resource_type, resource_id, outcome
  ) VALUES (
    v_actor, p_target_user_id, 'account.sessions_revoked', 'profile',
    p_target_user_id::text, 'success'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_user_sessions(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_user_sessions(uuid) TO authenticated;

COMMIT;
