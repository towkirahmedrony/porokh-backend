import { supabase } from '../../config/supabase';
import type { AdmissionUnitRecord, InstitutionRecord } from './exam-references.core';
import { matchAdmissionUnit, referenceKindMatchesInstitutionType } from './exam-references.core';
import { matchInstitution, type InstitutionWithAliases } from './question.refcheck';
import {
  examTypeForReferenceKind,
  isOccurrenceExamType,
  isPreparationTrackId,
  isQuestionSourceType,
  legacySourceTypeFor,
  parseExamPeriod,
  referenceKindForExamType,
  type OccurrenceExamType,
  type QuestionMappingInput,
  type ResolvedOccurrence,
} from './question.mapping';

/**
 * Resolution of one question's source, past-exam occurrence and tracks.
 *
 * Matching reuses the preview's own rules (`matchInstitution`), so a name that
 * the preview says "Linked" can never be rejected by the import: aliases,
 * short names, codes, EIINs and word-order variants all resolve the same way.
 */

export interface MappingLookups {
  institutions: InstitutionWithAliases[];
  unitsByInstitution: Map<string, AdmissionUnitRecord[]>;
}

export interface ResolvedSource {
  source_type: string;
  source_label: string | null;
  publisher: string | null;
  edition: string | null;
  page_number: string | null;
  url: string | null;
}

export interface ResolvedMapping {
  source: ResolvedSource | null;
  occurrence: ResolvedOccurrence | null;
  tracks: string[];
  /** `questions.source_type`, kept populated for the student RPCs. */
  legacy_source_type: string;
  warnings: string[];
}

export type MappingResult =
  | { ok: true; mapping: ResolvedMapping }
  | { ok: false; errors: string[] };

/** A few hundred rows, so no cache is needed and edits show up immediately. */
export const loadMappingLookups = async (): Promise<MappingLookups> => {
  const [institutionResult, unitResult] = await Promise.all([
    supabase.from('institutions').select('*').eq('is_active', true).limit(5000),
    supabase.from('admission_units').select('*').eq('is_active', true).limit(5000),
  ]);

  if (institutionResult.error) throw new Error(institutionResult.error.message);
  if (unitResult.error) throw new Error(unitResult.error.message);

  const unitsByInstitution = new Map<string, AdmissionUnitRecord[]>();
  for (const unit of (unitResult.data ?? []) as unknown as AdmissionUnitRecord[]) {
    const list = unitsByInstitution.get(unit.institution_id) ?? [];
    list.push(unit);
    unitsByInstitution.set(unit.institution_id, list);
  }

  return {
    institutions: (institutionResult.data ?? []) as unknown as InstitutionWithAliases[],
    unitsByInstitution,
  };
};

/** Lookups for institutions and units already known by id (legacy reference path). */
export const loadLookupsByIds = async (
  institutionIds: string[],
  unitIds: string[]
): Promise<MappingLookups> => {
  const institutions: InstitutionWithAliases[] = [];
  const unitsByInstitution = new Map<string, AdmissionUnitRecord[]>();

  if (institutionIds.length > 0) {
    const { data, error } = await supabase
      .from('institutions')
      .select('*')
      .in('id', Array.from(new Set(institutionIds)));
    if (error) throw new Error(error.message);
    institutions.push(...((data ?? []) as unknown as InstitutionWithAliases[]));
  }

  if (unitIds.length > 0) {
    const { data, error } = await supabase
      .from('admission_units')
      .select('*')
      .in('id', Array.from(new Set(unitIds)));
    if (error) throw new Error(error.message);

    for (const unit of (data ?? []) as unknown as AdmissionUnitRecord[]) {
      const list = unitsByInstitution.get(unit.institution_id) ?? [];
      if (!unitsByInstitution.has(unit.institution_id)) {
        unitsByInstitution.set(unit.institution_id, list);
      }
      list.push(unit);
    }
  }

  return { institutions, unitsByInstitution };
};

const institutionLabel = (row: InstitutionRecord): string => {
  const name = row.name_en || row.name_bn || row.id;
  return row.short_name ? `${name} (${row.short_name})` : name;
};

const unitLabel = (unit: AdmissionUnitRecord): string => unit.name_en || unit.name_bn || unit.id;

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

const resolveSource = (input: QuestionMappingInput['source']): ResolvedSource | null => {
  if (!input) return null;

  const sourceType = text(input.source_type).toLowerCase();
  return {
    source_type: sourceType,
    source_label: text(input.source_label) || null,
    publisher: text(input.publisher) || null,
    edition: text(input.edition) || null,
    page_number: text(input.page_number) || null,
    url: text(input.url) || null,
  };
};

