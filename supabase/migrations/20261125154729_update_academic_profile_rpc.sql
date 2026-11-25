-- Existing students can complete or edit their academic profile later without
-- re-registering. SECURITY DEFINER keeps validation in one place and only ever
-- touches the caller's own row.
create or replace function public.update_academic_profile(
  p_hsc_batch text default null,
  p_hsc_group text default null,
  p_admission_targets text[] default null,
  p_other_admission_target text default null
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_batch text := nullif(btrim(p_hsc_batch), '');
  v_group text := nullif(btrim(p_hsc_group), '');
  v_targets text[] := coalesce(
    array(
      select distinct t
      from unnest(coalesce(p_admission_targets, array[]::text[])) as t
      where t is not null and btrim(t) <> ''
    ),
    array[]::text[]
  );
  v_other text := nullif(btrim(p_other_admission_target), '');
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if v_batch is not null and v_batch !~ '^[0-9]{4}$' then
    raise exception 'invalid hsc batch';
  end if;

  if v_group is not null
     and v_group not in ('science', 'humanities', 'business_studies')
  then
    raise exception 'invalid hsc group';
  end if;

  if exists (
    select 1
    from unnest(v_targets) as t
    where t not in (
      'university',
      'engineering',
      'medical',
      'dental',
      'agricultural',
      'general_university',
      'national_university',
      'other'
    )
  ) then
    raise exception 'invalid admission target';
  end if;

  if v_other is not null and char_length(v_other) > 100 then
    raise exception 'invalid other admission target';
  end if;

  if not ('other' = any(v_targets)) then
    v_other := null;
  end if;

  update public.profiles
  set hsc_batch = v_batch,
      hsc_group = v_group,
      admission_targets = v_targets,
      other_admission_target = v_other
  where id = auth.uid();
end;
$function$;

revoke all on function public.update_academic_profile(text, text, text[], text) from public;
grant execute on function public.update_academic_profile(text, text, text[], text)
  to authenticated, service_role;
