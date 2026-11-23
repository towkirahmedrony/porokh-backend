-- Fires every event code once for one user and lists the rendered in-app rows.
--
--   psql "$DATABASE_URL" -f supabase/tests/notification_manual_test.sql
--
-- Runs in a transaction and rolls back, so it leaves no rows behind. Push and
-- click checks need a real device: register it, then remove the `rollback` and
-- watch `notification_push_log` for the per-device outcome.
begin;

do $$
declare
  v_user uuid := (select id from public.profiles order by created_at limit 1);
  v_event text;
  v_vars jsonb;
begin
  if v_user is null then
    raise exception 'manual test needs at least one profile';
  end if;

  for v_event, v_vars in
    select * from (values
      ('exam_live_1h', jsonb_build_object('exam_title', 'Manual test exam')),
      ('exam_live_10m', jsonb_build_object('exam_title', 'Manual test exam')),
      ('exam_result', jsonb_build_object('exam_title', 'Manual test exam', 'score', 78, 'rank', '#12')),
      ('exam_challenge_invite', jsonb_build_object('challenger', 'Rafi', 'exam_title', 'Manual test exam')),
      ('reward_earned', jsonb_build_object('amount', 40)),
      ('level_up', jsonb_build_object('level', 'অধ্যবসায়ী')),
      ('league_promotion', jsonb_build_object('league', 'সিলভার')),
      ('league_demotion', jsonb_build_object('league', 'ব্রোঞ্জ')),
      ('streak_warning', jsonb_build_object('streak', 12)),
      ('leaderboard_top10', '{}'::jsonb),
      ('squad_invite', jsonb_build_object('group_name', 'Manual squad')),
      ('squad_join_approved', jsonb_build_object('group_name', 'Manual squad')),
      ('pvp_challenge', jsonb_build_object('challenger', 'Rafi')),
      ('pvp_result', '{}'::jsonb),
      ('community_reply', jsonb_build_object('actor', 'Rafi')),
      ('premium_purchased', jsonb_build_object('plan', 'Yearly Pro')),
      ('premium_expiring', jsonb_build_object('days', 3)),
      ('premium_granted', jsonb_build_object('grant', 'premium')),
      ('quota_exhausted', jsonb_build_object('feature', 'exam')),
      ('referral_bonus', jsonb_build_object('amount', 50)),
      ('new_device_login', jsonb_build_object('device', 'Android 16')),
      ('inactivity_reminder', jsonb_build_object('days', 4))
    ) as t(event_code, vars)
  loop
    perform public.create_notification(
      v_user,
      v_event,
      v_vars,
      'manual-test:' || v_event || ':' || v_user::text || ':' ||
        extract(epoch from now())::bigint,
      now(),
      null,
      now() + interval '1 day',
      '{"manual_test": true}'::jsonb
    );
  end loop;
end $$;

select
  n.event_code,
  n.channel,
  n.status,
  (n.title_bn is not null and n.body_bn is not null) as rendered_bn,
  (n.title_en is not null and n.body_en is not null) as rendered_en,
  n.action_link,
  (n.body_bn like '%{{%') as has_unresolved_placeholder
from public.notifications n
where n.dedupe_key like 'manual-test:%'
  and n.target_user_id = (select id from public.profiles order by created_at limit 1)
order by n.event_code;

rollback;
