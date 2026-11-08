-- Admission Hub: university logos, catalog/unit reads and the unit question bank.
--
-- Additive only. The hub reads the existing first-class columns:
--   exam_papers.category = 'admission' | 'model_test'
--   exam_papers.admission_unit_id
--   question_institution_references.admission_unit_id
--
-- The list RPC never returns an answer key. Answers are fetched separately for
-- rendered ids, and only for published/active questions the caller may read.

ALTER TABLE public.institutions
  ADD COLUMN IF NOT EXISTS logo_url text;

COMMENT ON COLUMN public.institutions.logo_url IS
  'Relative app asset path for the institution logo (for example /logos/universities/university-of-dhaka.png). NULL means the UI uses its initials badge.';

-- The hub filters published unit papers by category/year and the bank by unit,
-- exam type and year. Both indexes keep those reads index-only friendly.
CREATE INDEX IF NOT EXISTS idx_exam_papers_unit_category_year
  ON public.exam_papers (admission_unit_id, category, is_published, exam_year_label DESC)
  WHERE admission_unit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_qir_unit_exam_year
  ON public.question_institution_references (admission_unit_id, exam_type, exam_year_label)
  WHERE admission_unit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_institutions_type_active
  ON public.institutions (type, is_active);

-- ---------------------------------------------------------------------------
-- Catalog: universities with at least one active unit, each unit's counts.
-- One request per grid render; counts are aggregated, never fetched per card.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admission_hub_catalog()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
WITH active_units AS (
  SELECT
    u.id,
    u.institution_id,
    u.name_bn,
    u.name_en,
    u.code,
    u.display_order,
    u.group_type
  FROM public.admission_units u
  WHERE u.is_active IS TRUE
),
paper_stats AS (
  SELECT
    ep.admission_unit_id,
    count(*) FILTER (WHERE ep.category = 'admission') AS past_paper_count,
    count(*) FILTER (WHERE ep.category = 'model_test') AS model_test_count
  FROM public.exam_papers ep
  WHERE ep.is_published IS TRUE
    AND ep.admission_unit_id IS NOT NULL
  GROUP BY ep.admission_unit_id
),
bank_stats AS (
  SELECT
    r.admission_unit_id,
    count(DISTINCT r.question_id) AS question_count
  FROM public.question_institution_references r
  JOIN public.questions q ON q.id = r.question_id
  WHERE r.admission_unit_id IS NOT NULL
    AND r.exam_type = 'admission'
    AND q.is_active IS TRUE
    AND q.status = 'published'
    AND q.deleted_at IS NULL
  GROUP BY r.admission_unit_id
),
unit_rows AS (
  SELECT
    i.id AS institution_id,
    i.name_bn,
    i.name_en,
    i.short_name,
    i.slug,
    i.logo_url,
    i.location,
    i.display_order,
    jsonb_agg(
      jsonb_build_object(
        'id', u.id,
        'name_bn', u.name_bn,
        'name_en', u.name_en,
        'code', u.code,
        'display_order', u.display_order,
        'group_type', u.group_type,
        'past_paper_count', coalesce(p.past_paper_count, 0),
        'model_test_count', coalesce(p.model_test_count, 0),
        'question_count', coalesce(b.question_count, 0),
        'is_available',
          (coalesce(p.past_paper_count, 0)
            + coalesce(p.model_test_count, 0)
            + coalesce(b.question_count, 0)) > 0
      )
      ORDER BY u.display_order, u.name_bn
    ) AS units
  FROM public.institutions i
  JOIN active_units u ON u.institution_id = i.id
  LEFT JOIN paper_stats p ON p.admission_unit_id = u.id
  LEFT JOIN bank_stats b ON b.admission_unit_id = u.id
  WHERE i.type = 'university'
    AND i.is_active IS TRUE
  GROUP BY
    i.id,
    i.name_bn,
    i.name_en,
    i.short_name,
    i.slug,
    i.logo_url,
    i.location,
    i.display_order
)
SELECT jsonb_build_object(
  'universities',
  coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', u.institution_id,
        'name_bn', u.name_bn,
        'name_en', u.name_en,
        'short_name', u.short_name,
        'slug', u.slug,
        'logo_url', u.logo_url,
        'location', u.location,
        'display_order', u.display_order,
        'unit_count', jsonb_array_length(u.units),
        'past_paper_count',
          (SELECT coalesce(sum((unit->>'past_paper_count')::int), 0)
           FROM jsonb_array_elements(u.units) AS unit),
        'model_test_count',
          (SELECT coalesce(sum((unit->>'model_test_count')::int), 0)
           FROM jsonb_array_elements(u.units) AS unit),
        'question_count',
          (SELECT coalesce(sum((unit->>'question_count')::int), 0)
           FROM jsonb_array_elements(u.units) AS unit),
        'units', u.units
      )
      ORDER BY u.display_order NULLS LAST, u.name_bn
    ),
    '[]'::jsonb
  )
)
FROM unit_rows u;
$$;

