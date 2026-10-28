-- Unread badges must match the list: hidden (push-only, disabled type or
-- disabled in-app) notifications do not count as unread.
CREATE OR REPLACE FUNCTION public.get_unread_notification_count_for_user(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT count(*)::integer
  FROM public.notifications n
  JOIN public.profiles p ON p.id = p_user_id
  WHERE n.target_user_id = p_user_id
    AND n.status = 'sent'
    AND (n.expires_at IS NULL OR n.expires_at > now())
    AND n.channel IN ('in_app', 'both')
    AND (
      n.type IN ('billing', 'security')
      OR coalesce((p.settings -> 'notification_preferences' -> 'types' ->> n.type)::boolean, true)
    )
    AND (
      n.type IN ('billing', 'security')
      OR coalesce((p.settings -> 'notification_preferences' ->> 'in_app')::boolean, true)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.notification_reads r
      WHERE r.notification_id = n.id
        AND r.user_id = p_user_id
        AND r.is_read = true
    );
$function$;

CREATE OR REPLACE FUNCTION public.get_my_unread_notification_count()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT public.get_unread_notification_count_for_user(auth.uid());
$function$;

revoke all on function public.get_unread_notification_count_for_user(uuid) from public, anon, authenticated;
grant execute on function public.get_unread_notification_count_for_user(uuid) to service_role;

revoke all on function public.get_my_unread_notification_count() from public, anon;
grant execute on function public.get_my_unread_notification_count() to authenticated;
