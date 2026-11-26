-- Rollback for 20261126140000_mistake_bookmark_explorer.sql.
-- Drops only the functions this migration added; no table or row is touched.

DROP FUNCTION IF EXISTS public.get_dismissed_mistakes(uuid);
DROP FUNCTION IF EXISTS public.pick_mistake_bookmark_questions(uuid, text, jsonb, integer);
DROP FUNCTION IF EXISTS public.get_mistake_bookmark_questions(uuid, text, jsonb, text, integer, integer);
DROP FUNCTION IF EXISTS public.count_mistake_bookmark_questions(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.get_mistake_bookmark_facets(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public._mbe_base(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public._mbe_match(jsonb, text, text, text, text, uuid, text, text, boolean, text);
