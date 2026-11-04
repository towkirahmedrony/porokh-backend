-- Native Android push support, additive on the existing device table.
--
-- `user_devices` is shared by Web Push and native FCM: one installation holds
-- exactly one active token, and the platform decides the payload shape used by
-- the delivery service (web = data-only for the service worker, android =
-- notification + data so the system tray shows it while the app is closed).
--
-- No new notification tables are introduced: targeting, templates,
-- preferences, read state and unread counts stay in the existing schema.

alter table public.user_devices
  add column if not exists platform text not null default 'web';

alter table public.user_devices
  drop constraint if exists user_devices_platform_check;

alter table public.user_devices
  add constraint user_devices_platform_check
  check (platform in ('web', 'android'));

-- A token identifies one installation, so it may only belong to one row. The
-- backend releases a token from previous rows before re-registering it, which
-- is what prevents duplicate delivery after an account switch.
create unique index if not exists user_devices_fcm_token_key
  on public.user_devices (fcm_token)
  where fcm_token is not null;

create index if not exists idx_user_devices_platform
  on public.user_devices (platform);

comment on column public.user_devices.platform is
  'Push transport for this installation: web (service worker) or android (FCM native).';

-- The table stays service-role only for writes from features; the existing
-- owner-only policy "User Devices All Access" still limits any direct client
-- read/update to the caller's own rows.
alter table public.user_devices enable row level security;

revoke truncate, trigger, references on table public.user_devices from anon, authenticated;
revoke all on table public.user_devices from anon;
