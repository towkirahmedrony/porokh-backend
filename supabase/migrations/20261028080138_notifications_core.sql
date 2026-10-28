-- Notification feature: additive schema, read tracking, preferences support and
-- a single delivery contract. Existing tables (notifications,
-- notification_reads, notification_templates, user_devices) are reused.

-- 1. Delivery bookkeeping -----------------------------------------------------
alter table public.notifications
  add column if not exists event_code text,
  add column if not exists dedupe_key text,
  add column if not exists push_sent_at timestamptz,
  add column if not exists push_error text;

-- A plain unique index (not partial) so PostgREST upsert/on-conflict can infer
-- it. Postgres unique indexes still allow any number of NULL dedupe keys.
create unique index if not exists notifications_dedupe_key_key
  on public.notifications (dedupe_key);

create index if not exists idx_notifications_user_created
  on public.notifications (target_user_id, created_at desc);

create index if not exists idx_notifications_user_status_created
  on public.notifications (target_user_id, status, created_at desc);

create index if not exists idx_notifications_event_code
  on public.notifications (event_code);

create index if not exists idx_notification_reads_user_unread
  on public.notification_reads (user_id, is_read)
  where is_read = false;

-- 2. Standardise type values and release stranded in-app rewards ---------------
-- Old code inserted reward rows without an explicit status, so they defaulted
-- to `draft` and the user endpoint (status = sent) never returned them.
update public.notifications
   set type = 'billing'
 where type in ('payment', 'premium', 'billing');

update public.notifications
   set type = 'social'
 where type in (
   'buzz',
   'group_join_request',
   'group_request_approved',
   'group_request_rejected',
   'group_kicked',
   'group_battle_created',
   'group_battle_finished',
   '1v1_challenge_received'
 );

update public.notifications
   set type = 'security'
 where type in ('system', 'security');

update public.notifications
   set status = 'sent',
       sent_at = coalesce(sent_at, created_at)
 where status = 'draft'
   and target_user_id is not null
   and type in ('exam', 'reward', 'streak', 'social', 'billing', 'security');

-- 3. Templates ----------------------------------------------------------------
insert into public.notification_templates
  (template_code, title_en, title_bn, body_en, body_bn, action_link, is_active)
values
  ('exam_live_1h', 'Exam starts in 1 hour', 'পরীক্ষা শুরু হবে ১ ঘণ্টা পরে',
   '{{exam_title}} starts in about an hour. Get ready.', '{{exam_title}} প্রায় ১ ঘণ্টা পরে শুরু হবে। প্রস্তুতি নিন।', '/exam/selection', true),
  ('exam_live_10m', 'Exam starts in 10 minutes', 'পরীক্ষা শুরু হবে ১০ মিনিটে',
   '{{exam_title}} starts in 10 minutes. Join now.', '{{exam_title}} ১০ মিনিট পরে শুরু হবে। এখনই যোগ দিন।', '/exam/selection', true),
  ('exam_result', 'Result published', 'ফলাফল প্রকাশিত হয়েছে',
   '{{exam_title}} result is out. Score {{score}}, rank {{rank}}.', '{{exam_title}} এর ফলাফল প্রকাশিত হয়েছে। স্কোর {{score}}, র‍্যাঙ্ক {{rank}}।', '/history', true),
  ('exam_challenge_invite', 'Exam challenge received', 'পরীক্ষার চ্যালেঞ্জ পেয়েছেন',
   '{{challenger}} challenged you in {{exam_title}}. Accept now.', '{{challenger}} আপনাকে {{exam_title}} এ চ্যালেঞ্জ করেছেন। এখনই গ্রহণ করুন।', '/exam/selection', true),
  ('reward_earned', 'Reward earned', 'রিওয়ার্ড অর্জিত',
   'You earned {{amount}} XP.', 'আপনি {{amount}} XP পেয়েছেন।', '/profile', true),
  ('level_up', 'Level up!', 'লেভেল আপ!',
   'You reached {{level}}. Keep going!', 'আপনি {{level}} লেভেলে পৌঁছেছেন। এগিয়ে চলুন!', '/profile', true),
  ('league_promotion', 'League promotion', 'লিগে উন্নতি',
   'You moved up to {{league}}.', 'আপনি {{league}} লিগে উন্নীত হয়েছেন।', '/dashboard/leaderboard', true),
  ('league_demotion', 'League demotion', 'লিগ পরিবর্তন',
   'You moved to {{league}}. Study today to climb back.', 'আপনি {{league}} লিগে নেমে গেছেন। আজ পড়ে আবার উঠুন।', '/dashboard/leaderboard', true),
  ('streak_warning', 'Your streak is at risk', 'আপনার স্ট্রিক ঝুঁকিতে',
   'You have not practiced today. Keep your {{streak}}-day streak alive!', 'আজ আপনি পড়েননি। আপনার {{streak}} দিনের স্ট্রিক ধরে রাখুন!', '/exam/selection', true),
  ('leaderboard_top10', 'You are in the top 10!', 'আপনি টপ ১০ এ!',
   'You entered the top 10 of your league. Keep it up!', 'আপনি আপনার লিগের টপ ১০ এ ঢুকেছেন। চালিয়ে যান!', '/dashboard/leaderboard', true),
  ('squad_invite', 'Squad invite', 'স্কোয়াড আমন্ত্রণ',
   'You were invited to join {{group_name}}.', 'আপনাকে {{group_name}} এ যোগ দেওয়ার আমন্ত্রণ পাঠানো হয়েছে।', '/groups', true),
  ('squad_join_approved', 'Join request approved', 'যোগদানের অনুরোধ অনুমোদিত',
   'Your request to join {{group_name}} was approved.', '{{group_name}} এ যোগদানের আপনার অনুরোধ অনুমোদিত হয়েছে।', '/groups', true),
  ('pvp_challenge', 'Battle challenge received', 'ব্যাটল চ্যালেঞ্জ পেয়েছেন',
   '{{challenger}} challenged you to a battle. Accept now.', '{{challenger}} আপনাকে ব্যাটলে চ্যালেঞ্জ করেছেন। এখনই গ্রহণ করুন।', '/groups', true),
  ('pvp_result', 'Battle result', 'ব্যাটলের ফলাফল',
   'Your battle result is ready.', 'আপনার ব্যাটলের ফলাফল প্রস্তুত।', '/groups', true),
  ('community_reply', 'New reply', 'নতুন উত্তর',
   '{{actor}} replied to your post.', '{{actor}} আপনার পোস্টে উত্তর দিয়েছেন।', '/groups', true),
  ('premium_purchased', 'Premium activated', 'প্রিমিয়াম চালু হয়েছে',
   'Your {{plan}} plan is now active.', 'আপনার {{plan}} প্ল্যান চালু হয়েছে।', '/premium', true),
  ('premium_expiring', 'Premium expires soon', 'প্রিমিয়াম শীঘ্রই শেষ হবে',
   'Your premium plan expires in {{days}} days. Renew to keep access.', 'আপনার প্রিমিয়াম প্ল্যান {{days}} দিনে শেষ হবে। অ্যাক্সেস ধরে রাখতে নবায়ন করুন।', '/premium', true),
  ('premium_granted', 'Premium granted', 'প্রিমিয়াম দেওয়া হয়েছে',
   'An administrator granted you {{grant}} access.', 'একজন অ্যাডমিন আপনাকে {{grant}} অ্যাক্সেস দিয়েছেন।', '/premium', true),
  ('quota_exhausted', 'Daily free limit reached', 'দৈনিক ফ্রি সীমা শেষ',
   'You used today''s free {{feature}} limit. It resets tomorrow.', 'আজকের ফ্রি {{feature}} সীমা শেষ হয়েছে। আগামীকাল রিসেট হবে।', '/premium', true),
  ('referral_bonus', 'Referral bonus earned', 'রেফারেল বোনাস অর্জিত',
   'You earned {{amount}} coins from a referral.', 'রেফারেল থেকে আপনি {{amount}} কয়েন পেয়েছেন।', '/referral', true),
  ('new_device_login', 'New device login', 'নতুন ডিভাইসে লগইন',
   'A new device signed in: {{device}}. If this was not you, change your password.', 'একটি নতুন ডিভাইসে লগইন হয়েছে: {{device}}। এটি আপনি না হলে পাসওয়ার্ড পরিবর্তন করুন।', '/change-password', true)
