-- Question Bank hub: one round trip that returns the sections a student may
-- browse, already ordered by their stage and goal.
--
-- Why the hub exists: the bank used to open on 3,467 admission questions with a
-- filter sheet. The filters work; the entrance does not. A student needs to
-- pick a subject, a board, a college, a university or a track first, and that
-- choice needs the same number the list will show afterwards.
--
-- Two guarantees hold this together:
--
--   1. Every count is taken over public._qb_base, the same row source the list
--      RPC reads. A hub row and the list it opens cannot disagree.
--   2. The stage and the goal come from get_my_stage() for auth.uid(). No
--      parameter can name a user or a stage, so a client cannot ask for content
--      its stage hides. An admission-prep student gets admission sections even
--      when it sends p_mode = 'hsc'.
--
-- One correction is carried here too. _qb_base filtered exam years with a
-- reference row that did not have to be the same row as the selected
-- institution or unit, so "RU 2022-23" returned 399 questions while the facet
-- offered 396: three questions that name RU and, separately, a 2022-23 paper
-- from another university. The hub's year rows must equal the list they open,
-- so the year condition now reads the same reference row as the institution and
-- unit filters. The function keeps its signature, so the list and facet RPCs
-- that call it are untouched.

-- ---------------------------------------------------------------------------
-- 1. One reference row per filter combination
-- ---------------------------------------------------------------------------
-- Body copied from 20261127120000_question_bank_levels.sql with the exam_year
-- condition joined to the institution and unit conditions. Everything else,
-- including the live-paper test and the stage rule, is unchanged.
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

  -- Defence in depth: every public entry point passes auth.uid(), so a mismatch
  -- means this function was reached some other way.
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

  -- A student whose HSC is over is never shown HSC content, whatever the client
  -- asks for.
  if p_stage = 'admission_prep' and coalesce(p_level, 'admission') = 'hsc' then
    return;
  end if;

  -- post_hsc is sent to the goal gate before it reaches the bank.
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
  -- The chip names the reference the current filter is about, so a question
  -- that appeared in three university exams labels itself with the one the
  -- student is looking at.
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
    -- Year, institution and unit are read from the same reference row. Read
    -- separately, "RU 2022-23" also returned a question that names RU and,
    -- through a different reference, a 2022-23 paper from another university:
    -- 399 rows against the 396 the year facet offered for the same filter.
    and (
      p_ignore = 'exam_year'
      or v_year is null
      or exists (
        select 1 from public.question_institution_references yr
        where yr.question_id = q.id
          and coalesce(nullif(btrim(yr.exam_year_label), ''), yr.exam_year::text) = v_year
          and (p_institution_id is null or yr.institution_id = p_institution_id)
          and (p_admission_unit_id is null or yr.admission_unit_id = p_admission_unit_id)
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
    -- A paper hides its questions only while it is genuinely running: published,
    -- already started, and not yet ended. Every archived paper in this project is
    -- stored with start_time and end_time both null.
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

-- ---------------------------------------------------------------------------
-- 2. The hub
-- ---------------------------------------------------------------------------
-- The payload is one jsonb object:
--
--   stage   what get_my_stage() answered, so the app can show its neutral state
--           without a second request
--   goal    profiles.study_goal as the server sees it
--   mode    'hsc' | 'admission' | null: the sections that follow are this mode's
--   sections an ordered array; each section carries its own kind
--
-- Section kinds:
--
--   hsc_subjects  { rows }   subjects holding HSC questions
--   hsc_boards    { rows }   boards holding HSC questions
--   hsc_colleges  { rows }   colleges holding HSC questions (all of them; the
--                            app shows the top eight and the rest on its own
--                            searchable page)
--   all_admission { count }  every admission question
--   track         { track, count, primary, universities?, university_total?,
--                   subjects? }
--
-- Rows are { id, label_bn, label_en, short_name, count }. Only rows with at
-- least one question are returned, which is what keeps 161 empty colleges and
-- six empty engineering universities out of the screen.
create or replace function public.get_question_bank_hub(p_mode text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_stage_response jsonb;
  v_stage text;
  v_goal text;
  v_mode text;
  v_ids uuid[];
  v_order text[];
  v_primary text;
  v_track text;
  v_count integer;
  v_rows jsonb;
  v_subjects jsonb;
  v_sections jsonb := '[]'::jsonb;
  v_section jsonb;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  -- The mode is a tab, not a permission. Anything else is a client bug.
  if p_mode is not null and p_mode not in ('hsc', 'admission') then
    raise exception 'invalid_arguments' using errcode = '22023';
  end if;

  -- No profile means no server-side stage, and a stage-less student has no
  -- bank. Guessing one would paint content the student may not see.
  if not exists (select 1 from public.profiles p where p.id = v_uid) then
    return jsonb_build_object(
      'stage', null, 'goal', null, 'mode', null, 'sections', '[]'::jsonb
    );
  end if;

  v_stage_response := public.get_my_stage();
  v_stage := v_stage_response ->> 'stage';
  v_goal := v_stage_response ->> 'goal';

  -- An admission-prep student's mode is never read from the parameter: the
  -- answer is admission whatever the client sent, so no request can reach the
  -- HSC sections.
  v_mode := case
    when v_stage = 'studying' then coalesce(p_mode, 'hsc')
    when v_stage = 'admission_prep' then 'admission'
    else null
  end;

  if v_mode is null then
    return jsonb_build_object(
      'stage', v_stage, 'goal', v_goal, 'mode', null, 'sections', '[]'::jsonb
    );
  end if;

  -- One read of the row source every count below is taken over. The track is
  -- left open on purpose: the sections sort by track afterwards, and the
  -- per-track numbers come from the tags on these same rows, so tapping
  -- "ভার্সিটি" returns exactly the count shown beside it.
  select coalesce(array_agg(b.question_id), '{}'::uuid[])
    into v_ids
    from public._qb_base(
      v_uid, v_stage, v_mode, null, false,
      null, null, null, null, null, null, null,
      false, false, false, false, null
    ) b;

  if v_mode = 'hsc' then
    select jsonb_build_object(
      'kind', 'hsc_subjects',
      'rows', coalesce(jsonb_agg(
        jsonb_build_object(
          'id', x.id,
          'label_bn', x.name_bn,
          'label_en', x.name_en,
          'count', x.cnt
        )
        order by x.cnt desc, x.name_bn
      ), '[]'::jsonb)
    )
    into v_section
    from (
      select
        q.subject_id as id,
        min(s.name_bn) as name_bn,
        min(s.name_en) as name_en,
        count(*)::integer as cnt
      from public.questions q
      join public.subjects s on s.id = q.subject_id
      where q.id = any (v_ids)
      group by q.subject_id
    ) x;

    if jsonb_array_length(v_section -> 'rows') > 0 then
      v_sections := v_sections || jsonb_build_array(v_section);
    end if;

    select jsonb_build_object(
      'kind', 'hsc_boards',
      'rows', coalesce(jsonb_agg(
        jsonb_build_object(
          'id', x.id::text,
          'label_bn', x.name_bn,
          'label_en', x.name_en,
          'short_name', x.short_name,
          'count', x.cnt
        )
        order by x.cnt desc, x.name_bn
      ), '[]'::jsonb)
    )
    into v_section
    from (
      select
        i.id,
        i.name_bn,
        i.name_en,
        i.short_name,
        count(distinct r.question_id)::integer as cnt
      from public.question_institution_references r
      join public.institutions i on i.id = r.institution_id and i.type = 'board'
      where r.question_id = any (v_ids)
      group by i.id, i.name_bn, i.name_en, i.short_name
    ) x;

    if jsonb_array_length(v_section -> 'rows') > 0 then
      v_sections := v_sections || jsonb_build_array(v_section);
    end if;

    select jsonb_build_object(
      'kind', 'hsc_colleges',
      'rows', coalesce(jsonb_agg(
        jsonb_build_object(
          'id', x.id::text,
          'label_bn', x.name_bn,
          'label_en', x.name_en,
          'short_name', x.short_name,
          'count', x.cnt
        )
        order by x.cnt desc, x.name_bn
      ), '[]'::jsonb)
    )
    into v_section
    from (
      select
        i.id,
        i.name_bn,
        i.name_en,
        i.short_name,
        count(distinct r.question_id)::integer as cnt
      from public.question_institution_references r
      join public.institutions i on i.id = r.institution_id and i.type = 'college'
      where r.question_id = any (v_ids)
      group by i.id, i.name_bn, i.name_en, i.short_name
    ) x;

    if jsonb_array_length(v_section -> 'rows') > 0 then
      v_sections := v_sections || jsonb_build_array(v_section);
    end if;

    -- A hub with nothing in it is a bug, not a screen: the app renders its
    -- empty state from the empty array rather than from a fake section.
    return jsonb_build_object(
      'stage', v_stage, 'goal', v_goal, 'mode', 'hsc', 'sections', v_sections
    );
  end if;

  -- The goal's own section comes first; the remaining two keep a fixed order so
  -- the screen does not reshuffle between two students with the same goal.
  v_order := case coalesce(v_goal, 'varsity')
    when 'medical' then array['medical', 'varsity', 'engineering']
    when 'engineering' then array['engineering', 'varsity', 'medical']
    else array['varsity', 'medical', 'engineering']
  end;
  v_primary := v_order[1];

  v_sections := v_sections || jsonb_build_array(
    jsonb_build_object('kind', 'all_admission', 'count', coalesce(array_length(v_ids, 1), 0))
  );

  -- Subject counts are level-wide, not goal-wide: the row opens the list for
  -- that subject across every admission track, and its number has to say so.
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', x.id,
      'label_bn', x.name_bn,
      'label_en', x.name_en,
      'count', x.cnt
    )
    order by x.cnt desc, x.name_bn
  ), '[]'::jsonb)
  into v_subjects
  from (
    select
      q.subject_id as id,
      min(s.name_bn) as name_bn,
      min(s.name_en) as name_en,
      count(*)::integer as cnt
    from public.questions q
    join public.subjects s on s.id = q.subject_id
    where q.id = any (v_ids)
    group by q.subject_id
  ) x;

  foreach v_track in array v_order loop
    select count(*)::integer
      into v_count
      from public.question_preparation_tracks t
     where t.question_id = any (v_ids)
       and t.track_id = v_track;

    v_section := jsonb_build_object(
      'kind', 'track',
      'track', v_track,
      'count', v_count,
      'primary', v_track = v_primary
    );

    -- Universities carry admission questions; medical and engineering are
    -- hand-tagged and reference no institution, so they get no rows at all
    -- instead of six empty cards.
    if v_track = 'varsity' then
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'id', x.id::text,
          'label_bn', x.name_bn,
          'label_en', x.name_en,
          'short_name', x.short_name,
          'count', x.cnt
        )
        order by x.cnt desc, x.name_bn
      ), '[]'::jsonb)
      into v_rows
      from (
        select
          i.id,
          i.name_bn,
          i.name_en,
          i.short_name,
          count(distinct r.question_id)::integer as cnt
        from public.question_institution_references r
        join public.institutions i on i.id = r.institution_id and i.type = 'university'
        where r.question_id = any (v_ids)
        group by i.id, i.name_bn, i.name_en, i.short_name
      ) x;

      v_section := v_section || jsonb_build_object(
        'universities', v_rows,
        'university_total', jsonb_array_length(v_rows)
      );
    end if;

    if v_track = v_primary then
      v_section := v_section || jsonb_build_object('subjects', v_subjects);
    end if;

    -- A non-goal track with nothing in it is noise; the goal track is kept even
    -- at zero so the app can offer the way out instead of a blank area.
    if v_count > 0 or v_track = v_primary then
      v_sections := v_sections || jsonb_build_array(v_section);
    end if;
  end loop;

  return jsonb_build_object(
    'stage', v_stage, 'goal', v_goal, 'mode', 'admission', 'sections', v_sections
  );
end;
$function$;

comment on function public.get_question_bank_hub(text) is
  'Question Bank hub: ordered sections for the caller''s stage and goal, counted over _qb_base.';

revoke all on function public.get_question_bank_hub(text) from public, anon, authenticated;
grant execute on function public.get_question_bank_hub(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------
-- None. Every count is a pass over the caller's own bank (267 HSC rows, 3,467
-- admission rows today) joined to a table of at most 212 institutions, and the
-- plan was checked with EXPLAIN after applying. The indexes that matter for the
-- list already exist: idx_qir_question_id, idx_qir_institution_id and
-- idx_question_preparation_tracks_track_question.
