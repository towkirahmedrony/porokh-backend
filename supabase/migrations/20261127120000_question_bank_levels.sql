-- Question Bank levels: HSC versus Admission.
--
-- The level is deliberately not a new column on public.questions. A question's
-- placement already lives in public.question_preparation_tracks, and that table
-- is the only place a human can override. A parallel column would give the
-- platform two answers to the same question.
--
-- The rule, expressed once in public.v_question_levels:
--
--   admission  when the question carries any of varsity, medical, engineering,
--              admission
--   hsc        otherwise
--
-- HSC tags are additive, not exclusive. A question carrying hsc AND medical is
-- visible at both levels, which is how a manually dual-tagged question keeps
-- showing up for HSC students and for medical-goal students at the same time.
-- Collapsing it into one label would silently hide one of the two audiences.
--
-- Auto derivation follows the product rule: a university reference makes a
-- question admission level; anything else (college only, board only, no
-- reference at all) makes it HSC. Manual tags are never removed by the sync.
--
-- Safe to apply on a populated project. No table is altered and no row is
-- deleted. The backfill only inserts auto rows: 55 new rows on production, and
-- 0 removals (the other 20 questions the new derivation would tag already carry
-- hsc as a manual tag, so the ON CONFLICT DO NOTHING keeps the manual row).
--
-- One pre-existing bug is fixed in the new function only: get_student_question_bank_v2
-- hides a question whenever it is attached to a paper whose end_time is null, and
-- every exam paper in this project is an archived past paper stored with
-- start_time and end_time null. That test hid 3352 of 3685 questions from the
-- bank and made a goal filter return 0 for engineering. _qb_base treats a paper
-- as live only when it is published, has started and has not ended. v2 is left
-- untouched so the running app keeps working until it is switched over; it
-- carries the same bug and should be dropped once v3 is live.

-- ---------------------------------------------------------------------------
-- 1. The single definition of level
-- ---------------------------------------------------------------------------
-- security_invoker keeps the view subject to the caller's own privileges.
-- Without it a view owned by postgres would hand anon a full read of every
-- question.
--
-- The fields are kept separate on purpose:
--   track_ids    the tags actually stored, nothing inferred
--   has_tracks   false means "needs attention" for the admin report
--   is_hsc       the tag is present
--   is_admission any admission track is present
--   level        the product rule's label, so an untagged question still reads
--                as hsc instead of inventing a third state every screen would
--                have to render
create or replace view public.v_question_levels
with (security_invoker = true)
as
select
  q.id as question_id,
  coalesce(t.track_ids, '{}'::text[]) as track_ids,
  t.question_id is not null as has_tracks,
  coalesce(t.is_hsc, false) as is_hsc,
  coalesce(t.is_admission, false) as is_admission,
  case when coalesce(t.is_admission, false) then 'admission' else 'hsc' end as level
from public.questions q
left join (
  select
    qpt.question_id,
    array_agg(qpt.track_id order by qpt.track_id) as track_ids,
    bool_or(qpt.track_id = 'hsc') as is_hsc,
    bool_or(qpt.track_id in ('varsity', 'medical', 'engineering', 'admission')) as is_admission
  from public.question_preparation_tracks qpt
  group by qpt.question_id
) t on t.question_id = q.id;

comment on view public.v_question_levels is
  'The one definition of HSC versus admission level. Derived from question_preparation_tracks; never a stored column.';

revoke all on public.v_question_levels from public, anon, authenticated;
grant select on public.v_question_levels to service_role;

-- ---------------------------------------------------------------------------
-- 2. Auto tags follow institution type, not the exam_type label
-- ---------------------------------------------------------------------------
-- Before this change a question got 'hsc' only when a reference carried
-- exam_type board_exam or college_test, so a question with no reference at all
-- ended up with no tag, and a university reference carrying a board label would
-- have been tagged hsc. Institution type is the field the product rule names,
-- and it is constrained where exam_type is free text.
--
-- A university with no preparation_track_id falls back to 'varsity', so a
-- missing back-office field can never leave a question untagged.
create or replace function public.derive_question_track_ids(p_question_id uuid)
returns text[]
language sql
stable
set search_path = ''
as $function$
  with university_tracks as (
    select distinct coalesce(i.preparation_track_id, 'varsity') as track_id
    from public.question_institution_references r
    join public.institutions i on i.id = r.institution_id
    where r.question_id = p_question_id
      and i.type = 'university'
  )
  select case
    when not exists (select 1 from public.questions q where q.id = p_question_id)
      then '{}'::text[]
    when exists (select 1 from university_tracks)
      then (select array_agg(distinct track_id order by track_id) from university_tracks)
    else array['hsc']::text[]
  end;
