-- Policy tests for can_send_push. Runs inside a transaction and rolls back, so
-- it can be executed against the live project:
--   psql "$DATABASE_URL" -f supabase/tests/notification_policy_test.sql
begin;

do $$
declare
  v_user uuid;
  v_result record;
  v_day_start timestamptz;
begin
  select id into v_user from public.profiles order by created_at limit 1;
  if v_user is null then
    raise exception 'test needs at least one profile';
  end if;

  -- Clean slate for this user inside the transaction.
  delete from public.notification_push_log where user_id = v_user;
  update public.notification_preferences
     set push_enabled = true, exam_reminders = true, streak_reminders = true,
         social = true, rewards = true, premium = true,
         quiet_start = '23:00', quiet_end = '07:00', timezone = 'Asia/Dhaka'
   where user_id = v_user;

  -- 10:00 Dhaka, nothing sent today.
  select * into v_result from public.can_send_push(v_user, 'exam_live_1h', '2026-11-23 10:00:00+06');
  if not v_result.allowed then
    raise exception 'expected allowed at 10:00, got % (%)', v_result.allowed, v_result.reason;
  end if;

  -- Quiet hours: 23:30 and 06:59 deny, 07:00 allows.
  select * into v_result from public.can_send_push(v_user, 'exam_live_1h', '2026-11-23 23:30:00+06');
  if v_result.allowed or v_result.reason <> 'quiet_hours' then
    raise exception 'expected quiet_hours at 23:30, got % (%)', v_result.allowed, v_result.reason;
  end if;
  if v_result.retry_after <> '2026-11-24 07:00:00+06' then
    raise exception 'quiet retry_after should be 07:00 next day, got %', v_result.retry_after;
  end if;

  select * into v_result from public.can_send_push(v_user, 'exam_live_10m', '2026-11-24 06:59:00+06');
  if v_result.allowed or v_result.retry_after <> '2026-11-24 07:00:00+06' then
    raise exception 'expected quiet until 07:00, got % / %', v_result.allowed, v_result.retry_after;
  end if;

  select * into v_result from public.can_send_push(v_user, 'exam_live_1h', '2026-11-24 07:00:00+06');
  if not v_result.allowed then
    raise exception 'expected allowed at 07:00, got %', v_result.reason;
  end if;

  -- Security ignores quiet hours and the cap.
  select * into v_result from public.can_send_push(v_user, 'new_device_login', '2026-11-23 23:30:00+06');
  if not v_result.allowed then
    raise exception 'security must bypass quiet hours, got %', v_result.reason;
  end if;

  -- Daily cap: two accepted pushes today block a third.
  v_day_start := '2026-11-23 00:00:00+06';
  insert into public.notification_push_log (user_id, notification_id, status, created_at)
  select v_user, null::uuid, 'accepted', v_day_start + interval '9 hours'
  union all
  select v_user, null::uuid, 'accepted', v_day_start + interval '9 hours 30 minutes';

  select * into v_result from public.can_send_push(v_user, 'streak_warning', '2026-11-23 14:00:00+06');
  if v_result.allowed or v_result.reason <> 'daily_cap' then
    raise exception 'expected daily_cap, got % (%)', v_result.allowed, v_result.reason;
  end if;

  -- Premium purchase and security bypass the cap.
  select * into v_result from public.can_send_push(v_user, 'premium_granted', '2026-11-23 14:00:00+06');
  if not v_result.allowed then
    raise exception 'premium_granted must bypass the cap, got %', v_result.reason;
  end if;

  -- The gap applies before the cap is reached: one push 1h ago.
  delete from public.notification_push_log where user_id = v_user;
  insert into public.notification_push_log (user_id, notification_id, status, created_at)
  values (v_user, null::uuid, 'accepted', '2026-11-23 13:00:00+06');

  select * into v_result from public.can_send_push(v_user, 'exam_result', '2026-11-23 14:00:00+06');
  if v_result.allowed or v_result.reason <> 'min_gap' then
    raise exception 'expected min_gap, got % (%)', v_result.allowed, v_result.reason;
  end if;
  if v_result.retry_after <> '2026-11-23 16:00:00+06' then
    raise exception 'gap retry_after should be 16:00, got %', v_result.retry_after;
  end if;

  select * into v_result from public.can_send_push(v_user, 'exam_result', '2026-11-23 16:00:00+06');
  if not v_result.allowed then
    raise exception 'expected allowed after the gap, got %', v_result.reason;
  end if;

  -- A category toggle only affects that category.
  update public.notification_preferences set social = false where user_id = v_user;
  select * into v_result from public.can_send_push(v_user, 'squad_invite', '2026-11-23 17:00:00+06');
  if v_result.allowed or v_result.reason <> 'category_disabled' then
    raise exception 'expected category_disabled for social, got % (%)', v_result.allowed, v_result.reason;
  end if;
  select * into v_result from public.can_send_push(v_user, 'exam_result', '2026-11-23 17:00:00+06');
  if not v_result.allowed then
    raise exception 'exam must stay allowed when social is off, got %', v_result.reason;
  end if;

  -- push_enabled=false stops everything except security.
  update public.notification_preferences set push_enabled = false where user_id = v_user;
  select * into v_result from public.can_send_push(v_user, 'exam_result', '2026-11-23 17:00:00+06');
  if v_result.allowed or v_result.reason <> 'push_disabled' then
    raise exception 'expected push_disabled, got % (%)', v_result.allowed, v_result.reason;
  end if;
  select * into v_result from public.can_send_push(v_user, 'new_device_login', '2026-11-23 17:00:00+06');
  if not v_result.allowed then
    raise exception 'security must ignore push_enabled, got %', v_result.reason;
  end if;

  raise notice 'notification policy tests passed';
end $$;

rollback;
