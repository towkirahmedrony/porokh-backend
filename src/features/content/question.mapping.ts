import type { AdmissionUnitRecord, InstitutionRecord } from './exam-references.core';

/**
 * Question mapping: the three separate concepts behind one master question.
 *
 * SOURCE  — where we got it (`question_sources.source_type`).
 * OCCURRENCE — a real past exam it appeared in (`question_institution_references`).
 * TRACK   — who practices it (`question_preparation_tracks`).
 *
 * Pure and database-free: the service layer loads institutions and units and
 * passes them in, so every rule here can be tested without a live project.
 */

/** `question_sources.source_type` CHECK values. */
export const QUESTION_SOURCE_TYPES = [
  'official_paper',
  'guidebook',
  'textbook',
  'coaching_material',
  'website',
  'user_submission',
  'unknown',
] as const;

export type QuestionSourceType = (typeof QUESTION_SOURCE_TYPES)[number];

/** Exam types that describe a real past exam, so they produce an occurrence. */
export const OCCURRENCE_EXAM_TYPES = [
  'board_exam',
  'admission',
  'college_test',
  'school_exam',
  'university_exam',
] as const;

export type OccurrenceExamType = (typeof OCCURRENCE_EXAM_TYPES)[number];

/**
 * Legacy `@source` values that were really an exam type. They stay accepted so
 * an old file never fails, but they are reported as deprecated.
 */
export const LEGACY_EXAM_SOURCE_TYPES = [
  'board_exam',
  'admission',
  'college_test',
  'school_exam',
  'university_exam',
  'model_test',
] as const;

/** `questions.source_type` CHECK values; the legacy column the student RPCs read. */
export const LEGACY_QUESTION_SOURCE_TYPES = [
  'board_exam',
  'admission',
  'college_test',
  'model_test',
  'textbook',
  'guidebook',
  'school_exam',
  'university_exam',
  'unknown',
] as const;

/** `preparation_tracks` ids, used to reject a typo before it reaches the FK. */
export const PREPARATION_TRACK_IDS = ['hsc', 'admission', 'varsity', 'medical', 'engineering'] as const;

export type PreparationTrackId = (typeof PREPARATION_TRACK_IDS)[number];

/** Reference kind stored in the legacy `questions.exam_references` jsonb. */
const EXAM_TYPE_REFERENCE_KIND: Record<OccurrenceExamType, string> = {
  board_exam: 'board',
  admission: 'admission',
  college_test: 'college',
  school_exam: 'school',
  university_exam: 'university',
};

const REFERENCE_KIND_EXAM_TYPE: Record<string, OccurrenceExamType> = {
  board: 'board_exam',
  admission: 'admission',
  college: 'college_test',
  school: 'school_exam',
  university: 'university_exam',
};

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

export const toEnglishDigits = (value: string): string =>
  value.replace(/[০-৯]/g, (digit) => String(BN_DIGITS.indexOf(digit)));

export const isOccurrenceExamType = (value: string): value is OccurrenceExamType =>
  (OCCURRENCE_EXAM_TYPES as readonly string[]).includes(value);

export const isQuestionSourceType = (value: string): value is QuestionSourceType =>
  (QUESTION_SOURCE_TYPES as readonly string[]).includes(value);

export const isPreparationTrackId = (value: string): value is PreparationTrackId =>
  (PREPARATION_TRACK_IDS as readonly string[]).includes(value);

export const referenceKindForExamType = (examType: OccurrenceExamType): string =>
  EXAM_TYPE_REFERENCE_KIND[examType];

/** Legacy `source_kind` -> occurrence `exam_type`, or null for book references. */
export const examTypeForReferenceKind = (kind: string | null | undefined): OccurrenceExamType | null => {
  if (!kind) return null;
  return REFERENCE_KIND_EXAM_TYPE[kind.toLowerCase()] ?? null;
};

/**
 * The source assumed for a question that only declared an exam type: a real
 * past exam always came from its published paper. An explicit source wins.
 */
export const DEFAULT_SOURCE_FOR_OCCURRENCE: QuestionSourceType = 'official_paper';

/**
 * `questions.source_type` is still read by the student Question Bank badges and
 * its HSC/admission filter, so it keeps the old vocabulary while the real
 * source lives in `question_sources`.
 */
export const legacySourceTypeFor = (params: {
  examType?: OccurrenceExamType | null;
  sourceType?: string | null;
}): string => {
  if (params.examType) return params.examType;
  const source = (params.sourceType ?? '').trim().toLowerCase();
  if ((LEGACY_QUESTION_SOURCE_TYPES as readonly string[]).includes(source)) return source;
  return 'unknown';
};

export interface ParsedExamPeriod {
  exam_year: number | null;
  exam_year_label: string;
}

export type ExamPeriodResult =
  | { ok: true; period: ParsedExamPeriod }
  | { ok: false; error: string };

