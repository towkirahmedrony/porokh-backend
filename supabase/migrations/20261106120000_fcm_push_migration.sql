-- Direct FCM migration.
--
-- Push delivery moved from OneSignal's external-id aliases to Firebase Cloud
-- Messaging registration tokens stored on `user_devices`, so the provider
-- bookkeeping column is renamed and the token columns get the indexes the fan-out
-- queries need. Existing notification history is preserved: the rename keeps the
-- stored ids and only their column name changes.

-- 1. Provider bookkeeping ------------------------------------------------------
-- Guarded so this is safe to re-run and harmless on a project that never had
-- the OneSignal column.
do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'notifications'
       and column_name = 'onesignal_message_id'
  ) and not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'notifications'
       and column_name = 'fcm_message_id'
  ) then
    alter table public.notifications
      rename column onesignal_message_id to fcm_message_id;
  end if;
end
$$;

alter table public.notifications
  add column if not exists fcm_message_id text;

comment on column public.notifications.fcm_message_id is
  'Message id FCM returned for the accepted batch; null when the send failed.';

comment on column public.notifications.total_sent is
  'Devices FCM accepted the message for. Provider acceptance, not proof of delivery.';

comment on column public.notifications.failed_count is
  'Devices FCM rejected (send failure or invalid token) on the last attempt.';

comment on column public.notifications.delivered_count is
  'Not populated: FCM does not report per-device delivery. Retained for historical rows.';

comment on column public.notifications.push_attempts is
  'Number of FCM send attempts. Also the scheduler claim token, so two workers cannot send the same row.';

-- 2. Device registration -------------------------------------------------------
-- One row per installation. Registration already updates rather than inserts when
-- the (user_id, device_id) pair exists; this index makes that guarantee real and
-- lets the upsert be written against it.
create unique index if not exists user_devices_user_device_key
  on public.user_devices (user_id, device_id);

-- Token fan-out reads every active token of a set of accounts.
create index if not exists idx_user_devices_user_token
  on public.user_devices (user_id)
  where fcm_token is not null;

-- 3. Audit trail ---------------------------------------------------------------
-- OneSignal-specific names live only in existing audit rows, which are history.
-- 'delivery_refreshed' stays in the constraint so those rows remain valid; the
-- action is no longer produced because FCM has no delivery report to refresh.
comment on table public.notification_admin_audit is
  'Admin notification actions. Historical rows may reference the retired OneSignal provider.';
