-- Mistakes tab: one row per question (latest response wins), label 'wrong' when
-- the most recent ANSWERED response was wrong, else 'skipped'.
-- History card + per-attempt practice: attempt-local (wrong + skipped of that
-- attempt, minus questions dismissed after it). Signatures and grants unchanged.

CREATE OR REPLACE FUNCTION public.user_mistake_questions(p_user_id uuid)
 RETURNS TABLE(
   question_id uuid,
   detail_id uuid,
   exam_history_id uuid,
   exam_id text,
   status text,
   selected_option text,
   occurred_at timestamp with time zone
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH resp AS (
    SELECT d.question_id AS qid,
           d.id AS did,
           eh.id AS hid,
           eh.exam_id::text AS eid,
           d.is_correct AS ok,
           d.selected_option AS sel,
           d.created_at AS dca,
           coalesce(eh.submitted_at, eh.created_at, d.created_at, 'epoch'::timestamp with time zone) AS occ
    FROM public.exam_history eh
    JOIN public.exam_history_details d ON d.exam_history_id = eh.id
    WHERE eh.user_id = p_user_id
      AND eh.status IS DISTINCT FROM 'fraud_detected'
  ),
  latest AS (
    SELECT DISTINCT ON (r.qid) r.*
    FROM resp r
    ORDER BY r.qid, r.occ DESC, r.dca DESC, r.did DESC
  ),
  last_answered AS (
    SELECT DISTINCT ON (r.qid) r.qid, r.ok, r.sel
    FROM resp r
    WHERE r.ok IS NOT NULL
    ORDER BY r.qid, r.occ DESC, r.dca DESC, r.did DESC
  ),
  dismissed AS (
    SELECT md.question_id AS qid, max(md.created_at) AS dismissed_at
    FROM public.mistake_dismissals md
    WHERE md.user_id = p_user_id
    GROUP BY md.question_id
  )
  SELECT l.qid,
         l.did,
         l.hid,
         l.eid,
         CASE WHEN la.ok IS FALSE THEN 'wrong' ELSE 'skipped' END,
         CASE WHEN la.ok IS FALSE THEN la.sel END,
         l.occ
  FROM latest l
  LEFT JOIN last_answered la ON la.qid = l.qid
  LEFT JOIN dismissed x ON x.qid = l.qid
  WHERE l.ok IS DISTINCT FROM TRUE
    AND (x.dismissed_at IS NULL OR l.occ > x.dismissed_at)
  ORDER BY l.occ DESC, l.qid;
$function$;

CREATE OR REPLACE FUNCTION public.get_user_mistake_counts(p_user_id uuid)
 RETURNS TABLE(exam_history_id uuid, mistake_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT eh.id,
         CASE
           WHEN EXISTS (SELECT 1 FROM public.exam_history_details x WHERE x.exam_history_id = eh.id)
           THEN (
             SELECT count(DISTINCT d.question_id)::integer
             FROM public.exam_history_details d
             WHERE d.exam_history_id = eh.id
               AND NOT EXISTS (
                 SELECT 1 FROM public.exam_history_details c
                 WHERE c.exam_history_id = eh.id AND c.question_id = d.question_id AND c.is_correct IS TRUE
               )
               AND NOT EXISTS (
                 SELECT 1 FROM public.mistake_dismissals md
                 WHERE md.user_id = p_user_id AND md.question_id = d.question_id
                   AND md.created_at >= coalesce(eh.submitted_at, eh.created_at, 'epoch'::timestamp with time zone)
               )
           )
           ELSE greatest(coalesce(eh.wrong_count, 0) + coalesce(eh.skipped_count, 0), 0)
         END
  FROM public.exam_history eh
  WHERE eh.user_id = p_user_id;
$function$;

CREATE OR REPLACE FUNCTION public.get_history_wrong_questions(p_user_id uuid, p_history_id uuid)
 RETURNS TABLE(question_id uuid, available boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_premium boolean;
  v_ids uuid[];
  v_ok uuid[];
  v_at timestamp with time zone;
  v_has_details boolean;
BEGIN
  IF p_user_id IS NULL OR p_history_id IS NULL THEN RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023'; END IF;
  SELECT coalesce(eh.submitted_at, eh.created_at, 'epoch'::timestamp with time zone) INTO v_at
  FROM public.exam_history eh WHERE eh.id = p_history_id AND eh.user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'history_not_found' USING ERRCODE = 'P0002'; END IF;

  v_premium := coalesce((public.get_user_access(p_user_id)->>'premium')::boolean, false);
  v_has_details := EXISTS (SELECT 1 FROM public.exam_history_details x WHERE x.exam_history_id = p_history_id);

  IF v_has_details THEN
    v_ids := ARRAY(
      SELECT DISTINCT d.question_id
      FROM public.exam_history_details d
      WHERE d.exam_history_id = p_history_id
        AND NOT EXISTS (
          SELECT 1 FROM public.exam_history_details c
          WHERE c.exam_history_id = p_history_id AND c.question_id = d.question_id AND c.is_correct IS TRUE
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.mistake_dismissals md
          WHERE md.user_id = p_user_id AND md.question_id = d.question_id AND md.created_at >= v_at
        )
    );
  ELSE
    v_ids := ARRAY(
      SELECT s.question_id
      FROM public.get_history_question_set(p_user_id, p_history_id) s
      WHERE NOT EXISTS (
        SELECT 1 FROM public.mistake_dismissals md
        WHERE md.user_id = p_user_id AND md.question_id = s.question_id AND md.created_at >= v_at
      )
    );
  END IF;

  v_ok := ARRAY(SELECT p.id FROM public.practiceable_question_ids(v_ids, v_premium) p);

  RETURN QUERY
  SELECT w.qid, (w.qid = ANY (v_ok))
  FROM unnest(v_ids) w(qid)
  LEFT JOIN (
    SELECT s.question_id AS qid, s.pos
    FROM public.get_history_question_set(p_user_id, p_history_id) s
  ) o ON o.qid = w.qid
  ORDER BY o.pos NULLS LAST, w.qid;
END;
$function$;

REVOKE ALL ON FUNCTION public.user_mistake_questions(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_user_mistake_counts(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_history_wrong_questions(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.user_mistake_questions(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_user_mistake_counts(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_history_wrong_questions(uuid, uuid) TO service_role;
