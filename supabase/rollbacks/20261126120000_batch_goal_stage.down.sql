-- Rollback for 20261126120000_batch_goal_stage.sql
--
-- Puts the database back to the reviewable state before that migration. The
-- hsc_batch backfill is intentionally NOT reversed: it moved the same fact from
-- class_level into the canonical column, and class_level still holds the old
-- string, so nothing is lost by keeping it in the new format.
--
-- Deletes every row in public.hsc_batches, including any the admin added after
-- the migration. Take a copy first if that data matters.

-- 1. Stage RPC and the batch table ----------------------------------------

drop function if exists public.get_my_stage();

drop table if exists public.hsc_batches;

-- 2. Batch constraint back to the permissive four-digit check --------------

alter table public.profiles
  drop constraint if exists profiles_hsc_batch_year;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_hsc_batch_format'
  ) then
    alter table public.profiles
      add constraint profiles_hsc_batch_format
      check (hsc_batch is null or hsc_batch ~ '^[0-9]{4}$');
  end if;
end $$;

comment on column public.profiles.hsc_batch is
  'HSC examination batch year, e.g. 2024-2028. Validated as a four-digit year.';

-- 3. Goal confirmation column ---------------------------------------------

alter table public.profiles
  drop column if exists goal_confirmed_at;

-- 4. complete_onboarding back to the version in
--    20261125154715_student_academic_profile_fields.sql --------------------

create or replace function public.complete_onboarding(
  p_full_name text,
  p_username text,
  p_class_level text default null,
  p_group text default null,
  p_study_goal text default null,
  p_hsc_batch text default null,
  p_hsc_group text default null,
  p_admission_targets text[] default null,
  p_other_admission_target text default null
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user text := lower(btrim(p_username));
  v_name text := btrim(p_full_name);
  v_batch text := nullif(btrim(p_hsc_batch), '');
  v_group text := nullif(btrim(p_hsc_group), '');
  v_targets text[] := coalesce(
    array(
      select distinct t
      from unnest(coalesce(p_admission_targets, array[]::text[])) as t
      where t is not null and btrim(t) <> ''
    ),
    array[]::text[]
  );
  v_other text := nullif(btrim(p_other_admission_target), '');
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if v_name is null or length(v_name) < 2 or length(v_name) > 80 then
    raise exception 'invalid name';
  end if;

  if not public.is_username_available(v_user)
     and not exists (
       select 1 from public.profiles
       where id = auth.uid() and username = v_user
     )
  then
    raise exception 'username unavailable';
  end if;

  if p_study_goal is not null
     and p_study_goal not in ('hsc', 'medical', 'engineering', 'varsity')
  then
    raise exception 'invalid goal';
  end if;

  if v_batch is not null and v_batch !~ '^[0-9]{4}$' then
    raise exception 'invalid hsc batch';
  end if;

  if v_group is not null
     and v_group not in ('science', 'humanities', 'business_studies')
  then
    raise exception 'invalid hsc group';
  end if;

  if exists (
    select 1
    from unnest(v_targets) as t
    where t not in (
      'university',
      'engineering',
      'medical',
      'dental',
      'agricultural',
      'general_university',
      'national_university',
      'other'
    )
  ) then
    raise exception 'invalid admission target';
  end if;

  if v_other is not null and char_length(v_other) > 100 then
    raise exception 'invalid other admission target';
  end if;

  if not ('other' = any(v_targets)) then
    v_other := null;
  end if;

  update public.profiles
  set full_name = v_name,
      username = v_user,
      class_level = p_class_level,
      "group" = p_group,
      study_goal = p_study_goal,
      hsc_batch = v_batch,
      hsc_group = v_group,
      admission_targets = v_targets,
      other_admission_target = v_other,
      onboarding_completed_at = coalesce(onboarding_completed_at, now())
  where id = auth.uid();
end;
$function$;

revoke all on function public.complete_onboarding(
  text, text, text, text, text, text, text, text[], text
) from public;

grant execute on function public.complete_onboarding(
  text, text, text, text, text, text, text, text[], text
) to authenticated, service_role;
