import {
  referenceKindMatchesInstitutionType,
  referenceNameVariants,
  type AdmissionUnitRecord,
  type InstitutionRecord,
} from './exam-references.core';
import type { ParsedQuestion } from './question.textparse';

/**
 * Links the institution / admission unit written in pasted text to the real
 * database rows, so a mistyped or differently spelled name is reported before
 * the import instead of silently producing an unlinked reference.
 *
 * Pure: the caller supplies the rows. Matching reuses the importer's own name
 * rules (`referenceNameVariants`), so "Rajshahi University", "University of
 * Rajshahi", "RU" and the Bengali name all resolve to the same row.
 */

export type ReferenceCheckStatus =
  | 'ok'
  | 'institution_not_found'
  | 'institution_ambiguous'
  | 'unit_not_found'
  | 'unit_ambiguous';

export interface ReferenceCheck {
  institution_input: string;
  unit_input?: string;
  /** How many valid questions carry this reference. */
  questions: number;
  status: ReferenceCheckStatus;
  message: string;
  institution?: { id: string; name_en: string | null; name_bn: string | null };
  unit?: { id: string; name_en: string | null; name_bn: string | null };
  /** Closest institutions, or the institution's available units. */
  suggestions?: string[];
}

const STOPWORDS = new Set(['of', 'the', 'and', 'for', 'at', 'in', 'on']);
const GENERIC_WORDS = new Set([
  'university',
  'univ',
  'institute',
  'college',
  'বিশ্ববিদ্যালয়',
  'ইউনিভার্সিটি',
]);

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const toEnglishDigits = (value: string): string =>
  value.replace(/[০-৯]/g, (digit) => String(BN_DIGITS.indexOf(digit)));

const lower = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();

const tokens = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token && !STOPWORDS.has(token) && !GENERIC_WORDS.has(token));

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  a.forEach((token) => {
    if (b.has(token)) shared += 1;
  });
  return shared / (a.size + b.size - shared);
};

const institutionLabel = (row: InstitutionRecord): string => {
  const name = row.name_en || row.name_bn || row.id;
  return row.short_name ? `${name} (${row.short_name})` : name;
};

const unitLabel = (unit: AdmissionUnitRecord): string => unit.name_en || unit.name_bn || unit.id;

type InstitutionMatch =
  | { status: 'matched'; institution: InstitutionRecord }
  | { status: 'ambiguous'; candidates: InstitutionRecord[] }
  | { status: 'not_found'; suggestions: string[] };

export const matchInstitution = (
  input: string,
  kind: string | null,
  rows: InstitutionRecord[]
): InstitutionMatch => {
  const needle = input.trim();
  const code = needle.toLowerCase();
  const inputVariants = new Set(referenceNameVariants(needle, kind));
  const eligible = rows.filter((row) => referenceKindMatchesInstitutionType(kind, row.type));

  const hits = eligible.filter((row) => {
    if (code && (lower(row.code) === code || lower(row.eiin) === code)) return true;

    return [row.name_bn, row.name_en, row.short_name]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .some((value) =>
        referenceNameVariants(value, kind).some((variant) => inputVariants.has(variant))
      );
  });

  if (hits.length === 1) return { status: 'matched', institution: hits[0] };
  if (hits.length > 1) return { status: 'ambiguous', candidates: hits };

  const wanted = new Set(tokens(needle));
  const suggestions = eligible
    .map((row) => ({
      row,
      score: Math.max(
        ...[row.name_en, row.name_bn, row.short_name].map((value) =>
          jaccard(wanted, new Set(tokens(value ?? '')))
        ),
        0
      ),
    }))
    .filter((entry) => entry.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => institutionLabel(entry.row));

  return { status: 'not_found', suggestions };
};

/** "A Unit", "Unit A", "A" and "Unit A (Science)" all become "a". */
const unitKey = (value: string): string =>
  toEnglishDigits(value)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/sub[\s-]*unit|unit|উপ[\s-]*ইউনিট|ইউনিট/g, ' ')
    .replace(/[^\p{L}\p{M}\p{N}]/gu, '');

const plainKey = (value: string): string =>
  toEnglishDigits(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]/gu, '');

type UnitMatch =
  | { status: 'matched'; unit: AdmissionUnitRecord }
  | { status: 'ambiguous'; candidates: AdmissionUnitRecord[] }
  | { status: 'not_found'; available: string[] };