const resolveOccurrence = (
  input: NonNullable<QuestionMappingInput['occurrence']>,
  lookups: MappingLookups,
  errors: string[]
): ResolvedOccurrence | null => {
  const examTypeInput = text(input.exam_type).toLowerCase();

  if (!isOccurrenceExamType(examTypeInput)) {
    errors.push(
      `@exam_type "${examTypeInput}" is not supported. Use board_exam, admission, college_test, school_exam or university_exam — or leave it out for a question that never appeared in a real exam.`
    );
    return null;
  }

  const examType: OccurrenceExamType = examTypeInput;
  const kind = referenceKindForExamType(examType);

  // Institution: by id when the caller already resolved it, by name otherwise.
  let institution = null as InstitutionWithAliases | null;

  const institutionId = text(input.institution_id);
  if (institutionId) {
    institution = lookups.institutions.find((row) => row.id === institutionId) ?? null;
    if (!institution) errors.push(`institution_id ${institutionId} does not match an active institution.`);
  } else {
    const name = text(input.institution);
    if (!name) {
      // A college test is identified by its year; every other exam type needs
      // the institution that held it.
      if (examType !== 'college_test') {
        errors.push(`${examType.replace('_', ' ')} questions need @institution.`);
      }
    } else {
      const found = matchInstitution(name, kind, lookups.institutions);

      if (found.status === 'matched') {
        institution = found.institution;
      } else if (found.status === 'ambiguous') {
        errors.push(
          `@institution "${name}" matches ${found.candidates.length} institutions: ${found.candidates
            .map(institutionLabel)
            .join('; ')}. Use the full official name.`
        );
      } else {
        errors.push(
          found.suggestions.length > 0
            ? `@institution "${name}" did not match any institution. Did you mean: ${found.suggestions.join('; ')}?`
            : `@institution "${name}" did not match any institution.`
        );
      }
    }
  }

  if (institution && !referenceKindMatchesInstitutionType(kind, institution.type)) {
    errors.push(
      `@institution ${institutionLabel(institution)} is a ${institution.type} institution, which cannot host a ${examType.replace('_', ' ')}.`
    );
    institution = null;
  }

  if (!institution && examType !== 'college_test') return null;

  // Unit: only inside the resolved institution, so a valid-looking code for a
  // different university is reported instead of linked.
  let unit: AdmissionUnitRecord | null = null;
  const unitId = text(input.admission_unit_id);
  const unitInput = text(input.unit);
  const units = institution ? lookups.unitsByInstitution.get(institution.id) ?? [] : [];

  if (unitId) {
    unit = units.find((entry) => entry.id === unitId) ?? null;
    if (!unit) {
      errors.push(
        `The selected admission unit does not belong to ${institution ? institutionLabel(institution) : 'the chosen institution'}.`
      );
    }
  } else if (unitInput) {
    if (!institution) {
      errors.push('@unit was given without an institution, so it cannot be matched.');
    } else {
      const matched = matchAdmissionUnit(unitInput, units);
      if (matched.status === 'matched') {
        unit = matched.unit;
      } else if (matched.status === 'ambiguous') {
        errors.push(
          `@unit "${unitInput}" matches several units of ${institutionLabel(institution)}: ${matched.candidates
            .map(unitLabel)
            .join('; ')}.`
        );
      } else {
        errors.push(
          matched.available.length > 0
            ? `@unit "${unitInput}" was not found for ${institutionLabel(institution)}. Valid units: ${matched.available.join('; ')}.`
            : `${institutionLabel(institution)} has no admission units in the database, so "${unitInput}" cannot be linked.`
        );
      }
    }
  } else if (examType === 'admission') {
    errors.push(
      units.length > 0
        ? `${institution ? institutionLabel(institution) : 'This university'} needs an admission unit; add @unit (e.g. @unit: A). Valid units: ${units
            .map(unitLabel)
            .join('; ')}.`
        : 'Admission questions need an admission unit, but this institution has no units in the database.'
    );
  }

  // Year: required for the exam types where the year is the identity.
  const yearRaw = text(input.year) || text(input.session);
  let examYear: number | null = null;
  let examYearLabel: string | null = null;

  if (yearRaw) {
    const parsed = parseExamPeriod(yearRaw, examType);
    if (!parsed.ok) {
      errors.push(parsed.error);
    } else {
      examYear = parsed.period.exam_year;
      examYearLabel = parsed.period.exam_year_label;
    }
  } else if (examType !== 'admission' && (examType === 'board_exam' || examType === 'college_test')) {
    errors.push(`${examType.replace('_', ' ')} questions need @year.`);
  } else if (examType === 'admission') {
    errors.push('Admission questions need a session label such as @year: 2025-26.');
  }

  const questionNumberRaw = text(input.question_number);
  let questionNumber: number | null = null;
  if (questionNumberRaw) {
    const parsed = Number(questionNumberRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      errors.push(`@qno "${questionNumberRaw}" must be a positive whole number.`);
    } else {
      questionNumber = parsed;
    }
  }

  if (errors.length > 0) return null;

  return {
    exam_type: examType,
    institution_id: institution?.id ?? null,
    admission_unit_id: unit?.id ?? null,
    exam_name: text(input.exam_name) || null,
    exam_year: examYear,
    exam_year_label: examYearLabel,
    exam_session: text(input.session) || null,
    paper_set: text(input.paper_set) || null,
    shift: text(input.shift) || null,
    question_number: questionNumber,
    source_label: text(input.source_label) || null,
    source_page: text(input.source_page) || null,
  };
};

