-- Supabase's default privileges grant EXECUTE to anon/service roles on new
-- public functions. These two RPCs must only ever run for a signed-in user.
revoke all on function public.complete_onboarding(
  text, text, text, text, text, text, text, text[], text
) from anon;

revoke all on function public.update_academic_profile(
  text, text, text[], text
) from anon;

grant execute on function public.complete_onboarding(
  text, text, text, text, text, text, text, text[], text
) to authenticated, service_role;

grant execute on function public.update_academic_profile(
  text, text, text[], text
) to authenticated, service_role;
