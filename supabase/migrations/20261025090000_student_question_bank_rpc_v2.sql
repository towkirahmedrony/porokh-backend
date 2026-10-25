-- Student question bank RPC v2 — pagination, server-side filters, count.
--
-- Status: NOT YET APPLIED to the live project. Apply through the established
-- Supabase workflow (dashboard SQL editor or `supabase db push`) before the
-- frontend relies on it. The frontend feature-detects this function and falls
-- back to the v1 RPC (`get_student_question_bank(text,text,text,text)`) when it
-- is absent, so deploying the frontend first is safe.
--
-- Why a new function name instead of replacing v1:
--   * PostgREST resolves RPC calls by argument set; adding parameters to the
--     existing name creates an overload and risks ambiguity errors for the
--     currently deployed frontend.
--   * The v1 function stays the compatibility path. This file does not touch it.
--
-- What v2 fixes (all defects confirmed in the current implementation):
--   1. v1 returns at most 100 rows with no offset, so the UI silently truncated
--      results and every client-side filter (bookmarks, mistakes, search, year,
--      institution) only ever saw that first page.
--   2. Search/bookmark/mistake filtering happened in the browser, which cannot
--      work correctly over a truncated page.
--   3. The payload included every field needed by the page regardless of how
--      many rows the student would actually look at.
--
-- Preserved from v1 (must not regress):
--   * security definer with an empty search_path and fully qualified names.
--   * execute revoked from public/anon; granted to authenticated only.
--   * premium rows redacted (empty body, no options, no explanation) when the
--     caller has no premium access — enforced here, not in the UI.
--   * answer-key fields are never returned.
--   * questions that belong to a live/unscheduled-ending exam paper are
--     excluded so an active exam cannot be read from the question bank.
--   * deterministic ordering with `id` as the final tiebreaker so pagination
--     cannot skip or duplicate rows.