/**
 * Reads `@year`.
 *
 * `2022` fills both the integer and its label; `2025-26` fills only the label,
 * because an admission session spans two calendar years and the existing data
 * convention stores `exam_year = NULL` for admission. The second half of a
 * range must be the year after the first.
 */
export const parseExamPeriod = (raw: string, examType: OccurrenceExamType): ExamPeriodResult => {
  const value = toEnglishDigits(raw).trim().replace(/\s+/g, '');
  if (!value) return { ok: false, error: 'year is empty.' };

  const single = /^(\d{4})$/.exec(value);
  if (single) {
    const year = Number(single[1]);
    if (year < 1990 || year > 2100) {
      return { ok: false, error: `year "${raw}" must be between 1990 and 2100.` };
    }
    return {
      ok: true,
      period:
        examType === 'admission'
          ? { exam_year: null, exam_year_label: String(year) }
          : { exam_year: year, exam_year_label: String(year) },
    };
  }

  const range = /^(\d{4})-(\d{2})$/.exec(value);
  if (range) {
    const start = Number(range[1]);
    if (start < 1990 || start > 2100) {
      return { ok: false, error: `session "${raw}" must start between 1990 and 2100.` };
    }
    if (Number(range[2]) !== (start + 1) % 100) {
      return {
        ok: false,
        error: `session "${raw}" is not a two-year span; the part after the dash must be ${
          (start + 1) % 100
        }.`,
      };
    }
    return { ok: true, period: { exam_year: null, exam_year_label: `${start}-${range[2]}` } };
  }

  return {
    ok: false,
    error: `year "${raw}" must be a 4-digit year (2022) or a session range (2025-26).`,
  };
};

/** One occurrence as the importer will write it, ids already resolved. */
export interface ResolvedOccurrence {
  exam_type: OccurrenceExamType;
  institution_id: string | null;
  admission_unit_id: string | null;
  exam_name: string | null;
  exam_year: number | null;
  exam_year_label: string | null;
  exam_session: string | null;
  paper_set: string | null;
  shift: string | null;
  question_number: number | null;
  source_label: string | null;
  source_page: string | null;
}

/**
 * One legacy `exam_references` entry, built from an occurrence.
 *
 * The student RPCs still read this jsonb for badges and for the institution and
 * year filters, so it is rebuilt from the occurrence rows by this one function
 * after any occurrence write, never hand-built per code path.
 */
export const occurrenceToExamReference = (
  occurrence: ResolvedOccurrence,
  institution: InstitutionRecord | undefined,
  unit: AdmissionUnitRecord | undefined
): Record<string, unknown> => {
  const kind = referenceKindForExamType(occurrence.exam_type);
  const institutionName =
    (institution?.name_en || institution?.name_bn || '').trim() || null;
  const code = (institution?.code ?? '').trim() || null;
  const eiin = (institution?.eiin ?? '').trim() || code;
  const year =
    occurrence.exam_year_label ??
    (occurrence.exam_year === null ? null : String(occurrence.exam_year));
  const unitName = (unit?.name_en || unit?.name_bn || '').trim() || null;

  return {
    source_kind: kind,
    ...(kind === 'board'
      ? { board: institutionName }
      : { institution_name: institutionName }),
    ...(code ? { code } : {}),
    ...(eiin ? { eiin } : {}),
    ...(year ? { year } : {}),
    ...(occurrence.institution_id ? { institution_id: occurrence.institution_id } : {}),
    ...(occurrence.admission_unit_id ? { unit_id: occurrence.admission_unit_id } : {}),
    ...(unitName ? { unit_name: unitName } : {}),
    ...(occurrence.exam_name ? { exam_name: occurrence.exam_name } : {}),
  };
};

/** Rebuilds the whole legacy jsonb for one question from its occurrence rows. */
export const buildExamReferences = (params: {
  occurrences: ResolvedOccurrence[];
  institutions: Map<string, InstitutionRecord>;
  units: Map<string, AdmissionUnitRecord>;
}): Record<string, unknown>[] =>
  params.occurrences.flatMap((occurrence) => {
    const institutionId = occurrence.institution_id;
    if (institutionId === null) return [];

    return [
      occurrenceToExamReference(
        occurrence,
        params.institutions.get(institutionId),
        occurrence.admission_unit_id ? params.units.get(occurrence.admission_unit_id) : undefined
      ),
    ];
  });

/** What the plain-text parser and the admin panel each submit for one question. */
export interface QuestionMappingInput {
  source?: {
    source_type: string;
    source_label?: string | null;
    publisher?: string | null;
    edition?: string | null;
    page_number?: string | null;
    url?: string | null;
  } | null;
  occurrence?: {
    exam_type: string;
    institution?: string | null;
    institution_id?: string | null;
    unit?: string | null;
    admission_unit_id?: string | null;
    exam_name?: string | null;
    year?: string | null;
    session?: string | null;
    shift?: string | null;
    paper_set?: string | null;
    question_number?: number | string | null;
    source_label?: string | null;
    source_page?: string | null;
  } | null;
  tracks?: string[] | null;
}
