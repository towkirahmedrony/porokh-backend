-- Phase 1: Admission database foundation.
-- Prepared against the production schema on 2026-10-30; NOT applied by this task.
-- Additive only: existing papers keep a NULL admission_unit_id and all existing
-- question/exam associations remain unchanged.

CREATE TABLE IF NOT EXISTS public.admission_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL
    REFERENCES public.institutions(id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT,
  name_bn text NOT NULL,
  name_en text,
  code text NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admission_units_code_not_blank
    CHECK (char_length(btrim(code)) > 0)
);

-- Unit codes are case/whitespace insensitive within an institution, but the
-- same code (e.g. "A") is valid for different institutions.
CREATE UNIQUE INDEX IF NOT EXISTS uq_admission_units_institution_code
  ON public.admission_units (institution_id, lower(btrim(code)));

CREATE INDEX IF NOT EXISTS idx_admission_units_institution_active_order
  ON public.admission_units (institution_id, is_active, display_order);

ALTER TABLE public.exam_papers
  ADD COLUMN IF NOT EXISTS admission_unit_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'exam_papers_admission_unit_id_fkey'
      AND conrelid = 'public.exam_papers'::regclass
  ) THEN
    ALTER TABLE public.exam_papers
      ADD CONSTRAINT exam_papers_admission_unit_id_fkey
      FOREIGN KEY (admission_unit_id)
      REFERENCES public.admission_units(id)
      ON UPDATE CASCADE
      ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_exam_papers_admission_unit_id
  ON public.exam_papers (admission_unit_id)
  WHERE admission_unit_id IS NOT NULL;

-- Match the live institutions.updated_at convention. Deleting an in-use unit
-- is restricted by the FK; deactivate it instead.
DROP TRIGGER IF EXISTS trg_admission_units_updated_at ON public.admission_units;
CREATE TRIGGER trg_admission_units_updated_at
  BEFORE UPDATE ON public.admission_units
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.admission_units ENABLE ROW LEVEL SECURITY;

-- Unit identity, labels and ordering are non-sensitive catalog data. Students
-- may read active units only; inactive units remain visible to admins.
DROP POLICY IF EXISTS admission_units_read_active ON public.admission_units;
CREATE POLICY admission_units_read_active
  ON public.admission_units
  FOR SELECT
  TO anon, authenticated
  USING (is_active IS TRUE);

DROP POLICY IF EXISTS admission_units_admin_manage ON public.admission_units;
CREATE POLICY admission_units_admin_manage
  ON public.admission_units
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Do not grant anonymous mutation or student management privileges. Admin
-- writes are still constrained by the RLS policy above; backend service_role
-- retains its established server-only bypass.
REVOKE ALL ON TABLE public.admission_units FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.admission_units TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.admission_units TO authenticated;
GRANT ALL ON TABLE public.admission_units TO service_role;

COMMENT ON TABLE public.admission_units IS
  'University admission units. institution_id references public.institutions; unit codes are unique per institution.';
COMMENT ON COLUMN public.admission_units.institution_id IS
  'Parent university/institution; university identity is obtained through this relationship rather than duplicated on exam_papers.';
COMMENT ON COLUMN public.exam_papers.admission_unit_id IS
  'Optional admission unit for this paper. NULL preserves all existing non-admission and legacy papers.';
COMMENT ON COLUMN public.exam_papers.meta_data IS
  'Backward-compatible JSONB. Canonical admission metadata (when present): top-level exam_mode in past_exam|subject_practice|model_test; admission_session as a string; optional admission_display object for non-relational labels/order. Keep all existing keys intact. Legacy student-adapter keys such as group/stream, university_id/institution_id, unit/unit_slug/unit_code/unit_name, year/exam_year, exam_type/type and order/sequence remain readable during migration. Unit identity is canonicalized by admission_unit_id for newly linked papers; do not duplicate the university in new relational columns.';