on conflict (template_code) do nothing;

-- 4. RLS: users read only their own rows; only the backend may create ----------
drop policy if exists "Users can view their notifications" on public.notifications;
drop policy if exists "Users can read their notifications" on public.notifications;

create policy "Users can read their notifications"
  on public.notifications
  for select
  to authenticated
  using (target_user_id = (select auth.uid()));

drop policy if exists "Users can manage their own data" on public.notification_reads;
drop policy if exists "Users can read their own read state" on public.notification_reads;
drop policy if exists "Users can insert their own read state" on public.notification_reads;
drop policy if exists "Users can update their own read state" on public.notification_reads;

create policy "Users can read their own read state"
  on public.notification_reads
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can insert their own read state"
  on public.notification_reads
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy "Users can update their own read state"
  on public.notification_reads
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke insert, update, delete on public.notifications from anon, authenticated;
revoke insert, update, delete on public.notification_templates from anon, authenticated;

-- 5. Unread count helpers -----------------------------------------------------
create or replace function public.get_my_unread_notification_count()
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)::integer
    from public.notifications n
   where n.target_user_id = auth.uid()
     and n.status = 'sent'
     and (n.expires_at is null or n.expires_at > now())
     and not exists (
       select 1
         from public.notification_reads r
        where r.notification_id = n.id
          and r.user_id = auth.uid()
          and r.is_read
     );
$$;

revoke all on function public.get_my_unread_notification_count() from public;
grant execute on function public.get_my_unread_notification_count() to authenticated;

create or replace function public.get_unread_notification_count_for_user(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
    from public.notifications n
   where n.target_user_id = p_user_id
     and n.status = 'sent'
     and (n.expires_at is null or n.expires_at > now())
     and not exists (
       select 1
         from public.notification_reads r
        where r.notification_id = n.id
          and r.user_id = p_user_id
          and r.is_read
     );
$$;

revoke all on function public.get_unread_notification_count_for_user(uuid) from public;
revoke all on function public.get_unread_notification_count_for_user(uuid) from anon;
revoke all on function public.get_unread_notification_count_for_user(uuid) from authenticated;
grant execute on function public.get_unread_notification_count_for_user(uuid) to service_role;

-- 6. Keep the existing PvP trigger inside the standard type set ----------------
create or replace function public.notify_new_pvp_challenge()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  insert into notifications
    (target_user_id, title_bn, title_en, body_bn, body_en, type, channel, status, event_code, meta_data)
  values (
    new.opponent_id,
    'নতুন কুইজ ব্যাটল! ⚔️',
    'New Quiz Battle! ⚔️',
    'একজন বন্ধু আপনাকে চ্যালেঞ্জ করেছে। এখনই গ্রহণ করুন!',
    'A friend has challenged you. Accept now!',
    'social',
    'in_app',
    'sent',
    'pvp_challenge',
    jsonb_build_object('challenge_id', new.id, 'challenger_id', new.challenger_id)
  );
  return new;
end;
$$;
