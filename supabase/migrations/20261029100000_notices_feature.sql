-- Notice board feature (additive).
--
-- A notice is an admin announcement shown on a notice board / urgent strip.
-- It is deliberately separate from per-user notifications and home_banners.
--
-- target_rules shape (all keys optional; missing/empty/null = everyone):
-- {
--   "roles": ["student", "teacher"],          -- user_roles.role; [] or ["all"] = all
--   "class_levels": ["HSC", "SSC"],           -- profiles.class_level; [] or ["all"] = all
--   "subscription": "premium" | "free" | "all",
--   "languages": ["bn", "en"]                 -- profiles.language_preference; [] = all
-- }
-- Evaluation is implemented once in public.notice_matches_target(), which is
-- reused by the RLS policy, the list RPC and the recipient lookup RPC.

-- 1. Standardise priority ------------------------------------------------------
update public.notices
   set priority = 'normal'
 where priority is null
    or priority not in ('normal', 'important', 'urgent');

alter table public.notices alter column priority set default 'normal';
alter table public.notices alter column priority set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'notices_priority_check'
      and conrelid = 'public.notices'::regclass
  ) then
    alter table public.notices
      add constraint notices_priority_check
      check (priority in ('normal', 'important', 'urgent'));
  end if;
end
$$;

comment on column public.notices.priority is
  'One of normal, important, urgent. Enforced by notices_priority_check.';

comment on column public.notices.target_rules is
  'Targeting document. Keys: roles text[], class_levels text[], subscription (all|premium|free), languages text[]. Missing/empty/null targets everyone. Evaluated by public.notice_matches_target().';

-- 2. Ordering index ------------------------------------------------------------
create or replace function public.notice_priority_rank(p_priority text)
returns integer
language sql
immutable
parallel safe
as $$
  select case lower(coalesce(p_priority, 'normal'))
    when 'urgent' then 1
    when 'important' then 2
    else 3
  end;
$$;

create index if not exists idx_notices_visible_order
  on public.notices (public.notice_priority_rank(priority), published_at desc, id desc)
  where is_active = true;

-- 3. Shared targeting matcher --------------------------------------------------
create or replace function public.notice_matches_target(
  p_rules jsonb,
  p_role text,
  p_class_level text,
  p_subscription text,
  p_language text
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_subscription text := lower(coalesce(p_subscription, 'free'));
begin
  if p_rules is null or jsonb_typeof(p_rules) is distinct from 'object' then
    return true;
  end if;

  if p_rules = '{}'::jsonb then
    return true;
  end if;

  if jsonb_typeof(p_rules -> 'roles') = 'array'
     and jsonb_array_length(p_rules -> 'roles') > 0 then
    if not exists (
      select 1
        from jsonb_array_elements_text(p_rules -> 'roles') as role(value)
       where lower(role.value) = 'all'
          or lower(role.value) = lower(coalesce(p_role, ''))
    ) then
      return false;
    end if;
  end if;

  if jsonb_typeof(p_rules -> 'class_levels') = 'array'
     and jsonb_array_length(p_rules -> 'class_levels') > 0 then
    if not exists (
      select 1
        from jsonb_array_elements_text(p_rules -> 'class_levels') as level(value)
       where lower(level.value) = 'all'
          or lower(level.value) = lower(coalesce(p_class_level, ''))
    ) then
      return false;
    end if;
  end if;

  if p_rules ? 'subscription'
     and lower(coalesce(p_rules ->> 'subscription', 'all')) <> 'all' then
    if lower(p_rules ->> 'subscription') <> v_subscription then
      return false;
    end if;
  end if;

  if jsonb_typeof(p_rules -> 'languages') = 'array'
     and jsonb_array_length(p_rules -> 'languages') > 0 then
    if not exists (
      select 1
        from jsonb_array_elements_text(p_rules -> 'languages') as lang(value)
       where lower(lang.value) = 'all'
          or lower(lang.value) = lower(coalesce(p_language, ''))
    ) then
      return false;
    end if;
  end if;

  return true;
end;
$$;

-- Current-user wrapper used by the SELECT policy. Untargeted notices remain
-- publicly readable; targeted notices are only readable by matching users.
create or replace function public.notice_visible_to_current_user(p_rules jsonb)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select case
    when p_rules is null
      or jsonb_typeof(p_rules) is distinct from 'object'
      or p_rules = '{}'::jsonb
    then true
    else coalesce((
      select public.notice_matches_target(
        p_rules,
        (
          select ur.role
            from public.user_roles ur
           where ur.user_id = auth.uid()
             and ur.is_active
           order by ur.created_at desc
           limit 1
        ),
        p.class_level,
        case when p.subscription_status in ('premium', 'active') then 'premium' else 'free' end,
        p.language_preference
      )
        from public.profiles p
       where p.id = auth.uid()
    ), false)
  end;
$$;

revoke all on function public.notice_matches_target(jsonb, text, text, text, text) from public;
grant execute on function public.notice_matches_target(jsonb, text, text, text, text)
  to anon, authenticated, service_role;

revoke all on function public.notice_visible_to_current_user(jsonb) from public;
grant execute on function public.notice_visible_to_current_user(jsonb)
  to anon, authenticated, service_role;

-- 4. Per-user read / dismiss state --------------------------------------------
create table if not exists public.notice_reads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  notice_id uuid not null references public.notices(id) on delete cascade,
  read_at timestamptz not null default now(),
  dismissed_at timestamptz,
  unique (user_id, notice_id)
);

