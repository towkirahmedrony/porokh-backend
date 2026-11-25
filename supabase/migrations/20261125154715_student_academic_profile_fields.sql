-- Academic profile collected at registration/onboarding.
-- hsc_batch: HSC examination year (e.g. 2026)
-- hsc_group: science | humanities | business_studies
-- admission_targets: multi-select admission preparation targets
-- other_admission_target: free text only when admission_targets contains 'other'
alter table public.profiles
  add column if not exists hsc_batch text,
  add column if not exists hsc_group text,
  add column if not exists admission_targets text[] not null default '{}'::text[],
  add column if not exists other_admission_target text;

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

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_hsc_group_allowed'
  ) then
    alter table public.profiles
      add constraint profiles_hsc_group_allowed
      check (
        hsc_group is null
        or hsc_group in ('science', 'humanities', 'business_studies')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_admission_targets_allowed'
  ) then
    alter table public.profiles
      add constraint profiles_admission_targets_allowed
      check (
        admission_targets <@ array[
          'university',
          'engineering',
          'medical',
          'dental',
          'agricultural',
          'general_university',
          'national_university',
          'other'
        ]::text[]
        and array_position(admission_targets, null) is null
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_other_admission_target_check'
  ) then
    alter table public.profiles
      add constraint profiles_other_admission_target_check
      check (
        other_admission_target is null
        or ('other' = any(admission_targets) and char_length(other_admission_target) <= 100)
      );
  end if;
end $$;

comment on column public.profiles.hsc_batch is
  'HSC examination batch year, e.g. 2024-2028. Validated as a four-digit year.';
comment on column public.profiles.hsc_group is
  'HSC group key: science, humanities, or business_studies.';
comment on column public.profiles.admission_targets is
  'Admission preparation targets (multi-select). Empty array means not chosen yet.';
comment on column public.profiles.other_admission_target is
  'Optional free-text admission target; only stored when admission_targets contains other.';

-- Extend the onboarding RPC in place so new users save every academic field in
-- one transaction. The original five arguments stay first and optional, so a
-- client on an older build still calls the same RPC successfully.
drop function if exists public.complete_onboarding(text, text, text, text, text);

create function public.complete_onboarding(
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

  -- The free-text target only makes sense with "Other" selected.
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
