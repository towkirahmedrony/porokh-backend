-- Wrong + skipped practice and historical time limits.
--
-- Mirrors the definitions already live on the test project (version
-- 20261026055549). The functions remain SECURITY DEFINER with an empty
-- search_path and are callable only by the service-role backend. The backend
-- always passes p_user_id from the verified session, never from the client.

CREATE OR REPLACE FUNCTION public.get_history_wrong_questions(p_user_id uuid, p_history_id uuid)
 RETURNS TABLE(question_id uuid, available boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  SELECT s.question_id, s.available
  FROM public.get_history_question_set(p_user_id, p_history_id) s
  WHERE NOT EXISTS (
    SELECT 1 FROM public.exam_history_details d
    WHERE d.exam_history_id = p_history_id AND d.question_id = s.question_id AND d.is_correct IS TRUE
  )
  ORDER BY s.pos;
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
    ORDER BY d.question_id, coalesce(eh.submitted_at, eh.created_at) DESC, d.created_at DESC
  ), needs AS (
    SELECT l.qid, l.at FROM latest l WHERE l.ok IS DISTINCT FROM TRUE
  )
  SELECT n.qid, n.at
  FROM needs n
  WHERE n.qid IN (SELECT p.id FROM public.practiceable_question_ids((SELECT array_agg(x.qid) FROM needs x), v_premium) p);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_history_time_limit(p_user_id uuid, p_history_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_exam_id text; v_attempt_id uuid; v_secs integer;
BEGIN
  IF p_user_id IS NULL OR p_history_id IS NULL THEN RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023'; END IF;
  SELECT eh.exam_id, eh.attempt_id INTO v_exam_id, v_attempt_id
  FROM public.exam_history eh WHERE eh.id = p_history_id AND eh.user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'history_not_found' USING ERRCODE = 'P0002'; END IF;

  IF v_exam_id IS NOT NULL THEN
    SELECT (ep.duration_min * 60)::int INTO v_secs FROM public.exam_papers ep WHERE ep.id = v_exam_id;
  ELSIF v_attempt_id IS NOT NULL THEN
    SELECT extract(epoch FROM (p.deadline_at - p.started_at))::int INTO v_secs
    FROM public.exam_progress p
    WHERE p.id = v_attempt_id AND p.user_id = p_user_id AND p.deadline_at IS NOT NULL AND p.started_at IS NOT NULL;
  END IF;
  RETURN CASE WHEN v_secs IS NOT NULL AND v_secs > 0 THEN v_secs ELSE NULL END;
END;
$function$;

revoke all on function public.get_history_wrong_questions(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_mistake_pool(uuid) from public, anon, authenticated;
revoke all on function public.get_history_time_limit(uuid, uuid) from public, anon, authenticated;

grant execute on function public.get_history_wrong_questions(uuid, uuid) to service_role;
grant execute on function public.get_mistake_pool(uuid) to service_role;
grant execute on function public.get_history_time_limit(uuid, uuid) to service_role;