create index if not exists idx_notice_reads_notice
  on public.notice_reads (notice_id);

alter table public.notice_reads enable row level security;

drop policy if exists "Users can read their own notice state" on public.notice_reads;
create policy "Users can read their own notice state"
  on public.notice_reads
  for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Users can insert their own notice state" on public.notice_reads;
create policy "Users can insert their own notice state"
  on public.notice_reads
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "Users can update their own notice state" on public.notice_reads;
create policy "Users can update their own notice state"
  on public.notice_reads
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.notice_reads from anon;
grant select, insert, update on public.notice_reads to authenticated;

-- 5. Tighten the public SELECT policy with the shared matcher ------------------
drop policy if exists "Users can view active and published notices" on public.notices;
drop policy if exists "Users can view visible notices" on public.notices;

create policy "Users can view visible notices"
  on public.notices
  for select
  to anon, authenticated
  using (
    is_active = true
    and published_at <= now()
    and (expires_at is null or expires_at > now())
    and public.notice_visible_to_current_user(target_rules)
  );

grant select on public.notices to anon, authenticated;

-- 6. Backend list / unread / recipient RPCs -----------------------------------
create or replace function public.get_notices_for_user(
  p_user_id uuid,
  p_limit integer default 20,
  p_offset integer default 0,
  p_priority text default null,
  p_undismissed_only boolean default false,
  p_notice_id uuid default null
)
returns table (
  id uuid,
  title_bn varchar,
  title_en varchar,
  body_bn text,
  body_en text,
  image_url text,
  attachment_url text,
  action_link text,
  target_rules jsonb,
  priority varchar,
  is_active boolean,
  published_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  is_read boolean,
  is_dismissed boolean,
  total_count bigint
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with viewer as (
    select
      (
        select ur.role
          from public.user_roles ur
         where ur.user_id = p_user_id
           and ur.is_active
         order by ur.created_at desc
         limit 1
      ) as role,
      p.class_level,
      case when p.subscription_status in ('premium', 'active') then 'premium' else 'free' end as subscription,
      p.language_preference
      from public.profiles p
     where p.id = p_user_id
  ),
  visible as (
    select n.*
      from public.notices n
      cross join viewer v
     where n.is_active = true
       and n.published_at <= now()
       and (n.expires_at is null or n.expires_at > now())
       and public.notice_matches_target(
         n.target_rules,
         v.role,
         v.class_level,
         v.subscription,
         v.language_preference
       )
       and (p_priority is null or n.priority = p_priority)
       and (p_notice_id is null or n.id = p_notice_id)
  )
  select
    v.id,
    v.title_bn,
    v.title_en,
    v.body_bn,
    v.body_en,
    v.image_url,
    v.attachment_url,
    v.action_link,
    v.target_rules,
    v.priority,
    v.is_active,
    v.published_at,
    v.expires_at,
    v.created_at,
    v.updated_at,
    coalesce(r.read_at is not null, false) as is_read,
    coalesce(r.dismissed_at is not null, false) as is_dismissed,
    count(*) over ()::bigint as total_count
    from visible v
    left join public.notice_reads r
      on r.notice_id = v.id
     and r.user_id = p_user_id
   where coalesce(p_undismissed_only, false) = false
      or r.dismissed_at is null
   order by public.notice_priority_rank(v.priority), v.published_at desc, v.id desc
   limit greatest(1, least(coalesce(p_limit, 20), 50))
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_unread_notice_count_for_user(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with viewer as (
    select
      (
        select ur.role
          from public.user_roles ur
         where ur.user_id = p_user_id
           and ur.is_active
         order by ur.created_at desc
         limit 1
      ) as role,
      p.class_level,
      case when p.subscription_status in ('premium', 'active') then 'premium' else 'free' end as subscription,
      p.language_preference
      from public.profiles p
     where p.id = p_user_id
  )
  select count(*)::integer
    from public.notices n
    cross join viewer v
   where n.is_active = true
     and n.published_at <= now()
     and (n.expires_at is null or n.expires_at > now())
     and public.notice_matches_target(
       n.target_rules,
       v.role,
       v.class_level,
       v.subscription,
       v.language_preference
     )
     and not exists (
       select 1
         from public.notice_reads r
        where r.notice_id = n.id
          and r.user_id = p_user_id
          and r.read_at is not null
     );
$$;

create or replace function public.get_notice_target_user_ids(p_rules jsonb)
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select p.id
    from public.profiles p
    left join lateral (
      select ur.role
        from public.user_roles ur
       where ur.user_id = p.id
         and ur.is_active
       order by ur.created_at desc
       limit 1
    ) ur on true
   where p.deleted_at is null
     and p.account_status = 'active'
     and public.notice_matches_target(
       p_rules,
       ur.role,
       p.class_level,
       case when p.subscription_status in ('premium', 'active') then 'premium' else 'free' end,
       p.language_preference
     );
$$;

revoke all on function public.get_notices_for_user(uuid, integer, integer, text, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.get_notices_for_user(uuid, integer, integer, text, boolean, uuid)
  to service_role;

revoke all on function public.get_unread_notice_count_for_user(uuid)
  from public, anon, authenticated;
grant execute on function public.get_unread_notice_count_for_user(uuid)
  to service_role;

revoke all on function public.get_notice_target_user_ids(jsonb)
  from public, anon, authenticated;
grant execute on function public.get_notice_target_user_ids(jsonb)
  to service_role;
