-- Practice-mode data access functions.
--
-- Mirrors the definitions already live on the test project (version
-- 20261026042252). Every function is SECURITY DEFINER with an empty
-- search_path and is reachable only through the service-role API. The backend
-- always supplies p_user_id from the verified session, never from the client.

CREATE OR REPLACE FUNCTION public.practiceable_question_ids(p_ids uuid[], p_premium boolean)
 RETURNS TABLE(id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT q.id
  FROM public.questions q
  JOIN public.subjects s ON s.id = q.subject_id
  LEFT JOIN public.chapters c ON c.id = q.chapter_id
  LEFT JOIN public.topics t ON t.id = q.topic_id
  WHERE q.id = ANY (p_ids)
    AND q.status = 'published' AND q.is_active IS TRUE AND q.deleted_at IS NULL
    AND s.is_active IS TRUE AND (p_premium OR s.is_premium IS FALSE)
    AND (q.chapter_id IS NULL OR (c.id IS NOT NULL AND c.is_active IS TRUE AND (p_premium OR c.is_premium IS FALSE)))
    AND (q.topic_id   IS NULL OR (t.id IS NOT NULL AND t.is_active IS TRUE AND (p_premium OR t.is_premium IS FALSE)))
    AND NOT EXISTS (
      SELECT 1 FROM public.exam_paper_questions epq
      JOIN public.exam_papers ep ON ep.id = epq.exam_id
      WHERE epq.question_id = q.id
        AND ep.exam_type IS DISTINCT FROM 'practice'
        AND (ep.end_time IS NULL OR ep.end_time > now()
             OR coalesce(ep.result_publish_time, '-infinity'::timestamptz) > now())
    );
$function$;

CREATE OR REPLACE FUNCTION public.get_history_question_set(p_user_id uuid, p_history_id uuid)
 RETURNS TABLE(pos integer, question_id uuid, available boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_exam_id text; v_attempt_id uuid; v_details jsonb;
  v_premium boolean; v_exam_premium boolean; v_ids uuid[]; v_ok uuid[];
BEGIN
  IF p_user_id IS NULL OR p_history_id IS NULL THEN RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023'; END IF;
  SELECT eh.exam_id, eh.attempt_id, eh.details_json INTO v_exam_id, v_attempt_id, v_details
  FROM public.exam_history eh WHERE eh.id = p_history_id AND eh.user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'history_not_found' USING ERRCODE = 'P0002'; END IF;

  v_premium := coalesce((public.get_user_access(p_user_id)->>'premium')::boolean, false);
  IF v_exam_id IS NOT NULL THEN
    SELECT ep.is_premium INTO v_exam_premium FROM public.exam_papers ep WHERE ep.id = v_exam_id;
    IF coalesce(v_exam_premium, false) AND NOT v_premium THEN
      RAISE EXCEPTION 'premium_required' USING ERRCODE = 'P0403';
    END IF;
  END IF;

  IF v_attempt_id IS NOT NULL THEN
    SELECT array_agg(f.qid ORDER BY f.ord) INTO v_ids FROM (
      SELECT DISTINCT ON (s.qid) s.qid, s.ord FROM (
        SELECT e.val::uuid AS qid, e.ord
        FROM public.exam_progress p, jsonb_array_elements_text(p.question_ids) WITH ORDINALITY e(val, ord)
        WHERE p.id = v_attempt_id AND p.user_id = p_user_id AND jsonb_typeof(p.question_ids) = 'array'
      ) s ORDER BY s.qid, s.ord
    ) f;
  END IF;

  IF (v_ids IS NULL OR cardinality(v_ids) = 0) AND v_details IS NOT NULL
     AND jsonb_typeof(v_details->'details') = 'array' THEN
    SELECT array_agg(f.qid ORDER BY f.ord) INTO v_ids FROM (
      SELECT DISTINCT ON (s.qid) s.qid, s.ord FROM (
        SELECT (e.item->>'question_id')::uuid AS qid, e.ord
        FROM jsonb_array_elements(v_details->'details') WITH ORDINALITY e(item, ord)
        WHERE (e.item->>'question_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ) s ORDER BY s.qid, s.ord
    ) f;
  END IF;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    SELECT array_agg(f.qid ORDER BY f.ord) INTO v_ids FROM (
      SELECT d.question_id AS qid, row_number() OVER (ORDER BY d.created_at, d.id) AS ord
      FROM public.exam_history_details d WHERE d.exam_history_id = p_history_id
    ) f;
  END IF;

  v_ids := coalesce(v_ids, '{}'::uuid[]);
  v_ok := ARRAY(SELECT p.id FROM public.practiceable_question_ids(v_ids, v_premium) p);
  RETURN QUERY
  SELECT u.ord::int, u.qid, (u.qid = ANY (v_ok))
  FROM unnest(v_ids) WITH ORDINALITY u(qid, ord)
  ORDER BY u.ord;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_history_wrong_questions(p_user_id uuid, p_history_id uuid)
 RETURNS TABLE(question_id uuid, available boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_premium boolean; v_wrong uuid[]; v_ok uuid[];
BEGIN
  IF p_user_id IS NULL OR p_history_id IS NULL THEN RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM public.exam_history eh WHERE eh.id = p_history_id AND eh.user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'history_not_found' USING ERRCODE = 'P0002'; END IF;

  v_premium := coalesce((public.get_user_access(p_user_id)->>'premium')::boolean, false);
  v_wrong := ARRAY(SELECT DISTINCT d.question_id FROM public.exam_history_details d
                   WHERE d.exam_history_id = p_history_id AND d.is_correct IS FALSE);
  v_ok := ARRAY(SELECT p.id FROM public.practiceable_question_ids(v_wrong, v_premium) p);

  RETURN QUERY
  SELECT w.qid, (w.qid = ANY (v_ok))
  FROM unnest(v_wrong) w(qid)
  LEFT JOIN (SELECT s.question_id AS qid, s.pos FROM public.get_history_question_set(p_user_id, p_history_id) s) o
         ON o.qid = w.qid
  ORDER BY o.pos NULLS LAST, w.qid;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_mistake_pool(p_user_id uuid)
 RETURNS TABLE(question_id uuid, last_wrong_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_premium boolean;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023'; END IF;
  v_premium := coalesce((public.get_user_access(p_user_id)->>'premium')::boolean, false);
  RETURN QUERY
  WITH latest AS (
    SELECT DISTINCT ON (d.question_id)
           d.question_id AS qid, d.is_correct AS ok, coalesce(eh.submitted_at, eh.created_at) AS at
    FROM public.exam_history eh
    JOIN public.exam_history_details d ON d.exam_history_id = eh.id
    WHERE eh.user_id = p_user_id
      AND eh.status IS DISTINCT FROM 'fraud_detected'
      AND d.is_correct IS NOT NULL
    ORDER BY d.question_id, coalesce(eh.submitted_at, eh.created_at) DESC, d.created_at DESC
  ), wrong AS (
    SELECT l.qid, l.at FROM latest l WHERE l.ok IS FALSE
  )
  SELECT w.qid, w.at
  FROM wrong w
  WHERE w.qid IN (SELECT p.id FROM public.practiceable_question_ids((SELECT array_agg(x.qid) FROM wrong x), v_premium) p);
END;
$function$;

CREATE OR REPLACE FUNCTION public.count_mistake_pool(p_user_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ SELECT count(*)::int FROM public.get_mistake_pool(p_user_id); $function$;

CREATE OR REPLACE FUNCTION public.pick_mistake_questions(p_user_id uuid, p_count integer)
 RETURNS TABLE(question_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF p_count IS NULL OR p_count < 1 OR p_count > 100 THEN
    RAISE EXCEPTION 'invalid_count' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT p.question_id FROM public.get_mistake_pool(p_user_id) p ORDER BY random() LIMIT p_count;
END;
$function$;

revoke all on function public.practiceable_question_ids(uuid[], boolean) from public, anon, authenticated;
revoke all on function public.get_history_question_set(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_history_wrong_questions(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_mistake_pool(uuid) from public, anon, authenticated;
revoke all on function public.count_mistake_pool(uuid) from public, anon, authenticated;
revoke all on function public.pick_mistake_questions(uuid, integer) from public, anon, authenticated;

grant execute on function public.practiceable_question_ids(uuid[], boolean) to service_role;
grant execute on function public.get_history_question_set(uuid, uuid) to service_role;
grant execute on function public.get_history_wrong_questions(uuid, uuid) to service_role;
grant execute on function public.get_mistake_pool(uuid) to service_role;
grant execute on function public.count_mistake_pool(uuid) to service_role;
grant execute on function public.pick_mistake_questions(uuid, integer) to service_role;