/**
 * Turns a submitted mapping into the exact rows to write.
 *
 * Every problem is collected so one question reports all of its issues, and a
 * question without `occurrence` is a guidebook/model-test question: it gets a
 * source and tracks but no occurrence row.
 */
export const resolveMapping = (
  input: QuestionMappingInput,
  lookups: MappingLookups,
  options: { sourceLabel?: string | null } = {}
): MappingResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  const source = resolveSource(input.source ?? null);
  if (source && !isQuestionSourceType(source.source_type)) {
    errors.push(
      `@source "${source.source_type}" is not a supported source type. Use one of ${['official_paper', 'guidebook', 'textbook', 'coaching_material', 'website', 'user_submission', 'unknown'].join(', ')}.`
    );
  }

  if (source && !source.source_type) {
    errors.push('A source needs a source type.');
  }

  const occurrence = input.occurrence
    ? resolveOccurrence(input.occurrence, lookups, errors)
    : null;

  const tracks: string[] = [];
  for (const raw of input.tracks ?? []) {
    const track = text(raw).toLowerCase();
    if (!track) continue;
    if (!isPreparationTrackId(track)) {
      errors.push(
        `@track "${track}" is not a valid track. Use one of ${['hsc', 'admission', 'varsity', 'medical', 'engineering'].join(', ')}.`
      );
      continue;
    }
    if (!tracks.includes(track)) tracks.push(track);
  }

  const effectiveSource: ResolvedSource | null = source
    ? { ...source, source_label: (source.source_label ?? text(options.sourceLabel)) || null }
    : null;

  if (!effectiveSource) {
    warnings.push('No @source was given; the source is recorded as unknown.');
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    mapping: {
      source: effectiveSource ?? {
        source_type: 'unknown',
        source_label: text(options.sourceLabel) || null,
        publisher: null,
        edition: null,
        page_number: null,
        url: null,
      },
      occurrence,
      tracks,
      legacy_source_type: legacySourceTypeFor({
        examType: occurrence?.exam_type ?? null,
        sourceType: effectiveSource?.source_type ?? null,
      }),
      warnings,
    },
  };
};

/**
 * Derives a mapping from the legacy `exam_references` jsonb of a CSV/Excel or
 * preview payload, so those paths get sources and occurrences too without the
 * client learning a new format. Returns null when the payload has neither form.
 */
export const mappingFromLegacyReferences = (
  references: unknown,
  sourceType: unknown
): QuestionMappingInput | null => {
  const list = Array.isArray(references) ? references : [];
  const source = text(sourceType).toLowerCase();

  if (list.length === 0) {
    if (!source) return null;
    return { source: { source_type: sourceTypeForLegacy(source) }, occurrence: null, tracks: null };
  }

  const reference = (list[0] ?? {}) as Record<string, unknown>;
  const examType = examTypeForLegacy(source, reference);

  return {
    source: { source_type: sourceTypeForLegacy(source) },
    occurrence: examType
      ? {
          exam_type: examType,
          institution_id: text(reference.institution_id) || null,
          institution: text(reference.institution_name) || text(reference.board) || null,
          admission_unit_id: text(reference.unit_id) || null,
          unit: text(reference.unit_name) || null,
          exam_name: text(reference.exam_name) || null,
          year: text(reference.year) || null,
        }
      : null,
    tracks: null,
  };
};

const sourceTypeForLegacy = (source: string): string => {
  if (source === 'guidebook' || source === 'textbook') return source;
  return 'unknown';
};

const examTypeForLegacy = (
  source: string,
  reference: Record<string, unknown>
): OccurrenceExamType | null => {
  const byKind = examTypeForReferenceKind(text(reference.source_kind));
  if (byKind) return byKind;

  const bySource: Record<string, OccurrenceExamType> = {
    board_exam: 'board_exam',
    admission: 'admission',
    college_test: 'college_test',
    school_exam: 'school_exam',
    university_exam: 'university_exam',
  };

  return bySource[source] ?? null;
};
