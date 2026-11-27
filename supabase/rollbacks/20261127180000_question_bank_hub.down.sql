-- Rollback for 20261127180000_question_bank_hub.sql.
--
-- Drops the hub function and restores _qb_base exactly as
-- 20261127120000_question_bank_levels.sql defined it. The restore matters:
-- without it, the list and the facets would keep the narrower exam_year
-- condition while the migration is gone, and "RU 2022-23" would answer 396
-- instead of the 399 the pre-hub code returned.
--
-- No data is touched by the migration or by this file.
--
-- Order: drop the reader first, then redefine the function it read from.

drop function if exists public.get_question_bank_hub(text);

create or replace function public._qb_base(
  p_user_id uuid,
  p_stage text,
  p_level text,
  p_track text,
  p_include_other_admission_tracks boolean,
  p_subject_id text,
  p_chapter_id text,
  p_topic_id text,
  p_institution_id uuid,
  p_admission_unit_id uuid,
  p_year text,
  p_search text,
  p_bookmarked_only boolean,
  p_mistakes_only boolean,
  p_premium_only boolean,
  p_has_premium boolean,
  p_ignore text default null
)
returns table (
  question_id uuid,
  subject_id text,
  chapter_id text,
  topic_id text,
  total_attempts integer,
  correct_attempts integer,
  created_at timestamp with time zone,
  exam_year text,
  is_hsc boolean,
  is_admission boolean,
  track_ids text[],
  s_id text,
  s_name_bn text,
  s_name_en text,
  s_slug text,
  s_prem boolean,
  s_seq integer,
  c_id text,
  c_name_bn text,
  c_name_en text,
  c_slug text,
  c_prem boolean,
  c_seq integer,
  t_id text,
  t_name_bn text,
  t_name_en text,
  t_slug text,
  t_prem boolean,
  t_seq integer,
  t_total integer,
  ref_institution_id uuid,
  ref_institution_name_bn text,
  ref_institution_name_en text,
  ref_institution_short text,
  ref_admission_unit_id uuid,
  ref_unit_name_bn text,
  ref_unit_code text,
  body_text text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_level text;
  v_track text;
  v_subject_id text := nullif(btrim(coalesce(p_subject_id, '')), '');
  v_chapter_id text := nullif(btrim(coalesce(p_chapter_id, '')), '');
  v_topic_id text := nullif(btrim(coalesce(p_topic_id, '')), '');
  v_year text := nullif(btrim(coalesce(p_year, '')), '');
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if p_user_id is null then
    raise exception 'invalid_arguments' using errcode = '22023';
  end if;

  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'forbidden' using errcode = 'P0403';
  end if;

  if p_track is not null and p_track not in ('varsity', 'medical', 'engineering') then
    raise exception 'invalid_arguments' using errcode = '22023';
  end if;

  if p_ignore is not null and p_ignore not in (
    'subject', 'chapter', 'topic', 'institution', 'admission_unit', 'exam_year'
  ) then
    raise exception 'invalid_arguments' using errcode = '22023';
  end if;

  if p_stage = 'admission_prep' and coalesce(p_level, 'admission') = 'hsc' then
    return;
  end if;

  if p_stage is null or p_stage = 'post_hsc' then
    return;
  end if;

  v_level := case
    when p_stage = 'admission_prep' then 'admission'
    else coalesce(p_level, 'hsc')
  end;

  if v_level not in ('hsc', 'admission') then
    raise exception 'invalid_arguments' using errcode = '22023';
  end if;

  v_track := case
    when v_level = 'admission' and not coalesce(p_include_other_admission_tracks, false)
      then p_track
    else null
  end;

  return query
  select
    q.id,
    q.subject_id,
    q.chapter_id,
    q.topic_id,
    coalesce(q.total_attempts, 0),
    coalesce(q.correct_attempts, 0),
    q.created_at,
    coalesce(nullif(btrim(r.exam_year_label), ''), r.exam_year::text),
    l.is_hsc,
    l.is_admission,
    l.track_ids,
    s.id, s.name_bn, s.name_en, s.slug, s.is_premium, s.sequence,
    c.id, c.name_bn, c.name_en, c.slug, c.is_premium, c.sequence,
    t.id, t.name_bn, t.name_en, t.slug, t.is_premium, t.sequence, t.total_questions,
    r.institution_id,
    ri.name_bn,
    ri.name_en,
    ri.short_name,
    r.admission_unit_id,
    au.name_bn,
    au.code,
    concat_ws(' ',
      q.body ->> 'text_bn',
      q.body ->> 'text_en',
      q.body ->> 'text',
      q.body ->> 'bn',
      q.body ->> 'en'
    )
  from public.questions q
  join public.subjects s on s.id = q.subject_id and s.is_active is true
  join public.v_question_levels l on l.question_id = q.id
  left join public.chapters c on c.id = q.chapter_id
  left join public.topics t on t.id = q.topic_id
  left join lateral (
    select
      ref.institution_id,
      ref.admission_unit_id,
      ref.exam_year,
      ref.exam_year_label
    from public.question_institution_references ref
    join public.institutions refi on refi.id = ref.institution_id
    where ref.question_id = q.id
      and refi.type = 'university'
    order by
      (ref.institution_id = p_institution_id) desc nulls last,
      (ref.admission_unit_id = p_admission_unit_id) desc nulls last,
      (coalesce(nullif(btrim(ref.exam_year_label), ''), ref.exam_year::text) = v_year) desc nulls last,
      ref.exam_year desc nulls last,
      ref.created_at
    limit 1
  ) r on true
  left join public.institutions ri on ri.id = r.institution_id
  left join public.admission_units au on au.id = r.admission_unit_id
  where q.status = 'published'
    and q.is_active is true
    and q.deleted_at is null
    and (q.chapter_id is null or c.is_active is true)
    and (q.topic_id is null or t.is_active is true)
    and (v_level <> 'hsc' or l.is_hsc)
    and (v_level <> 'admission' or l.is_admission)
    and (v_track is null or v_track = any (l.track_ids))
    and (p_ignore = 'subject' or v_subject_id is null or q.subject_id = v_subject_id)
    and (p_ignore = 'chapter' or v_chapter_id is null or q.chapter_id = v_chapter_id)
    and (p_ignore = 'topic' or v_topic_id is null or q.topic_id = v_topic_id)
    and (
      p_ignore = 'institution'
      or p_institution_id is null
      or exists (
        select 1 from public.question_institution_references ir
        where ir.question_id = q.id and ir.institution_id = p_institution_id
      )
    )
    and (
      p_ignore = 'admission_unit'
      or p_admission_unit_id is null
      or exists (
        select 1 from public.question_institution_references ur
        where ur.question_id = q.id and ur.admission_unit_id = p_admission_unit_id
      )
    )
    and (
      p_ignore = 'exam_year'
      or v_year is null
      or exists (
        select 1 from public.question_institution_references yr
        where yr.question_id = q.id
          and coalesce(nullif(btrim(yr.exam_year_label), ''), yr.exam_year::text) = v_year
      )
    )
    and (
      v_search is null
      or concat_ws(' ',
           q.body ->> 'text_bn',
           q.body ->> 'text_en',
           q.body ->> 'text',
           q.body ->> 'bn',
           q.body ->> 'en'
         ) ilike '%' || v_search || '%'
      or coalesce(q.explanation ->> 'bn', '') ilike '%' || v_search || '%'
      or coalesce(q.explanation ->> 'en', '') ilike '%' || v_search || '%'
      or exists (
        select 1
        from jsonb_array_elements(
          case when jsonb_typeof(q.options) = 'array' then q.options else '[]'::jsonb end
        ) as opt
        where coalesce(opt ->> 'text_bn', '') ilike '%' || v_search || '%'
           or coalesce(opt ->> 'text_en', '') ilike '%' || v_search || '%'
      )
    )
    and (
      coalesce(p_bookmarked_only, false) is false
      or exists (
        select 1 from public.bookmarks b
        where b.question_id = q.id and b.user_id = p_user_id
      )
    )
    and (
      coalesce(p_mistakes_only, false) is false
      or exists (
        select 1 from public.user_mistake_questions(p_user_id) m
        where m.question_id = q.id
      )
    )
    and (
      coalesce(p_premium_only, false) is false
      or coalesce(s.is_premium, false)
      or coalesce(c.is_premium, false)
      or coalesce(t.is_premium, false)
    )
    and not exists (
      select 1
      from public.exam_paper_questions epq
      join public.exam_papers ep on ep.id = epq.exam_id
      where epq.question_id = q.id
        and ep.is_published
        and ep.start_time is not null
        and ep.start_time <= now()
        and (ep.end_time is null or ep.end_time > now())
    );
end;
$function$;

revoke all on function public._qb_base(
  uuid, text, text, text, boolean, text, text, text, uuid, uuid, text, text,
  boolean, boolean, boolean, boolean, text
) from public, anon, authenticated;
grant execute on function public._qb_base(
  uuid, text, text, text, boolean, text, text, text, uuid, uuid, text, text,
  boolean, boolean, boolean, boolean, text
) to service_role;
