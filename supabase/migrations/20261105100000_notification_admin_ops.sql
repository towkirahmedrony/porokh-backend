-- Admin notification operations: audit trail, provider delivery tracking and the
-- aggregate read model the admin dashboard queries.
--
-- Additive only. The existing notification tables, taxonomy (exam, reward,
-- streak, social, billing, security), templates, preferences and read-state
-- RPCs are reused; no second notification system is introduced.

-- 1. Native push device column ------------------------------------------------
-- Declared by 20261104080000_native_push_devices.sql. It is repeated here
-- idempotently so a project that missed that migration catches up: without the
-- column, Android device registration and the campaign audience query fail.
alter table public.user_devices
  add column if not exists platform text not null default 'web';

alter table public.user_devices
  drop constraint if exists user_devices_platform_check;

alter table public.user_devices
  add constraint user_devices_platform_check
  check (platform in ('web', 'android'));

create unique index if not exists user_devices_fcm_token_key
  on public.user_devices (fcm_token)
  where fcm_token is not null;

create index if not exists idx_user_devices_platform
  on public.user_devices (platform);

-- 2. Provider delivery bookkeeping -------------------------------------------
-- total_sent already means "devices OneSignal accepted the message for". It is
-- not a delivery receipt, so the provider report is stored separately and stays
-- null until an admin refreshes it.
alter table public.notifications
  add column if not exists onesignal_message_id text,
  add column if not exists provider_accepted_at timestamp with time zone,
  add column if not exists delivered_count integer,
  add column if not exists failed_count integer,
  add column if not exists delivery_checked_at timestamp with time zone,
  add column if not exists push_attempts integer not null default 0;

comment on column public.notifications.total_sent is
  'Devices OneSignal accepted the message for. Provider acceptance, not proof of delivery.';
comment on column public.notifications.delivered_count is
  'Devices the provider reported as delivered; null until delivery stats are refreshed.';
comment on column public.notifications.push_attempts is
  'Number of OneSignal send attempts for this notification; retries are capped.';

-- 3. Indexes for the admin list and the scheduler ----------------------------
create index if not exists idx_notifications_admin_created
  on public.notifications (created_at desc)
  where created_by is not null or target_user_id is null;

-- The scheduler polls for due notifications every minute; this keeps that scan
-- off a sequential read of every notification row.
create index if not exists idx_notifications_scheduled_due
  on public.notifications (scheduled_at)
  where status = 'scheduled';

-- 4. Audit trail ---------------------------------------------------------------
-- One row per admin action. notification_id is nullable so the trail survives a
-- deleted draft; the title is copied into details for the same reason.
create table if not exists public.notification_admin_audit (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid references public.notifications(id) on delete set null,
  actor_id uuid,
  action text not null check (action in (
    'created', 'updated', 'scheduled', 'sent', 'cancelled', 'retried',
    'delivery_refreshed', 'deleted'
  )),
  details jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now()
);

create index if not exists idx_notification_audit_notification
  on public.notification_admin_audit (notification_id, created_at desc);

create index if not exists idx_notification_audit_actor
  on public.notification_admin_audit (actor_id, created_at desc);

alter table public.notification_admin_audit enable row level security;

-- No policy on purpose: only the backend service role reads or writes the trail.
revoke all on table public.notification_admin_audit from anon, authenticated;

-- 5. Admin dashboard aggregates ----------------------------------------------
-- Aggregated in the database so the dashboard never downloads notification rows
-- to count them. Admin-authored notifications are the rows with a creator or a
-- global (no target user) audience.
create or replace function public.notification_admin_stats(
  p_from timestamp with time zone,
  p_to timestamp with time zone
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with scoped as (
    select *
      from public.notifications n
     where (n.created_by is not null or n.target_user_id is null)
       and n.created_at >= p_from
       and n.created_at < p_to
  ),
  device_counts as (
    select count(*)::integer as devices,
           count(*) filter (where platform = 'android')::integer as android_devices
      from public.user_devices
  ),
  opted_in as (
    select count(distinct d.user_id)::integer as push_opted_in
      from public.user_devices d
      join public.profiles p on p.id = d.user_id
     where coalesce((p.settings -> 'notification_preferences' ->> 'push')::boolean, true)
  )
  select jsonb_build_object(
    'total', (select count(*) from scoped),
    'sent', (select count(*) from scoped where status = 'sent'),
    'scheduled', (select count(*) from scoped where status = 'scheduled'),
    'draft', (select count(*) from scoped where status = 'draft'),
    'cancelled', (select count(*) from scoped where status = 'cancelled'),
    'failed', (select count(*) from scoped where status = 'failed'),
    'provider_accepted', coalesce((select sum(total_sent) from scoped), 0),
    'delivered', coalesce((select sum(delivered_count) from scoped), 0),
    'delivery_reported', (select count(*) from scoped where delivery_checked_at is not null),
    'failed_devices', coalesce((select sum(failed_count) from scoped), 0),
    'taps', coalesce((select sum(total_clicks) from scoped), 0),
    'push_errored', (select count(*) from scoped where push_error is not null),
    'devices', (select devices from device_counts),
    'android_devices', (select android_devices from device_counts),
    'push_opted_in', (select push_opted_in from opted_in)
  );
$$;

revoke all on function public.notification_admin_stats(timestamp with time zone, timestamp with time zone)
  from public, anon, authenticated;
grant execute on function public.notification_admin_stats(timestamp with time zone, timestamp with time zone)
  to service_role;
