-- Faceted exploration of the student's mistake pool and bookmarks.
--
-- The two tabs used to fetch every row and filter in JavaScript. This module
-- adds one server-side definition of the pool (so the list, the facet counts and
-- the practice pick can never disagree) plus the facet, page and random-pick
-- functions the history screen needs.
--
-- Source of truth for the university/year dimension: question_institution_references.
-- questions.exam_references also carries a year, but it is an untyped JSON
-- snapshot kept for provenance; the normalized table has typed ids, an index and
-- exam_year_label, so the filter and the card chip both read the table only.
--
-- Safe to apply on a populated project: no table is altered and no row is
-- deleted. Every function is SECURITY DEFINER with an empty search_path, takes
-- p_user_id from the backend (which derives it from the caller's JWT), refuses
-- to run for a different authenticated user, and is executable only by
-- service_role.

create or replace function public._mbe_match(
  p_filters jsonb,
  p_ignore text,
  p_subject_id text,
  p_chapter_id text,
  p_topic_id text,
  p_institution_id uuid,
  p_exam_year text,
  p_status text,
  p_has_note boolean,
  p_body_text text
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select
    (
      p_ignore = 'subject'
      or coalesce(nullif(p_filters ->> 'subject', ''), '') = ''
      or p_subject_id = p_filters ->> 'subject'
    )
    and (
      p_ignore = 'chapter'
      or coalesce(nullif(p_filters ->> 'chapter', ''), '') = ''
      or p_chapter_id = p_filters ->> 'chapter'
    )
    and (
      p_ignore = 'topic'
      or coalesce(nullif(p_filters ->> 'topic', ''), '') = ''
      or p_topic_id = p_filters ->> 'topic'
    )
    and (
      p_ignore = 'institution'
      or coalesce(nullif(p_filters ->> 'institution', ''), '') = ''
      or p_institution_id::text = p_filters ->> 'institution'
    )
    and (
      p_ignore = 'exam_year'
      or coalesce(nullif(p_filters ->> 'exam_year', ''), '') = ''
      or p_exam_year = p_filters ->> 'exam_year'
    )
    and (
      p_ignore = 'status'
      or coalesce(nullif(p_filters ->> 'status', ''), '') = ''
      or p_status = p_filters ->> 'status'
    )
    and (
      coalesce(p_filters ->> 'has_note', '') <> 'true'
      or p_has_note
    )
    and (
      coalesce(nullif(btrim(p_filters ->> 'q'), ''), '') = ''
      or p_body_text ilike '%' || (p_filters ->> 'q') || '%'
    );
$function$;

-- One row per pool question with everything the facet, page and pick queries
-- need. internal use only; the public entry points below go through it.
create or replace function public._mbe_base(
  p_user_id uuid,
  p_source text,
  p_filters jsonb
)
returns table (
  question_id uuid,
  item_id uuid,
  status text,
  selected_option text,
  occurred_at timestamp with time zone,
  note text,
  wrong_times integer,
  last_wrong_at timestamp with time zone,
  subject_id text,
  chapter_id text,
  topic_id text,
  subject_sequence integer,
  institution_id uuid,
  institution_name_bn text,
  institution_name_en text,
  institution_short_name text,
  exam_name text,
  exam_year text,
  has_note boolean,
  body_text text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0403';
  END IF;

  RETURN QUERY
  WITH items AS (
    SELECT m.question_id,
           NULL::uuid AS item_id,
           m.status,
           m.selected_option,
           m.occurred_at,
           NULL::text AS note,
           false AS has_note
    FROM public.user_mistake_questions(p_user_id) m
    WHERE p_source = 'mistakes'
      AND m.question_id IN (SELECT g.question_id FROM public.get_mistake_pool(p_user_id) g)
    UNION ALL
    SELECT b.question_id,
           b.id,
           'bookmarked'::text,
           NULL::text,
           b.created_at,
           b.note,
           coalesce(nullif(btrim(coalesce(b.note, '')), ''), NULL) IS NOT NULL
    FROM public.bookmarks b
    WHERE p_source = 'bookmarks'
      AND b.user_id = p_user_id
  ),
  stats AS (
    SELECT d.question_id,
           count(*)::integer AS wrong_times,
           max(coalesce(eh.submitted_at, eh.created_at, d.created_at)) AS last_wrong_at
    FROM public.exam_history_details d
    JOIN public.exam_history eh ON eh.id = d.exam_history_id
    WHERE eh.user_id = p_user_id
      AND d.is_correct IS FALSE
      AND coalesce(btrim(d.selected_option), '') <> ''
      AND d.question_id IN (SELECT i.question_id FROM items i)
    GROUP BY d.question_id
  )
  SELECT i.question_id,
         i.item_id,
         i.status,
         i.selected_option,
         i.occurred_at,
         i.note,
         coalesce(s.wrong_times, 0),
         s.last_wrong_at,
         q.subject_id,
         q.chapter_id,
         q.topic_id,
         sub.sequence,
         r.institution_id,
         inst.name_bn,
         inst.name_en,
         inst.short_name,
         r.exam_name,
         r.exam_year,
         i.has_note,
         concat_ws(' ',
           q.body ->> 'text_bn',
           q.body ->> 'text_en',
           q.body ->> 'text',
           q.body ->> 'bn',
           q.body ->> 'en'
         )
  FROM items i
  JOIN public.questions q ON q.id = i.question_id
  LEFT JOIN public.subjects sub ON sub.id = q.subject_id
  LEFT JOIN LATERAL (
    SELECT ref.institution_id,
           ref.exam_name,
           coalesce(nullif(btrim(ref.exam_year_label), ''), ref.exam_year::text) AS exam_year
    FROM public.question_institution_references ref
    WHERE ref.question_id = i.question_id
    ORDER BY
      (ref.institution_id::text = coalesce(p_filters ->> 'institution', '')) DESC,
      (coalesce(nullif(btrim(ref.exam_year_label), ''), ref.exam_year::text)
        = coalesce(p_filters ->> 'exam_year', '')) DESC,
      ref.created_at
    LIMIT 1
  ) r ON TRUE
  LEFT JOIN public.institutions inst ON inst.id = r.institution_id
  LEFT JOIN stats s ON s.question_id = i.question_id
  WHERE q.deleted_at IS NULL
    AND coalesce(q.is_active, TRUE);
END;
$function$;

-- Counts for every facet in one round trip. Each facet ignores its own filter so
-- the numbers show what selecting another option would yield, while the other
-- facets stay applied (the usual faceted-search behaviour).
create or replace function public.get_mistake_bookmark_facets(
  p_user_id uuid,
  p_source text,
  p_filters jsonb DEFAULT '{}'::jsonb
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
DECLARE
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
BEGIN
  IF p_user_id IS NULL OR p_source NOT IN ('mistakes', 'bookmarks') THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0403';
  END IF;

  RETURN QUERY
  SELECT 'subject'::text,
         b.subject_id,
         NULL::text,
         max(sub.name_bn),
         max(sub.name_en),
         count(*)::integer
  FROM public._mbe_base(p_user_id, p_source, v_filters) b
  LEFT JOIN public.subjects sub ON sub.id = b.subject_id
  WHERE public._mbe_match(v_filters, 'subject', b.subject_id, b.chapter_id, b.topic_id,
                          b.institution_id, b.exam_year, b.status,
                          b.has_note, b.body_text)
    AND b.subject_id IS NOT NULL
  GROUP BY b.subject_id
  HAVING count(*) > 0;

  RETURN QUERY
  SELECT 'chapter'::text,
         b.chapter_id,
         b.subject_id,
         max(ch.name_bn),
         max(ch.name_en),
         count(*)::integer
  FROM public._mbe_base(p_user_id, p_source, v_filters) b
  LEFT JOIN public.chapters ch ON ch.id = b.chapter_id
  WHERE public._mbe_match(v_filters, 'chapter', b.subject_id, b.chapter_id, b.topic_id,
                          b.institution_id, b.exam_year, b.status,
                          b.has_note, b.body_text)
    AND b.chapter_id IS NOT NULL
  GROUP BY b.chapter_id, b.subject_id
  HAVING count(*) > 0;

  RETURN QUERY
  SELECT 'topic'::text,
         b.topic_id,
         b.chapter_id,
         max(tp.name_bn),
         max(tp.name_en),
         count(*)::integer
  FROM public._mbe_base(p_user_id, p_source, v_filters) b
  LEFT JOIN public.topics tp ON tp.id = b.topic_id
  WHERE public._mbe_match(v_filters, 'topic', b.subject_id, b.chapter_id, b.topic_id,
                          b.institution_id, b.exam_year, b.status,
                          b.has_note, b.body_text)
    AND b.topic_id IS NOT NULL
  GROUP BY b.topic_id, b.chapter_id
  HAVING count(*) > 0;

  RETURN QUERY
  SELECT 'institution'::text,
         b.institution_id::text,
         NULL::text,
         max(b.institution_name_bn),
         max(b.institution_name_en),
         count(*)::integer
  FROM public._mbe_base(p_user_id, p_source, v_filters) b
  WHERE public._mbe_match(v_filters, 'institution', b.subject_id, b.chapter_id, b.topic_id,
                          b.institution_id, b.exam_year, b.status,
                          b.has_note, b.body_text)
    AND b.institution_id IS NOT NULL
  GROUP BY b.institution_id
  HAVING count(*) > 0;

  RETURN QUERY
  SELECT 'exam_year'::text,
         b.exam_year,
         NULL::text,
         b.exam_year,
         b.exam_year,
         count(*)::integer
  FROM public._mbe_base(p_user_id, p_source, v_filters) b
  WHERE public._mbe_match(v_filters, 'exam_year', b.subject_id, b.chapter_id, b.topic_id,
                          b.institution_id, b.exam_year, b.status,
                          b.has_note, b.body_text)
    AND coalesce(b.exam_year, '') <> ''
  GROUP BY b.exam_year
  HAVING count(*) > 0;

  RETURN QUERY
  SELECT 'status'::text,
         b.status,
         NULL::text,
         NULL::text,
         NULL::text,
         count(*)::integer
  FROM public._mbe_base(p_user_id, p_source, v_filters) b
  WHERE public._mbe_match(v_filters, 'status', b.subject_id, b.chapter_id, b.topic_id,
                          b.institution_id, b.exam_year, b.status,
                          b.has_note, b.body_text)
    AND b.status IS NOT NULL
  GROUP BY b.status
  HAVING count(*) > 0;
END;
$function$;

create or replace function public.count_mistake_bookmark_questions(
  p_user_id uuid,
  p_source text,
  p_filters jsonb DEFAULT '{}'::jsonb
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
DECLARE
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_count integer;
BEGIN
  IF p_user_id IS NULL OR p_source NOT IN ('mistakes', 'bookmarks') THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0403';
  END IF;

  SELECT count(*)::integer INTO v_count
  FROM public._mbe_base(p_user_id, p_source, v_filters) b
  WHERE public._mbe_match(v_filters, '', b.subject_id, b.chapter_id, b.topic_id,
                          b.institution_id, b.exam_year, b.status,
                          b.has_note, b.body_text);

  RETURN coalesce(v_count, 0);
END;
$function$;

-- One page of ids plus the card metadata. Question bodies are loaded by the
-- backend for this page only, never for the whole pool.
create or replace function public.get_mistake_bookmark_questions(
  p_user_id uuid,
  p_source text,
  p_filters jsonb DEFAULT '{}'::jsonb,
  p_sort text DEFAULT 'recent',
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
returns table (
  question_id uuid,
  item_id uuid,
  status text,
  selected_option text,
  occurred_at timestamp with time zone,
  note text,
  wrong_times integer,
  last_wrong_at timestamp with time zone,
  subject_id text,
  chapter_id text,
  topic_id text,
  institution_id uuid,
  institution_name_bn text,
  institution_name_en text,
  institution_short_name text,
  exam_name text,
  exam_year text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
DECLARE
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF p_user_id IS NULL OR p_source NOT IN ('mistakes', 'bookmarks') THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0403';
  END IF;

  RETURN QUERY
  SELECT b.question_id, b.item_id, b.status, b.selected_option, b.occurred_at,
         b.note, b.wrong_times, b.last_wrong_at,
         b.subject_id, b.chapter_id, b.topic_id,
         b.institution_id, b.institution_name_bn, b.institution_name_en,
         b.institution_short_name, b.exam_name, b.exam_year
  FROM public._mbe_base(p_user_id, p_source, v_filters) b
  WHERE public._mbe_match(v_filters, '', b.subject_id, b.chapter_id, b.topic_id,
                          b.institution_id, b.exam_year, b.status,
                          b.has_note, b.body_text)
  ORDER BY
    CASE WHEN p_sort = 'most_wrong' THEN b.wrong_times END DESC NULLS LAST,
    CASE WHEN p_sort = 'subject' THEN b.subject_sequence END ASC NULLS LAST,
    CASE WHEN p_sort = 'subject' THEN b.subject_id END ASC NULLS LAST,
    b.occurred_at DESC NULLS LAST,
    b.question_id
  LIMIT v_limit OFFSET v_offset;
END;
$function$;

create or replace function public.pick_mistake_bookmark_questions(
  p_user_id uuid,
  p_source text,
  p_filters jsonb,
  p_count integer
)
returns table (question_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $function$
DECLARE
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
BEGIN
  IF p_user_id IS NULL OR p_source NOT IN ('mistakes', 'bookmarks') THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023';
  END IF;

  IF p_count IS NULL OR p_count < 1 OR p_count > 100 THEN
    RAISE EXCEPTION 'invalid_count' USING ERRCODE = '22023';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0403';
  END IF;

  RETURN QUERY
  SELECT b.question_id
  FROM public._mbe_base(p_user_id, p_source, v_filters) b
  WHERE public._mbe_match(v_filters, '', b.subject_id, b.chapter_id, b.topic_id,
                          b.institution_id, b.exam_year, b.status,
                          b.has_note, b.body_text)
  ORDER BY random()
  LIMIT p_count;
END;
$function$;

-- Questions the student removed from the Mistakes list, so the list can be
-- restored instead of only dismissed.
create or replace function public.get_dismissed_mistakes(p_user_id uuid)
returns table (
  question_id uuid,
  dismissed_at timestamp with time zone,
  subject_id text,
  body jsonb,
  subject_name_bn text,
  subject_name_en text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0403';
  END IF;

  RETURN QUERY
  SELECT md.question_id,
         md.created_at,
         q.subject_id,
         q.body,
         sub.name_bn,
         sub.name_en
  FROM public.mistake_dismissals md
  JOIN public.questions q ON q.id = md.question_id
  LEFT JOIN public.subjects sub ON sub.id = q.subject_id
  WHERE md.user_id = p_user_id
  ORDER BY md.created_at DESC;
END;
$function$;

-- Backend-only surface. New functions default to PUBLIC EXECUTE, which would
-- let a signed-in client call them directly with someone else's id.
REVOKE ALL ON FUNCTION public._mbe_match(jsonb, text, text, text, text, uuid, text, text, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._mbe_base(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_mistake_bookmark_facets(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.count_mistake_bookmark_questions(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_mistake_bookmark_questions(uuid, text, jsonb, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pick_mistake_bookmark_questions(uuid, text, jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_dismissed_mistakes(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_mistake_bookmark_facets(uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.count_mistake_bookmark_questions(uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_mistake_bookmark_questions(uuid, text, jsonb, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.pick_mistake_bookmark_questions(uuid, text, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_dismissed_mistakes(uuid) TO service_role;
