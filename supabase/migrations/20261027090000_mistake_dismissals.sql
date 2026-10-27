-- Question-level dismissals for the Mistakes tab.
--
-- Mistakes are derived from the latest response per question in
-- exam_history_details, so they stay historically accurate and never duplicate
-- a question. A dismissal is an additive, user-owned overlay: deleting a
-- mistake hides that question from the list without changing or deleting any
-- historical attempt or response. A later wrong answer is newer than the
-- dismissal and makes the question visible again.
--
-- Safe to apply on a populated project: no existing table is altered and no
-- historical row is removed.

CREATE TABLE IF NOT EXISTS public.mistake_dismissals (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, question_id)
);

ALTER TABLE public.mistake_dismissals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mistake_dismissals_select_own" ON public.mistake_dismissals;
CREATE POLICY "mistake_dismissals_select_own"
  ON public.mistake_dismissals
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "mistake_dismissals_insert_own" ON public.mistake_dismissals;
CREATE POLICY "mistake_dismissals_insert_own"
  ON public.mistake_dismissals
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "mistake_dismissals_delete_own" ON public.mistake_dismissals;
CREATE POLICY "mistake_dismissals_delete_own"
  ON public.mistake_dismissals
  FOR DELETE
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON public.mistake_dismissals FROM PUBLIC, anon;
GRANT SELECT, INSERT, DELETE ON public.mistake_dismissals TO authenticated;
GRANT ALL ON public.mistake_dismissals TO service_role;
