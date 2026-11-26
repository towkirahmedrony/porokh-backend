-- Batch + goal + stage.
--
-- hsc_batch becomes the single canonical batch column (four-digit year).
-- profiles.class_level and profiles.batch_year stay in the table so an older
-- APK keeps reading them, but nothing writes them after this migration.
--
-- The HSC exam end date is admin-owned data, never hardcoded in an app, and
-- every "has the exam ended" decision is taken against now() on the server.
--
-- Idempotent: every statement can run twice.
-- Rollback: supabase/rollbacks/20261126120000_batch_goal_stage.down.sql

-- 1. Goal confirmation -----------------------------------------------------

alter table public.profiles
  add column if not exists goal_confirmed_at timestamptz;

comment on column public.profiles.goal_confirmed_at is
  'When the student explicitly picked or confirmed study_goal. NULL means the stored goal was a default or was never confirmed.';

-- profiles has column-level grants only, so a new column is readable by nobody
-- until it is granted. Without this line every select=* on the table fails.
grant select (goal_confirmed_at) on public.profiles to authenticated;

-- 2. Backfill the canonical batch from the legacy column -------------------
--
-- 'HSC 26' -> '2026', 'HSC 2026' -> '2026'. Anything that cannot be read as
-- an HSC year is cleared so the stricter constraint below can be added.

update public.profiles p
set hsc_batch = case
      when p.class_level ~* '^\s*hsc\s*20[0-9]{2}\s*$'
        then substring(p.class_level from '20[0-9]{2}')
      when p.class_level ~* '^\s*hsc\s*[0-9]{2}\s*$'
        then '20' || substring(p.class_level from '[0-9]{2}\s*$')
    end
where p.hsc_batch is null
  and p.class_level ~* '^\s*hsc\s*(20)?[0-9]{2}\s*$';

update public.profiles
set hsc_batch = null
where hsc_batch is not null
  and hsc_batch !~ '^20[0-9]{2}$';

alter table public.profiles
  drop constraint if exists profiles_hsc_batch_format;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_hsc_batch_year'
  ) then
    alter table public.profiles
      add constraint profiles_hsc_batch_year
      check (hsc_batch is null or hsc_batch ~ '^20[0-9]{2}$');
  end if;
end $$;

comment on column public.profiles.hsc_batch is
  'Canonical HSC batch year, e.g. 2026. Only column the app reads or writes for the batch.';

-- 3. Batches the admin owns ------------------------------------------------

create table if not exists public.hsc_batches (
  batch_year text primary key,
  exam_end_date date,
  notes text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  constraint hsc_batches_year_format check (batch_year ~ '^20[0-9]{2}$'),
  constraint hsc_batches_notes_length check (notes is null or char_length(notes) <= 500)
);

comment on table public.hsc_batches is
  'One row per HSC batch. exam_end_date NULL means the exam has not finished (or its date is unknown).';
comment on column public.hsc_batches.exam_end_date is
  'Last day of the HSC exam. The batch counts as finished from the next Asia/Dhaka day.';

alter table public.hsc_batches enable row level security;

drop policy if exists hsc_batches_read_authenticated on public.hsc_batches;
create policy hsc_batches_read_authenticated on public.hsc_batches
  for select to authenticated
  using (true);

drop policy if exists hsc_batches_admin_insert on public.hsc_batches;
create policy hsc_batches_admin_insert on public.hsc_batches
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists hsc_batches_admin_update on public.hsc_batches;
create policy hsc_batches_admin_update on public.hsc_batches
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists hsc_batches_admin_delete on public.hsc_batches;
create policy hsc_batches_admin_delete on public.hsc_batches
  for delete to authenticated
  using (public.is_admin());

grant select on public.hsc_batches to authenticated;

drop trigger if exists update_hsc_batches_updated_at on public.hsc_batches;
create trigger update_hsc_batches_updated_at
  before update on public.hsc_batches
  for each row execute function public.update_updated_at_column();

-- The owner confirmed on 2026-11-26 that the 2026 HSC exam has not finished,
-- so all three seeded batches start with no end date. The admin sets the date
-- when it is actually over; nothing in the app hardcodes one.
insert into public.hsc_batches (batch_year, exam_end_date, notes)
values
  ('2026', null, null),
  ('2027', null, null),
  ('2028', null, null)
on conflict (batch_year) do nothing;

-- 4. Stage of the caller, timed by the server ------------------------------
--
-- search_path is empty and every name is schema-qualified, matching is_admin()
-- and update_academic_profile() in this schema: an empty search_path with an
-- unqualified name would fail at runtime.

create or replace function public.get_my_stage()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_batch text;
  v_goal text;
  v_confirmed_at timestamptz;
  v_exam_end_date date;
  v_exam_ended boolean;
  v_stage text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select p.hsc_batch, p.study_goal, p.goal_confirmed_at
    into v_batch, v_goal, v_confirmed_at
    from public.profiles p
   where p.id = v_uid;

  if not found then
    raise exception 'profile not found';
  end if;

  if v_batch is not null then
    select b.exam_end_date
      into v_exam_end_date
      from public.hsc_batches b
     where b.batch_year = v_batch;
  end if;

  -- The phone clock is never consulted. The exam is over from the day after
  -- its last day, in the calendar the students actually live in.
  v_exam_ended := v_exam_end_date is not null
    and (now() at time zone 'Asia/Dhaka')::date > v_exam_end_date;

  if not v_exam_ended then
    v_stage := 'studying';
  elsif v_goal is null or v_goal = 'hsc' or v_confirmed_at is null then
    v_stage := 'post_hsc';
  else
    v_stage := 'admission_prep';
  end if;

  return jsonb_build_object(
    'stage', v_stage,
    'batch_year', v_batch,
    'goal', v_goal,
    'needs_goal_gate', v_stage = 'post_hsc',
    'exam_ended', v_exam_ended
  );
end;
$function$;

revoke all on function public.get_my_stage() from public;
revoke all on function public.get_my_stage() from anon;
grant execute on function public.get_my_stage() to authenticated, service_role;

comment on function public.get_my_stage() is
  'Stage of the calling student computed from their profile, their batch exam end date and server time.';

-- 5. Signup stops writing the legacy class column --------------------------
--
-- Same signature, so an older APK keeps calling it successfully; the class
-- argument is accepted and ignored. A real admission goal chosen at signup
-- counts as confirmed; the hsc default does not.

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
  v_goal text := nullif(btrim(p_study_goal), '');
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

  if v_goal is not null
     and v_goal not in ('hsc', 'medical', 'engineering', 'varsity')
  then
    raise exception 'invalid goal';
  end if;

  if v_batch is not null and v_batch !~ '^20[0-9]{2}$' then
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
      study_goal = v_goal,
      goal_confirmed_at = case
        when v_goal in ('medical', 'engineering', 'varsity') then now()
        else null
      end,
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