$function$;

comment on function public.derive_question_track_ids(uuid) is
  'Auto tracks for a question: the university-reference track when one exists, hsc otherwise.';

comment on function public.sync_question_auto_tracks(uuid) is
  'Reconciles a question''s auto tags with derive_question_track_ids. Never touches rows whose source is manual.';

-- A question inserted without any reference had no path to a tag: the only
-- trigger lived on the reference table, so a question with no references never
-- fired it.
create or replace function public.trg_questions_sync_auto_tracks()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  perform public.sync_question_auto_tracks(new.id);
  return null;
end;
$function$;

drop trigger if exists trg_questions_sync_auto_tracks on public.questions;
create trigger trg_questions_sync_auto_tracks
after insert on public.questions
for each row execute function public.trg_questions_sync_auto_tracks();

-- ---------------------------------------------------------------------------
-- 3. Track writes are an admin concern
-- ---------------------------------------------------------------------------
-- Both helpers were executable by any signed-in student, so a student could
-- rewrite any question's auto tags by calling the function directly.
revoke all on function public.derive_question_track_ids(uuid) from public, anon, authenticated;
revoke all on function public.sync_question_auto_tracks(uuid) from public, anon, authenticated;
grant execute on function public.derive_question_track_ids(uuid) to service_role;
grant execute on function public.sync_question_auto_tracks(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Backfill
-- ---------------------------------------------------------------------------
-- Idempotent and derived, not hard-coded: every question is reconciled against
-- the rule. Against production this inserts 75 auto rows and removes none.
-- 31 of those questions had no tag at all; 24 carried only a manual admission
-- tag and no reference, so they become dual-tagged exactly as the rule says.
do $$
declare
  v_question record;
begin
  for v_question in select id from public.questions loop
    perform public.sync_question_auto_tracks(v_question.id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. One row source for the level-aware bank
-- ---------------------------------------------------------------------------
-- The list and the facets both read this, so their numbers cannot disagree.
-- It also owns the stage rule, so no client can ask for content its stage hides.
--
-- Stage is never inferred from a device clock and never accepted as a
-- parameter: the caller passes auth.uid(), and the stage comes from
-- get_my_stage() inside the function.
--
-- p_ignore names one facet whose own filter is not applied, which is how a
-- facet answers "what would selecting this option give me" while every other
-- filter stays in force. It is internal; the public functions below are what
-- carry the grants.
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
  -- asks for. A stale tab or a crafted request must not reveal it, so the rule
  -- is enforced here rather than in the app.
  if p_stage = 'admission_prep' and coalesce(p_level, 'admission') = 'hsc' then
    return;
  end if;

  -- post_hsc is sent to the goal gate before it reaches the bank. Returning
  -- nothing is the honest answer for the one request that slips past it.
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

  -- "সব ভর্তি প্রশ্ন" widens the goal, never the level.
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
    -- A paper hides its questions only while it is genuinely running: published,
    -- already started, and not yet ended. Every archived paper in this project is
    -- stored with start_time and end_time both null, so the test inherited from
    -- get_student_question_bank_v2 (end_time is null or end_time > now()) read all
    -- 49 past papers as live forever and hid 3352 of 3685 questions from the bank.
    -- That is why the bank showed 333 questions instead of the whole set, and why
    -- a goal filter could return 0 for engineering.
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
-- 6. Level-aware listing
-- ---------------------------------------------------------------------------
-- Same row contract as get_student_question_bank_v2 plus the level fields, so
-- the existing mapper keeps working while the card gains a level chip.
create or replace function public.get_student_question_bank_v3(
  p_level text default null,
  p_track text default null,
  p_include_other_admission_tracks boolean default false,
  p_subject_id text default null,
  p_chapter_id text default null,
  p_topic_id text default null,
  p_sort text default 'newest',
  p_search text default null,
  p_bookmarked_only boolean default false,
  p_mistakes_only boolean default false,
  p_premium_only boolean default false,
  p_institution_id uuid default null,
  p_admission_unit_id uuid default null,
  p_year text default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_access jsonb;
  v_has_premium boolean := false;
  v_stage text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  v_access := public.get_user_access(v_uid);
  v_has_premium := coalesce((v_access ->> 'premium')::boolean, false)
    or coalesce((v_access ->> 'unlimited_all')::boolean, false);

  -- get_my_stage() raises when there is no profile row; a missing profile means
  -- "no stage yet", which the bank renders as its neutral state.
  if not exists (select 1 from public.profiles p where p.id = v_uid) then
    v_stage := null;
  else
    v_stage := public.get_my_stage() ->> 'stage';
  end if;

  return query
  with matched as (
    select
      b.*,
      (
        (
          coalesce(b.s_prem, false)
          or coalesce(b.c_prem, false)
          or coalesce(b.t_prem, false)
        )
        and not v_has_premium
      ) as locked,
      count(*) over () as total_count
    from public._qb_base(
      v_uid, v_stage, p_level, p_track, p_include_other_admission_tracks,
      p_subject_id, p_chapter_id, p_topic_id, p_institution_id, p_admission_unit_id,
      p_year, p_search, p_bookmarked_only, p_mistakes_only, p_premium_only,
      v_has_premium, null
    ) b
  )
  select jsonb_build_object(
    'id', m.question_id,
    'type', q.type,
    'difficulty_level', q.difficulty_level,
    'source_type', q.source_type,
    'tags', to_jsonb(coalesce(q.tags, '{}'::text[])),
    'exam_references', coalesce(q.exam_references, '[]'::jsonb),
    'subject_id', m.subject_id,
    'chapter_id', m.chapter_id,
    'topic_id', m.topic_id,
    'total_attempts', m.total_attempts,
    'correct_attempts', m.correct_attempts,
    'created_at', m.created_at,
    'level', case when m.is_admission then 'admission' else 'hsc' end,
    'levels', case
      when m.is_hsc and m.is_admission then jsonb_build_array('hsc', 'admission')
      when m.is_admission then jsonb_build_array('admission')
      else jsonb_build_array('hsc')
    end,
    'tracks', to_jsonb(m.track_ids),
    'institution', case when m.ref_institution_id is null then null else jsonb_build_object(
      'id', m.ref_institution_id,
      'name_bn', m.ref_institution_name_bn,
      'name_en', m.ref_institution_name_en,
      'short_name', m.ref_institution_short
    ) end,
    'admission_unit', case when m.ref_admission_unit_id is null then null else jsonb_build_object(
      'id', m.ref_admission_unit_id,
      'name_bn', m.ref_unit_name_bn,
      'code', m.ref_unit_code
    ) end,
    'exam_year', m.exam_year,
    'total_count', m.total_count,
    'body',
      case
        when m.locked then '{}'::jsonb
        else jsonb_strip_nulls(
          jsonb_build_object(
            'text_bn', case when jsonb_typeof(q.body -> 'text_bn') = 'string' then q.body -> 'text_bn' end,
            'text_en', case when jsonb_typeof(q.body -> 'text_en') = 'string' then q.body -> 'text_en' end,
            'image_url', case when jsonb_typeof(q.body -> 'image_url') = 'string' then q.body -> 'image_url' end
          )
        )
      end,
    'options',
      case
        when m.locked or jsonb_typeof(q.options) <> 'array' then '[]'::jsonb
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
          from jsonb_array_elements(q.options) with ordinality as o(item, ord)
        )
      end,
    'explanation', case when m.locked then null else to_jsonb(q.explanation) end,
    'subjects', jsonb_build_object(
      'id', m.s_id,
      'name_bn', m.s_name_bn,
      'name_en', m.s_name_en,
      'slug', m.s_slug,
      'is_premium', m.s_prem,
      'sequence', m.s_seq
    ),
    'chapters', case when m.c_id is null then null else jsonb_build_object(
      'id', m.c_id,
      'subject_id', m.subject_id,
      'name_bn', m.c_name_bn,
      'name_en', m.c_name_en,
      'slug', m.c_slug,
      'is_premium', m.c_prem,
      'sequence', m.c_seq
    ) end,
    'topics', case when m.t_id is null then null else jsonb_build_object(
      'id', m.t_id,
      'chapter_id', m.chapter_id,
      'name_bn', m.t_name_bn,
      'name_en', m.t_name_en,
      'slug', m.t_slug,
      'is_premium', m.t_prem,
      'sequence', m.t_seq,
      'total_questions', m.t_total
    ) end
  )
  from matched m
  join public.questions q on q.id = m.question_id
  order by
    case when p_sort = 'oldest' then m.created_at end asc nulls last,
    case when p_sort = 'most_attempted' then m.total_attempts end desc nulls last,
    case when p_sort = 'least_attempted' then m.total_attempts end asc nulls last,
    m.created_at desc,
    m.question_id asc
  limit v_limit
  offset v_offset;
end;
$function$;

revoke all on function public.get_student_question_bank_v3(
  text, text, boolean, text, text, text, text, text, boolean, boolean, boolean,
  uuid, uuid, text, integer, integer
) from public, anon;
grant execute on function public.get_student_question_bank_v3(
  text, text, boolean, text, text, text, text, text, boolean, boolean, boolean,
  uuid, uuid, text, integer, integer
) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Facets
-- ---------------------------------------------------------------------------
-- One round trip for every filter a bank screen offers. Each facet is computed
-- with its own filter dropped, so a number answers "what would picking this
-- give me" while the other filters stay applied. Options with no question are
-- never returned, which is what keeps a subject out of HSC browsing when it
-- holds no HSC question.
create or replace function public.get_question_bank_facets(
  p_level text default null,
  p_track text default null,
  p_include_other_admission_tracks boolean default false,
  p_subject_id text default null,
  p_chapter_id text default null,
  p_topic_id text default null,
  p_institution_id uuid default null,
  p_admission_unit_id uuid default null,
  p_year text default null,
  p_search text default null,
  p_bookmarked_only boolean default false,
  p_mistakes_only boolean default false,
  p_premium_only boolean default false
)
returns table (
  facet text,
  id text,
  parent_id text,
  label_bn text,
  label_en text,
  cnt integer
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_access jsonb;
  v_has_premium boolean := false;
  v_stage text;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  v_access := public.get_user_access(v_uid);
  v_has_premium := coalesce((v_access ->> 'premium')::boolean, false)
    or coalesce((v_access ->> 'unlimited_all')::boolean, false);

  if not exists (select 1 from public.profiles p where p.id = v_uid) then
    v_stage := null;
  else
    v_stage := public.get_my_stage() ->> 'stage';
  end if;

  -- The three taxonomy facets count questions. The three reference facets below
  -- count the reference rows themselves, because one question can sit in two
  -- universities or two exam years and a single representative reference would
  -- undercount both.
  return query
  select 'subject'::text,
         b.subject_id,
         null::text,
         min(b.s_name_bn),
         min(b.s_name_en),
         count(*)::integer
  from public._qb_base(
    v_uid, v_stage, p_level, p_track, p_include_other_admission_tracks,
    p_subject_id, p_chapter_id, p_topic_id, p_institution_id, p_admission_unit_id,
    p_year, p_search, p_bookmarked_only, p_mistakes_only, p_premium_only,
    v_has_premium, 'subject'
  ) b
  where b.subject_id is not null
  group by b.subject_id

  union all

  select 'chapter'::text,
         b.chapter_id,
         b.subject_id,
         min(b.c_name_bn),
         min(b.c_name_en),
         count(*)::integer
  from public._qb_base(
    v_uid, v_stage, p_level, p_track, p_include_other_admission_tracks,
    p_subject_id, p_chapter_id, p_topic_id, p_institution_id, p_admission_unit_id,
    p_year, p_search, p_bookmarked_only, p_mistakes_only, p_premium_only,
    v_has_premium, 'chapter'
  ) b
  where b.chapter_id is not null
  group by b.chapter_id, b.subject_id

  union all

  select 'topic'::text,
         b.topic_id,
         b.chapter_id,
         min(b.t_name_bn),
         min(b.t_name_en),
         count(*)::integer
  from public._qb_base(
    v_uid, v_stage, p_level, p_track, p_include_other_admission_tracks,
    p_subject_id, p_chapter_id, p_topic_id, p_institution_id, p_admission_unit_id,
    p_year, p_search, p_bookmarked_only, p_mistakes_only, p_premium_only,
    v_has_premium, 'topic'
  ) b
  where b.topic_id is not null
  group by b.topic_id, b.chapter_id

  union all

  select 'institution'::text,
         i.id::text,
         null::text,
         i.name_bn,
         coalesce(i.short_name, i.name_en),
         count(distinct r.question_id)::integer
  from public.question_institution_references r
  join public.institutions i on i.id = r.institution_id and i.type = 'university'
  where r.question_id in (
    select b.question_id from public._qb_base(
      v_uid, v_stage, p_level, p_track, p_include_other_admission_tracks,
      p_subject_id, p_chapter_id, p_topic_id, p_institution_id, p_admission_unit_id,
      p_year, p_search, p_bookmarked_only, p_mistakes_only, p_premium_only,
      v_has_premium, 'institution'
    ) b
  )
  group by i.id, i.name_bn, i.short_name, i.name_en

  union all

  select 'admission_unit'::text,
         au.id::text,
         au.institution_id::text,
         au.name_bn,
         coalesce(au.name_en, au.code),
         count(distinct r.question_id)::integer
  from public.question_institution_references r
  join public.admission_units au on au.id = r.admission_unit_id
  where r.question_id in (
    select b.question_id from public._qb_base(
      v_uid, v_stage, p_level, p_track, p_include_other_admission_tracks,
      p_subject_id, p_chapter_id, p_topic_id, p_institution_id, p_admission_unit_id,
      p_year, p_search, p_bookmarked_only, p_mistakes_only, p_premium_only,
      v_has_premium, 'admission_unit'
    ) b
  )
    and (p_institution_id is null or au.institution_id = p_institution_id)
  group by au.id, au.institution_id, au.name_bn, au.name_en, au.code

  union all

  select 'exam_year'::text,
         y.exam_year,
         null::text,
         y.exam_year,
         y.exam_year,
         count(distinct y.question_id)::integer
  from (
    select r.question_id,
           coalesce(nullif(btrim(r.exam_year_label), ''), r.exam_year::text) as exam_year
    from public.question_institution_references r
    where r.question_id in (
      select b.question_id from public._qb_base(
        v_uid, v_stage, p_level, p_track, p_include_other_admission_tracks,
        p_subject_id, p_chapter_id, p_topic_id, p_institution_id, p_admission_unit_id,
        p_year, p_search, p_bookmarked_only, p_mistakes_only, p_premium_only,
        v_has_premium, 'exam_year'
      ) b
    )
      and (p_institution_id is null or r.institution_id = p_institution_id)
      and (p_admission_unit_id is null or r.admission_unit_id = p_admission_unit_id)
  ) y
  where y.exam_year is not null
  group by y.exam_year

  order by 1, 6 desc;
end;
$function$;

revoke all on function public.get_question_bank_facets(
  text, text, boolean, text, text, text, uuid, uuid, text, text, boolean, boolean, boolean
) from public, anon;
grant execute on function public.get_question_bank_facets(
  text, text, boolean, text, text, text, uuid, uuid, text, text, boolean, boolean, boolean
) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Admin report: the questions that need a human
-- ---------------------------------------------------------------------------
-- Reads the view, so its counts match what the bank shows. Admin-only in
-- practice: it is granted to service_role, and the backend calls it after its
-- own admin guard, the same way the other admin read models work.
create or replace function public.get_question_level_report()
returns table (
  bucket text,
  question_id uuid,
  subject_id text,
  track_ids text[],
  has_university_reference boolean
)
language sql
stable
security definer
set search_path = ''
as $function$
  with levels as (
    select l.*, q.subject_id
    from public.v_question_levels l
    join public.questions q on q.id = l.question_id
    where coalesce(q.is_active, true)
      and q.deleted_at is null
  ),
  reference_state as (
    select
      r.question_id,
      bool_or(i.type = 'university') as has_university,
      bool_or(r.institution_id is null) as has_blank_reference
    from public.question_institution_references r
    left join public.institutions i on i.id = r.institution_id
    group by r.question_id
  ),
  joined as (
    select l.*,
           coalesce(rs.has_university, false) as has_university,
           coalesce(rs.has_blank_reference, false) as has_blank_reference
    from levels l
    left join reference_state rs on rs.question_id = l.question_id
  )
  select 'untracked'::text, j.question_id, j.subject_id, j.track_ids, j.has_university
  from joined j
  where not j.has_tracks

  union all

  select 'manual_admission_without_reference'::text, j.question_id, j.subject_id,
         j.track_ids, j.has_university
  from joined j
  where j.is_admission and not j.has_university

  union all

  select 'university_reference_without_admission_track'::text, j.question_id,
         j.subject_id, j.track_ids, j.has_university
  from joined j
  where j.has_university and not j.is_admission

  union all

  select 'blank_institution_reference'::text, j.question_id, j.subject_id,
         j.track_ids, j.has_university
  from joined j
  where j.has_blank_reference;
$function$;

revoke all on function public.get_question_level_report() from public, anon, authenticated;
grant execute on function public.get_question_level_report() to service_role;

-- ---------------------------------------------------------------------------
-- 9. Indexes
-- ---------------------------------------------------------------------------
-- None added. The bank reads at most 3.7k questions and both dimensions that
-- matter are already covered: idx_question_preparation_tracks_track_question
-- serves the track filter, and idx_qir_question_id plus idx_qir_institution_id
-- serve the reference filters. The listing plan was checked with EXPLAIN on the
-- real data and stays within a few thousand rows per pass.