export const matchUnit = (input: string, units: AdmissionUnitRecord[]): UnitMatch => {
  const wanted = new Set([unitKey(input), plainKey(input)].filter(Boolean));

  const hits = units.filter((unit) =>
    [
      plainKey(unit.code ?? ''),
      unitKey(unit.name_en ?? ''),
      unitKey(unit.name_bn ?? ''),
      plainKey(unit.name_en ?? ''),
      plainKey(unit.name_bn ?? ''),
    ]
      .filter(Boolean)
      .some((key) => wanted.has(key))
  );

  if (hits.length === 1) return { status: 'matched', unit: hits[0] };
  if (hits.length > 1) return { status: 'ambiguous', candidates: hits };
  return { status: 'not_found', available: units.map(unitLabel) };
};

interface Resolved {
  check: ReferenceCheck;
  link: Record<string, string>;
}

const resolveReference = (
  reference: Record<string, string>,
  institutions: InstitutionRecord[],
  unitsByInstitution: Map<string, AdmissionUnitRecord[]>
): Resolved => {
  const institutionInput = reference.institution_name;
  const unitInput = reference.unit_name;
  const base = {
    institution_input: institutionInput,
    ...(unitInput ? { unit_input: unitInput } : {}),
    questions: 0,
  };

  const found = matchInstitution(institutionInput, reference.source_kind ?? null, institutions);

  if (found.status === 'ambiguous') {
    return {
      link: {},
      check: {
        ...base,
        status: 'institution_ambiguous',
        message: `"${institutionInput}" matches several institutions; use the full official name. It will be saved as typed (not linked).`,
        suggestions: found.candidates.map(institutionLabel),
      },
    };
  }

  if (found.status === 'not_found') {
    return {
      link: {},
      check: {
        ...base,
        status: 'institution_not_found',
        message: `"${institutionInput}" did not match any institution; it will be saved as typed (not linked).`,
        ...(found.suggestions.length > 0 ? { suggestions: found.suggestions } : {}),
      },
    };
  }

  const institution = found.institution;
  const link: Record<string, string> = {
    institution_id: institution.id,
    institution_name: institution.name_en || institution.name_bn || institutionInput,
  };
  const institutionInfo = {
    id: institution.id,
    name_en: institution.name_en ?? null,
    name_bn: institution.name_bn ?? null,
  };

  if (!unitInput) {
    return {
      link,
      check: {
        ...base,
        status: 'ok',
        message: `Linked to ${institutionLabel(institution)}.`,
        institution: institutionInfo,
      },
    };
  }

  const units = unitsByInstitution.get(institution.id) ?? [];
  const unitResult = matchUnit(unitInput, units);

  if (unitResult.status === 'matched') {
    const unit = unitResult.unit;
    link.unit_id = unit.id;
    link.unit_name = unit.name_en || unit.name_bn || unitInput;
    return {
      link,
      check: {
        ...base,
        status: 'ok',
        message: `Linked to ${institutionLabel(institution)}, ${unitLabel(unit)}.`,
        institution: institutionInfo,
        unit: { id: unit.id, name_en: unit.name_en ?? null, name_bn: unit.name_bn ?? null },
      },
    };
  }

  if (unitResult.status === 'ambiguous') {
    return {
      link,
      check: {
        ...base,
        status: 'unit_ambiguous',
        message: `Unit "${unitInput}" matches several units of ${institutionLabel(institution)}; it is kept as text only.`,
        institution: institutionInfo,
        suggestions: unitResult.candidates.map(unitLabel),
      },
    };
  }

  return {
    link,
    check: {
      ...base,
      status: 'unit_not_found',
      message:
        unitResult.available.length === 0
          ? `${institutionLabel(institution)} has no admission units in the database, so "${unitInput}" is kept as text only.`
          : `Unit "${unitInput}" was not found for ${institutionLabel(institution)}; it is kept as text only.`,
      institution: institutionInfo,
      ...(unitResult.available.length > 0 ? { suggestions: unitResult.available } : {}),
    },
  };
};

/**
 * Resolves every reference once per distinct (kind, institution, unit) and
 * writes the verified ids and canonical names onto the questions. References
 * that cannot be matched uniquely are left exactly as typed.
 */
export const applyReferenceChecks = (
  questions: ParsedQuestion[],
  institutions: InstitutionRecord[],
  unitsByInstitution: Map<string, AdmissionUnitRecord[]>
): ReferenceCheck[] => {
  const resolvedByKey = new Map<string, Resolved>();

  for (const question of questions) {
    for (const reference of question.exam_references) {
      if (!reference.institution_name) continue;

      const key = [
        reference.source_kind ?? '',
        lower(reference.institution_name),
        lower(reference.unit_name),
      ].join('|');

      let resolved = resolvedByKey.get(key);
      if (!resolved) {
        resolved = resolveReference(reference, institutions, unitsByInstitution);
        resolvedByKey.set(key, resolved);
      }

      resolved.check.questions += 1;
      Object.assign(reference, resolved.link);
    }
  }

  return Array.from(resolvedByKey.values()).map((entry) => entry.check);
};