create or replace function public.get_student_question_bank_v2(
  p_subject_id text default null,
  p_chapter_id text default null,
  p_topic_id text default null,
  p_sort text default 'newest',
  p_search text default null,
  p_bookmarked_only boolean default false,
  p_mistakes_only boolean default false,
  p_premium_only boolean default false,
  p_institution_type text default null,
  p_institution_eiin text default null,
  p_year text default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_access jsonb;
  v_has_premium boolean := false;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  v_access := public.get_user_access(v_uid);
  v_has_premium := coalesce((v_access->>'premium')::boolean, false)
    or coalesce((v_access->>'unlimited_all')::boolean, false);

  return query
  select jsonb_build_object(
    'id', r.id,
    'type', r.type,
    'difficulty_level', r.difficulty_level,
    'source_type', r.source_type,
    'tags', coalesce(to_jsonb(r.tags), '[]'::jsonb),
    'exam_references', coalesce(r.exam_references, '[]'::jsonb),
    'subject_id', r.subject_id,
    'chapter_id', r.chapter_id,
    'topic_id', r.topic_id,
    'total_attempts', coalesce(r.total_attempts, 0),
    'correct_attempts', coalesce(r.correct_attempts, 0),
    'created_at', r.created_at,
    'total_count', r.total_count,
    'body',
      case
        when r.locked then '{}'::jsonb
        else jsonb_strip_nulls(
          jsonb_build_object(
            'text_bn', case when jsonb_typeof(r.body -> 'text_bn') = 'string' then r.body -> 'text_bn' end,
            'text_en', case when jsonb_typeof(r.body -> 'text_en') = 'string' then r.body -> 'text_en' end,
            'image_url', case when jsonb_typeof(r.body -> 'image_url') = 'string' then r.body -> 'image_url' end
          )
        )
      end,
    'options',
      case
        when r.locked or jsonb_typeof(r.options) <> 'array' then '[]'::jsonb
        else (
          select coalesce(
            jsonb_agg(
              jsonb_strip_nulls(
                jsonb_build_object(
                  'id', case when jsonb_typeof(o.item -> 'id') in ('string', 'number') then o.item -> 'id' end,
                  'text_bn', case when jsonb_typeof(o.item -> 'text_bn') = 'string' then o.item -> 'text_bn' end,
                  'text_en', case when jsonb_typeof(o.item -> 'text_en') = 'string' then o.item -> 'text_en' end
                )
              )
              order by o.ord
            ),
            '[]'::jsonb
          )
          from jsonb_array_elements(r.options) with ordinality as o(item, ord)
        )
      end,
    'explanation', case when r.locked then null else to_jsonb(r.explanation) end,
    'subjects', jsonb_build_object(
      'id', r.s_id,
      'name_bn', r.s_name_bn,
      'name_en', r.s_name_en,
      'slug', r.s_slug,
      'is_premium', r.s_prem,
      'sequence', r.s_seq
    ),
    'chapters', case when r.c_id is null then null else jsonb_build_object(
      'id', r.c_id,
      'subject_id', r.subject_id,
      'name_bn', r.c_name_bn,
      'name_en', r.c_name_en,
      'slug', r.c_slug,
      'is_premium', r.c_prem,
      'sequence', r.c_seq
    ) end,
    'topics', case when r.t_id is null then null else jsonb_build_object(
      'id', r.t_id,
      'chapter_id', r.chapter_id,
      'name_bn', r.t_name_bn,
      'name_en', r.t_name_en,
      'slug', r.t_slug,
      'is_premium', r.t_prem,
      'sequence', r.t_seq,
      'total_questions', r.t_total
    ) end
  )
  from (
    select
      q.*,
      s.id as s_id,
      s.name_bn as s_name_bn,
      s.name_en as s_name_en,
      s.slug as s_slug,
      s.is_premium as s_prem,
      s.sequence as s_seq,
      c.id as c_id,
      c.name_bn as c_name_bn,
      c.name_en as c_name_en,
      c.slug as c_slug,
      c.is_premium as c_prem,
      c.sequence as c_seq,
      t.id as t_id,
      t.name_bn as t_name_bn,
      t.name_en as t_name_en,
      t.slug as t_slug,
      t.is_premium as t_prem,
      t.sequence as t_seq,
      t.total_questions as t_total,
      (
        (
          coalesce(s.is_premium, false)
          or coalesce(c.is_premium, false)
          or coalesce(t.is_premium, false)
        )
        and not v_has_premium
      ) as locked,
      count(*) over () as total_count
    from public.questions q
    join public.subjects s on s.id = q.subject_id and s.is_active is true
    left join public.chapters c on c.id = q.chapter_id
    left join public.topics t on t.id = q.topic_id
    where q.status = 'published'
      and q.is_active is true
      and q.deleted_at is null
      and (q.chapter_id is null or c.is_active is true)
      and (q.topic_id is null or t.is_active is true)
      and (p_subject_id is null or p_subject_id = '' or q.subject_id = p_subject_id)
      and (p_chapter_id is null or p_chapter_id = '' or q.chapter_id = p_chapter_id)
      and (p_topic_id is null or p_topic_id = '' or q.topic_id = p_topic_id)
      and (
        p_institution_type is null
        or p_institution_type = ''
        or q.source_type = p_institution_type
      )
      and (
        p_institution_eiin is null
        or p_institution_eiin = ''
        or exists (
          select 1
          from jsonb_array_elements(coalesce(q.exam_references, '[]'::jsonb)) as ref
          where ref ->> 'eiin' = p_institution_eiin
        )
      )
      and (
        p_year is null
        or p_year = ''
        or exists (
          select 1
          from jsonb_array_elements(coalesce(q.exam_references, '[]'::jsonb)) as ref
          where ref ->> 'year' = p_year
        )
        or coalesce(q.tags, '{}'::text[]) @> array[p_year]::text[]
      )
      and (
        v_search is null
        or coalesce(q.body ->> 'text_bn', '') ilike '%' || v_search || '%'
        or coalesce(q.body ->> 'text_en', '') ilike '%' || v_search || '%'
        or coalesce(q.explanation, '') ilike '%' || v_search || '%'
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
          where b.question_id = q.id and b.user_id = v_uid
        )
      )
      and (
        coalesce(p_mistakes_only, false) is false
        or exists (
          select 1 from public.wrong_answers w
          where w.question_id = q.id and w.user_id = v_uid
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
          and (ep.end_time is null or ep.end_time > now())
      )
    order by
      case when p_sort = 'oldest' then q.created_at end asc nulls last,
      case when p_sort = 'most_attempted' then q.total_attempts end desc nulls last,
      case when p_sort = 'least_attempted' then q.total_attempts end asc nulls last,
      q.created_at desc,
      q.id asc
    limit v_limit
    offset v_offset
  ) r;
end;
$$;

revoke all on function public.get_student_question_bank_v2(
  text, text, text, text, text, boolean, boolean, boolean, text, text, text, integer, integer
) from public, anon;

grant execute on function public.get_student_question_bank_v2(
  text, text, text, text, text, boolean, boolean, boolean, text, text, text, integer, integer
) to authenticated;

comment on function public.get_student_question_bank_v2(
  text, text, text, text, text, boolean, boolean, boolean, text, text, text, integer, integer
) is
  'Paginated, server-filtered student question bank read. Redacts premium rows, never returns answer keys, excludes questions used by live exam papers. Callable by authenticated role only.';