-- ---------------------------------------------------------------------------
-- Unit hub: unit identity, its published papers and the bank's facets.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admission_unit_hub(
  p_institution_slug text,
  p_unit_code text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_slug text := nullif(btrim(coalesce(p_institution_slug, '')), '');
  v_code text := nullif(lower(btrim(coalesce(p_unit_code, ''))), '');
  v_unit_id uuid;
BEGIN
  IF v_slug IS NULL OR v_code IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT u.id
  INTO v_unit_id
  FROM public.admission_units u
  JOIN public.institutions i ON i.id = u.institution_id
  WHERE i.type = 'university'
    AND i.is_active IS TRUE
    AND i.slug = v_slug
    AND u.is_active IS TRUE
    AND lower(btrim(u.code)) = v_code
  LIMIT 1;

  IF v_unit_id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN (
    WITH target AS (
      SELECT
        u.id,
        u.institution_id,
        u.name_bn,
        u.name_en,
        u.code,
        u.description,
        u.display_order,
        u.group_type,
        i.name_bn AS university_name_bn,
        i.name_en AS university_name_en,
        i.short_name AS university_short_name,
        i.slug AS university_slug,
        i.logo_url AS university_logo_url
      FROM public.admission_units u
      JOIN public.institutions i ON i.id = u.institution_id
      WHERE u.id = v_unit_id
    ),
    papers AS (
      SELECT
        ep.id,
        ep.title,
        ep.title_en,
        ep.category,
        ep.exam_year_label,
        ep.exam_session,
        ep.duration_min,
        ep.total_marks,
        ep.default_negative_marks,
        ep.is_premium,
        ep.start_time,
        ep.end_time,
        ep.created_at,
        (
          SELECT count(*)
          FROM public.exam_paper_questions q
          WHERE q.exam_id = ep.id
        ) AS question_count
      FROM public.exam_papers ep
      WHERE ep.admission_unit_id = v_unit_id
        AND ep.is_published IS TRUE
        AND ep.category IN ('admission', 'model_test')
    ),
    bank_scope AS (
      SELECT DISTINCT
        q.id,
        q.subject_id,
        q.topic_id,
        r.exam_year_label
      FROM public.question_institution_references r
      JOIN public.questions q ON q.id = r.question_id
      WHERE r.admission_unit_id = v_unit_id
        AND r.exam_type = 'admission'
        AND q.is_active IS TRUE
        AND q.status = 'published'
        AND q.deleted_at IS NULL
    )
    SELECT jsonb_build_object(
      'unit', (
        SELECT jsonb_build_object(
          'id', t.id,
          'name_bn', t.name_bn,
          'name_en', t.name_en,
          'code', t.code,
          'description', t.description,
          'display_order', t.display_order,
          'group_type', t.group_type
        )
        FROM target t
      ),
      'university', (
        SELECT jsonb_build_object(
          'id', t.institution_id,
          'name_bn', t.university_name_bn,
          'name_en', t.university_name_en,
          'short_name', t.university_short_name,
          'slug', t.university_slug,
          'logo_url', t.university_logo_url
        )
        FROM target t
      ),
      'past_papers', coalesce(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', p.id,
              'title', p.title,
              'title_en', p.title_en,
              'category', p.category,
              'exam_year_label', p.exam_year_label,
              'exam_session', p.exam_session,
              'duration_min', p.duration_min,
              'total_marks', p.total_marks,
              'default_negative_marks', p.default_negative_marks,
              'is_premium', p.is_premium,
              'start_time', p.start_time,
              'end_time', p.end_time,
              'question_count', p.question_count
            )
            ORDER BY p.exam_year_label DESC NULLS LAST, p.created_at DESC
          )
          FROM papers p
          WHERE p.category = 'admission'
        ),
        '[]'::jsonb
      ),
      'model_tests', coalesce(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', p.id,
              'title', p.title,
              'title_en', p.title_en,
              'category', p.category,
              'exam_year_label', p.exam_year_label,
              'exam_session', p.exam_session,
              'duration_min', p.duration_min,
              'total_marks', p.total_marks,
              'default_negative_marks', p.default_negative_marks,
              'is_premium', p.is_premium,
              'start_time', p.start_time,
              'end_time', p.end_time,
              'question_count', p.question_count
            )
            ORDER BY p.exam_year_label DESC NULLS LAST, p.created_at DESC
          )
          FROM papers p
          WHERE p.category = 'model_test'
        ),
        '[]'::jsonb
      ),
      'bank', jsonb_build_object(
        'total', (SELECT count(DISTINCT b.id) FROM bank_scope b),
        'years', coalesce(
          (
            SELECT jsonb_agg(
              jsonb_build_object('label', y.label, 'count', y.question_count)
              ORDER BY y.label DESC
            )
            FROM (
              SELECT b.exam_year_label AS label, count(DISTINCT b.id) AS question_count
              FROM bank_scope b
              WHERE b.exam_year_label IS NOT NULL
              GROUP BY b.exam_year_label
            ) y
          ),
          '[]'::jsonb
        ),
        'subjects', coalesce(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', s.id,
                'name_bn', s.name_bn,
                'name_en', s.name_en,
                'question_count', x.question_count
              )
              ORDER BY s.sequence NULLS LAST, s.name_bn
            )
            FROM (
              SELECT b.subject_id, count(DISTINCT b.id) AS question_count
              FROM bank_scope b
              WHERE b.subject_id IS NOT NULL
              GROUP BY b.subject_id
            ) x
            JOIN public.subjects s ON s.id = x.subject_id
          ),
          '[]'::jsonb
        ),
        'topics', coalesce(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', t.id,
                'subject_id', c2.subject_id,
                'chapter_id', t.chapter_id,
                'name_bn', t.name_bn,
                'name_en', t.name_en,
                'question_count', x.question_count
              )
              ORDER BY t.sequence NULLS LAST, t.name_bn
            )
            FROM (
              SELECT b.topic_id, count(DISTINCT b.id) AS question_count
              FROM bank_scope b
              WHERE b.topic_id IS NOT NULL
              GROUP BY b.topic_id
            ) x
            JOIN public.topics t ON t.id = x.topic_id
            LEFT JOIN public.chapters c2 ON c2.id = t.chapter_id
          ),
          '[]'::jsonb
        )
      )
    )
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Unit question bank page. Same row contract as get_student_question_bank_v2
-- so the student app reuses its mapper and question card unchanged.
-- Live, still-running scheduled papers are excluded; always-open past/model
-- papers remain readable because the bank is view-only practice.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admission_unit_question_bank_v2(
  p_admission_unit_id uuid,
  p_exam_year_label text DEFAULT NULL,
  p_subject_id text DEFAULT NULL,
  p_topic_id text DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_access jsonb;
  v_has_premium boolean := false;
  v_unit_id uuid := p_admission_unit_id;
  v_year text := nullif(btrim(coalesce(p_exam_year_label, '')), '');
  v_subject_id text := nullif(btrim(coalesce(p_subject_id, '')), '');
  v_topic_id text := nullif(btrim(coalesce(p_topic_id, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING errcode = '42501';
  END IF;

  IF v_unit_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.admission_units u
    WHERE u.id = v_unit_id AND u.is_active IS TRUE
  ) THEN
    RETURN;
  END IF;

  v_access := public.get_user_access(v_uid);
  v_has_premium := coalesce((v_access->>'premium')::boolean, false)
    OR coalesce((v_access->>'unlimited_all')::boolean, false);

  RETURN QUERY
  SELECT jsonb_build_object(
    'id', r.id,
    'type', r.type,
    'difficulty_level', r.difficulty_level,
    'source_type', r.source_type,
    'tags', coalesce(to_jsonb(r.tags), '[]'::jsonb),
    'exam_references', coalesce(r.exam_references, '[]'::jsonb),
    'subject_id', r.subject_id,
    'chapter_id', r.chapter_id,
    'topic_id', r.topic_id,
    'total_attempts', coalesce(r.total_attempts, 0),
    'correct_attempts', coalesce(r.correct_attempts, 0),
    'created_at', r.created_at,
    'total_count', r.total_count,
    'body',
      CASE
        WHEN r.locked THEN '{}'::jsonb
        ELSE jsonb_strip_nulls(
          jsonb_build_object(
            'text_bn', CASE WHEN jsonb_typeof(r.body -> 'text_bn') = 'string' THEN r.body -> 'text_bn' END,
            'text_en', CASE WHEN jsonb_typeof(r.body -> 'text_en') = 'string' THEN r.body -> 'text_en' END,
            'image_url', CASE WHEN jsonb_typeof(r.body -> 'image_url') = 'string' THEN r.body -> 'image_url' END
          )
        )
      END,
    'options',
      CASE
        WHEN r.locked OR jsonb_typeof(r.options) <> 'array' THEN '[]'::jsonb
        ELSE (
          SELECT coalesce(
            jsonb_agg(
              jsonb_strip_nulls(
                jsonb_build_object(
                  'id', CASE WHEN jsonb_typeof(o.item -> 'id') IN ('string', 'number') THEN o.item -> 'id' END,
                  'text_bn', CASE WHEN jsonb_typeof(o.item -> 'text_bn') = 'string' THEN o.item -> 'text_bn' END,
                  'text_en', CASE WHEN jsonb_typeof(o.item -> 'text_en') = 'string' THEN o.item -> 'text_en' END
                )
              )
              ORDER BY o.ord
            ),
            '[]'::jsonb
          )
          FROM jsonb_array_elements(r.options) WITH ORDINALITY AS o(item, ord)
        )
      END,
    'explanation', CASE WHEN r.locked THEN NULL ELSE to_jsonb(r.explanation) END,
    'subjects', jsonb_build_object(
      'id', r.s_id,
      'name_bn', r.s_name_bn,
      'name_en', r.s_name_en,
      'slug', r.s_slug,
      'is_premium', r.s_prem,
      'sequence', r.s_seq
    ),
    'chapters', CASE WHEN r.c_id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', r.c_id,
      'subject_id', r.subject_id,
      'name_bn', r.c_name_bn,
      'name_en', r.c_name_en,
      'slug', r.c_slug,
      'is_premium', r.c_prem,
      'sequence', r.c_seq
    ) END,
    'topics', CASE WHEN r.t_id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', r.t_id,
      'chapter_id', r.chapter_id,
      'name_bn', r.t_name_bn,
      'name_en', r.t_name_en,
      'slug', r.t_slug,
      'is_premium', r.t_prem,
      'sequence', r.t_seq,
      'total_questions', r.t_total
    ) END
  )
  FROM (
    SELECT
      q.*,
      s.id AS s_id,
      s.name_bn AS s_name_bn,
      s.name_en AS s_name_en,
      s.slug AS s_slug,
      s.is_premium AS s_prem,
      s.sequence AS s_seq,
      c.id AS c_id,
      c.name_bn AS c_name_bn,
      c.name_en AS c_name_en,
      c.slug AS c_slug,
      c.is_premium AS c_prem,
      c.sequence AS c_seq,
      t.id AS t_id,
      t.name_bn AS t_name_bn,
      t.name_en AS t_name_en,
      t.slug AS t_slug,
      t.is_premium AS t_prem,
      t.sequence AS t_seq,
      t.total_questions AS t_total,
      (
        (
          coalesce(s.is_premium, false)
          OR coalesce(c.is_premium, false)
          OR coalesce(t.is_premium, false)
        )
        AND NOT v_has_premium
      ) AS locked,
      count(*) OVER () AS total_count
    FROM public.questions q
    JOIN public.subjects s ON s.id = q.subject_id AND s.is_active IS TRUE
    LEFT JOIN public.chapters c ON c.id = q.chapter_id
    LEFT JOIN public.topics t ON t.id = q.topic_id
    WHERE q.status = 'published'
      AND q.is_active IS TRUE
      AND q.deleted_at IS NULL
      AND (q.chapter_id IS NULL OR c.is_active IS TRUE)
      AND (q.topic_id IS NULL OR t.is_active IS TRUE)
      AND EXists (
        SELECT 1
        FROM public.question_institution_references ref
        WHERE ref.question_id = q.id
          AND ref.admission_unit_id = v_unit_id
          AND ref.exam_type = 'admission'
          AND (v_year IS NULL OR ref.exam_year_label = v_year)
      )
      AND (v_subject_id IS NULL OR q.subject_id = v_subject_id)
      AND (v_topic_id IS NULL OR q.topic_id = v_topic_id)
      AND NOT EXISTS (
        SELECT 1
        FROM public.exam_paper_questions epq
        JOIN public.exam_papers ep ON ep.id = epq.exam_id
        WHERE epq.question_id = q.id
          AND ep.is_published IS TRUE
          AND ep.start_time IS NOT NULL
          AND ep.start_time <= now()
          AND ep.end_time IS NOT NULL
          AND ep.end_time > now()
      )
    ORDER BY q.created_at DESC, q.id ASC
    LIMIT v_limit
    OFFSET v_offset
  ) r;
END;
$$;

-- ---------------------------------------------------------------------------
-- Answer key for the unit bank. Same redaction as the list: premium rows the
-- caller cannot read are omitted, and so are questions in a live paper.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admission_unit_question_answers(
  p_admission_unit_id uuid,
  p_question_ids text[]
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_access jsonb;
  v_has_premium boolean := false;
  v_unit_id uuid := p_admission_unit_id;
  v_question_ids text[] := array(
    SELECT DISTINCT btrim(candidate)
    FROM unnest(coalesce(p_question_ids, '{}'::text[])) AS candidate
    WHERE btrim(candidate) <> ''
  );
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING errcode = '42501';
  END IF;

  IF v_unit_id IS NULL OR cardinality(v_question_ids) = 0 THEN
    RETURN;
  END IF;

  v_access := public.get_user_access(v_uid);
  v_has_premium := coalesce((v_access->>'premium')::boolean, false)
    OR coalesce((v_access->>'unlimited_all')::boolean, false);

  RETURN QUERY
  SELECT jsonb_build_object(
    'id', q.id,
    'correct_option_ids',
      CASE
        WHEN jsonb_typeof(q.options) <> 'array' THEN '[]'::jsonb
        ELSE coalesce(
          (
            SELECT jsonb_agg(o.item -> 'id' ORDER BY o.ord)
            FROM jsonb_array_elements(q.options) WITH ORDINALITY AS o(item, ord)
            WHERE (
              o.item @> '{"isCorrect": true}'::jsonb
              OR o.item @> '{"is_correct": true}'::jsonb
            )
            AND jsonb_typeof(o.item -> 'id') IN ('string', 'number')
          ),
          '[]'::jsonb
        )
      END
  )
  FROM (
    SELECT
      q.*,
      (
        (
          coalesce(s.is_premium, false)
          OR coalesce(c.is_premium, false)
          OR coalesce(t.is_premium, false)
        )
        AND NOT v_has_premium
      ) AS locked
    FROM public.questions q
    JOIN public.subjects s ON s.id = q.subject_id AND s.is_active IS TRUE
    LEFT JOIN public.chapters c ON c.id = q.chapter_id
    LEFT JOIN public.topics t ON t.id = q.topic_id
    WHERE q.id::text = ANY (v_question_ids)
      AND q.status = 'published'
      AND q.is_active IS TRUE
      AND q.deleted_at IS NULL
      AND (q.chapter_id IS NULL OR c.is_active IS TRUE)
      AND (q.topic_id IS NULL OR t.is_active IS TRUE)
      AND EXISTS (
        SELECT 1
        FROM public.question_institution_references ref
        WHERE ref.question_id = q.id
          AND ref.admission_unit_id = v_unit_id
          AND ref.exam_type = 'admission'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.exam_paper_questions epq
        JOIN public.exam_papers ep ON ep.id = epq.exam_id
        WHERE epq.question_id = q.id
          AND ep.is_published IS TRUE
          AND ep.start_time IS NOT NULL
          AND ep.start_time <= now()
          AND ep.end_time IS NOT NULL
          AND ep.end_time > now()
      )
  ) q
  WHERE NOT q.locked;
END;
$$;

REVOKE ALL ON FUNCTION public.get_admission_hub_catalog() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_admission_unit_hub(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_admission_unit_question_bank_v2(uuid, text, text, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_admission_unit_question_answers(uuid, text[]) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_admission_hub_catalog() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admission_unit_hub(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admission_unit_question_bank_v2(uuid, text, text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admission_unit_question_answers(uuid, text[]) TO authenticated;
