-- Harden notification functions and anonymous table access.

revoke all on function public.get_my_unread_notification_count() from public, anon;
grant execute on function public.get_my_unread_notification_count() to authenticated;

revoke all on function public.get_unread_notification_count_for_user(uuid) from public, anon, authenticated;
grant execute on function public.get_unread_notification_count_for_user(uuid) to service_role;

revoke all on table public.notification_reads from anon;
revoke truncate, trigger, references on table public.notification_reads from authenticated;

revoke all on table public.notification_templates from anon;
revoke truncate, trigger, references on table public.notification_templates from authenticated;

revoke truncate, trigger, references on table public.notifications from anon, authenticated;
