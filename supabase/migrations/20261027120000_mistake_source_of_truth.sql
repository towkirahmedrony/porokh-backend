-- One definition of "mistake" for every surface.
--
-- Product rule: a mistake is a question answered wrong OR skipped in a
-- submitted attempt, minus questions the user dismissed afterwards.
--
-- Before this migration the rule was implemented in four different places:
--   * public.get_history_wrong_questions  -> wrong + skipped of one attempt
--   * public.get_mistake_pool             -> latest wrong only, no skipped
--   * public.get_student_question_bank_v2 -> public.wrong_answers (never written)
--   * the history service                 -> its own JS filter over
--                                            exam_history_details
-- public.wrong_answers is a legacy table: nothing in the submission pipeline
-- inserts into it, so every surface that trusted it reported "no mistakes".
--
-- public.user_mistake_questions() is now the only definition. Everything else
-- (the Mistakes tab, the per-attempt practice count, per-attempt practice,
-- cross-exam mistake practice, the question-bank mistake filter) reads it, so
-- the surfaces cannot disagree again.
--
-- Safe to apply on a populated project: no table is altered and no attempt or
-- response row is deleted.

-- Legacy dismissals used to live in profiles.settings.mistake_dismissals while
-- the additive table was rolling out. Move them into the table once so they are
-- visible to the single definition below. Idempotent and failure-tolerant: a
-- malformed or stale entry is skipped instead of aborting the migration.
DO $$
DECLARE
  r record;
  v_at timestamp with time zone;
BEGIN
  FOR r IN
    SELECT p.id AS user_id, e.key AS question_id, e.value #>> '{}' AS raw
    FROM public.profiles p
    CROSS JOIN LATERAL jsonb_each(
      CASE
        WHEN jsonb_typeof(p.settings -> 'mistake_dismissals') = 'object'
          THEN p.settings -> 'mistake_dismissals'
        ELSE '{}'::jsonb
      END
    ) e
    WHERE e.key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  LOOP
    BEGIN
      v_at := coalesce(nullif(btrim(r.raw), '')::timestamp with time zone, now());
      INSERT INTO public.mistake_dismissals (user_id, question_id, created_at)
      VALUES (r.user_id, r.question_id::uuid, v_at)
      ON CONFLICT (user_id, question_id) DO NOTHING;
    EXCEPTION WHEN others THEN
      -- Unknown question, malformed timestamp or a user that disappeared: the
      -- legacy entry is simply not carried over.
      NULL;
    END;
  END LOOP;
END $$;

-- The single source of truth.
--
-- One row per question: the latest submitted response wins, so a question that
-- was later answered correctly stops being a mistake. status is 'wrong' when
-- the latest response is incorrect and 'skipped' when it has no answer (the
-- submission pipeline stores is_correct = NULL for skipped questions). A
-- dismissal hides the question until a newer response for it exists.
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
  WITH latest AS (
    SELECT DISTINCT ON (d.question_id)
           d.question_id,
           d.id AS detail_id,
           eh.id AS exam_history_id,
           eh.exam_id::text AS exam_id,
           d.is_correct,
           d.selected_option,
           coalesce(
             eh.submitted_at,
             eh.created_at,
             d.created_at,
             'epoch'::timestamp with time zone
           ) AS occurred_at
    FROM public.exam_history eh
    JOIN public.exam_history_details d ON d.exam_history_id = eh.id
    WHERE eh.user_id = p_user_id
      AND eh.status IS DISTINCT FROM 'fraud_detected'
    ORDER BY d.question_id,
             coalesce(eh.submitted_at, eh.created_at, 'epoch'::timestamp with time zone) DESC,
             d.created_at DESC,
             d.id DESC
  ),
  dismissed AS (
    SELECT md.question_id, max(md.created_at) AS dismissed_at
    FROM public.mistake_dismissals md
    WHERE md.user_id = p_user_id
    GROUP BY md.question_id
  )
  SELECT l.question_id,
         l.detail_id,
         l.exam_history_id,
         l.exam_id,
         CASE WHEN l.is_correct IS FALSE THEN 'wrong' ELSE 'skipped' END,
         l.selected_option,
         l.occurred_at
  FROM latest l
  LEFT JOIN dismissed x ON x.question_id = l.question_id
  WHERE l.is_correct IS DISTINCT FROM TRUE
    AND (x.dismissed_at IS NULL OR l.occurred_at > x.dismissed_at)
  ORDER BY l.occurred_at DESC, l.question_id;
$function$;

-- Per-attempt counts for the history list. Same rows, grouped by the attempt
-- the latest response came from, so a card's practice count always equals the
-- number of mistake cards that attempt contributes.
CREATE OR REPLACE FUNCTION public.get_user_mistake_counts(p_user_id uuid)
 RETURNS TABLE(exam_history_id uuid, mistake_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT m.exam_history_id, count(*)::integer
  FROM public.user_mistake_questions(p_user_id) m
  GROUP BY m.exam_history_id;
$function$;

-- Cross-exam mistake practice pool: the same rows, restricted to questions the
-- user may practise (published, active, not locked behind premium).
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
  WITH needs AS (
    SELECT m.question_id, m.occurred_at FROM public.user_mistake_questions(p_user_id) m
  ), pool AS (
    SELECT p.id
    FROM public.practiceable_question_ids(
      (SELECT array_agg(n.question_id) FROM needs n),
      v_premium
    ) p
  )
  SELECT n.question_id, n.occurred_at
  FROM needs n
  WHERE n.question_id IN (SELECT pool.id FROM pool);
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

-- Per-attempt practice ("ভুল ও স্কিপ করা অনুশীলন" on a history card) now takes
-- exactly the mistakes the card counted for that attempt, including skipped
-- questions and excluding dismissed ones.
CREATE OR REPLACE FUNCTION public.get_history_wrong_questions(p_user_id uuid, p_history_id uuid)
 RETURNS TABLE(question_id uuid, available boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_premium boolean; v_ids uuid[]; v_ok uuid[];
BEGIN
  IF p_user_id IS NULL OR p_history_id IS NULL THEN RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM public.exam_history eh WHERE eh.id = p_history_id AND eh.user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'history_not_found' USING ERRCODE = 'P0002'; END IF;

  v_premium := coalesce((public.get_user_access(p_user_id)->>'premium')::boolean, false);
  v_ids := ARRAY(
    SELECT m.question_id
    FROM public.user_mistake_questions(p_user_id) m
    WHERE m.exam_history_id = p_history_id
  );
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

revoke all on function public.user_mistake_questions(uuid) from public, anon, authenticated;
revoke all on function public.get_user_mistake_counts(uuid) from public, anon, authenticated;
revoke all on function public.get_mistake_pool(uuid) from public, anon, authenticated;
revoke all on function public.count_mistake_pool(uuid) from public, anon, authenticated;
revoke all on function public.pick_mistake_questions(uuid, integer) from public, anon, authenticated;
revoke all on function public.get_history_wrong_questions(uuid, uuid) from public, anon, authenticated;

grant execute on function public.user_mistake_questions(uuid) to service_role;
grant execute on function public.get_user_mistake_counts(uuid) to service_role;
grant execute on function public.get_mistake_pool(uuid) to service_role;
grant execute on function public.count_mistake_pool(uuid) to service_role;
grant execute on function public.pick_mistake_questions(uuid, integer) to service_role;
grant execute on function public.get_history_wrong_questions(uuid, uuid) to service_role;
