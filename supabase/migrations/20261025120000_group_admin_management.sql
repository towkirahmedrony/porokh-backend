-- Group / squad administration hardening.
--
-- The study-group tables already exist in the live project (the earlier group
-- feature was shipped outside this migration mirror). This migration is
-- additive and deliberately does not recreate or reshape those tables.
--
-- It adds the invariants the admin API relies on:
--   * one membership row per (group, user), enforced by the database;
--   * a hard member-cap check that also holds under concurrent requests;
--   * indexes for the admin list, search and member screens.
BEGIN;

-- Refuse to install the unique index over ambiguous legacy data instead of
-- silently deleting memberships. The operator must resolve duplicates first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.group_members
    GROUP BY group_id, user_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Group admin migration stopped: duplicate group_members rows exist. Resolve them before applying.';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS group_members_group_id_user_id_key
  ON public.group_members(group_id, user_id);

-- Serialise active-membership changes for one group, then enforce the cap that
-- is stored on study_groups.max_members. The check is skipped for non-active
-- rows so pending/left/kicked history can coexist with the unique membership
-- row. New rows are also covered when they are created directly (for example
-- by the admin API).
CREATE OR REPLACE FUNCTION public.enforce_group_membership_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_max_members integer;
  v_active_count integer;
BEGIN
  IF NEW.status IS DISTINCT FROM 'active' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'active' THEN
    RETURN NEW;
  END IF;

  SELECT max_members
    INTO v_max_members
    FROM public.study_groups
   WHERE id = NEW.group_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)
    INTO v_active_count
    FROM public.group_members
   WHERE group_id = NEW.group_id
     AND status = 'active'
     AND id IS DISTINCT FROM NEW.id;

  IF v_max_members IS NOT NULL AND v_active_count >= v_max_members THEN
    RAISE EXCEPTION 'GROUP_FULL' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_group_membership_limit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_group_membership_limit() FROM service_role;

DROP TRIGGER IF EXISTS group_members_enforce_cap ON public.group_members;
CREATE TRIGGER group_members_enforce_cap
  BEFORE INSERT OR UPDATE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.enforce_group_membership_limit();

CREATE INDEX IF NOT EXISTS study_groups_admin_list_idx
  ON public.study_groups(is_active, group_type, created_at DESC);

CREATE INDEX IF NOT EXISTS study_groups_name_idx
  ON public.study_groups(name);

CREATE INDEX IF NOT EXISTS group_members_group_status_idx
  ON public.group_members(group_id, status);

CREATE INDEX IF NOT EXISTS group_members_user_status_idx
  ON public.group_members(user_id, status);

CREATE INDEX IF NOT EXISTS group_chats_group_created_idx
  ON public.group_chats(group_id, created_at DESC);

CREATE INDEX IF NOT EXISTS group_battles_group_created_idx
  ON public.group_battles(group_id, created_at DESC);

COMMIT;
