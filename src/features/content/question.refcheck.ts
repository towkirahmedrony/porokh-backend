import {
  matchAdmissionUnit,
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
  | 'institution_required'
  | 'unit_required'
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

/** Institution row including the stored alternative names (institutions.aliases). */
export type InstitutionWithAliases = InstitutionRecord & { aliases?: string[] | null };

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

/** Every stored name of an institution: both names, the short name and all aliases. */
const institutionNames = (row: InstitutionWithAliases): string[] =>
  [row.name_bn, row.name_en, row.short_name, ...(row.aliases ?? [])].filter(
    (value): value is string => typeof value === 'string' && value.trim() !== ''
  );

const institutionLabel = (row: InstitutionRecord): string => {
  const name = row.name_en || row.name_bn || row.id;
  return row.short_name ? `${name} (${row.short_name})` : name;
};

const unitLabel = (unit: AdmissionUnitRecord): string => unit.name_en || unit.name_bn || unit.id;

const unitInfo = (unit: AdmissionUnitRecord) => ({
  id: unit.id,
  name_en: unit.name_en ?? null,
  name_bn: unit.name_bn ?? null,
});

type InstitutionMatch =
  | { status: 'matched'; institution: InstitutionWithAliases; matchedByAlias: boolean }
  | { status: 'ambiguous'; candidates: InstitutionWithAliases[] }
  | { status: 'not_found'; suggestions: string[] };

export const matchInstitution = (
  input: string,
  kind: string | null,
  rows: InstitutionWithAliases[]
): InstitutionMatch => {
  const needle = input.trim();
  const code = needle.toLowerCase();
  const inputVariants = new Set(referenceNameVariants(needle, kind));
  const eligible = rows.filter((row) => referenceKindMatchesInstitutionType(kind, row.type));

  const sharesVariant = (value: string): boolean =>
    referenceNameVariants(value, kind).some((variant) => inputVariants.has(variant));

  // Code/EIIN and the official names (both languages, short name) are the
  // primary identity; `aliases` are stored alternative names and misspellings.
  const matchesOfficially = (row: InstitutionWithAliases): boolean =>
    (code !== '' && (lower(row.code) === code || lower(row.eiin) === code)) ||
    [row.name_bn, row.name_en, row.short_name].some(
      (value) => typeof value === 'string' && value.trim() !== '' && sharesVariant(value)
    );

  const matchesByAlias = (row: InstitutionWithAliases): boolean =>
    (row.aliases ?? []).some((value) => typeof value === 'string' && sharesVariant(value));

  const hits = eligible.filter((row) => matchesOfficially(row) || matchesByAlias(row));

  if (hits.length === 1) {
    return {
      status: 'matched',
      institution: hits[0],
      matchedByAlias: !matchesOfficially(hits[0]),
    };
  }
  if (hits.length > 1) return { status: 'ambiguous', candidates: hits };

  const wanted = new Set(tokens(needle));
  const suggestions = eligible
    .map((row) => ({
      row,
      score: Math.max(
        ...institutionNames(row).map((value) => jaccard(wanted, new Set(tokens(value)))),
        0
      ),
    }))
    .filter((entry) => entry.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => institutionLabel(entry.row));

  return { status: 'not_found', suggestions };
};

export const matchUnit = matchAdmissionUnit;

interface Resolved {
  check: ReferenceCheck;
  link: Record<string, string>;
}

const resolveReference = (
  reference: Record<string, string>,
  institutions: InstitutionWithAliases[],
  unitsByInstitution: Map<string, AdmissionUnitRecord[]>
): Resolved => {
  const institutionInput = reference.institution_name ?? '';
  const unitInput = reference.unit_name;
  const admission = reference.source_kind === 'admission';
  const base = {
    institution_input: institutionInput,
    ...(unitInput ? { unit_input: unitInput } : {}),
    questions: 0,
  };

  if (!institutionInput) {
    return {
      link: {},
      check: {
        ...base,
        status: admission ? 'institution_required' : 'institution_not_found',
        message: admission
          ? 'Admission references need an institution name.'
          : 'The reference has no institution name; it will be saved as typed (not linked).',
      },
    };
  }

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

  const units = unitsByInstitution.get(institution.id) ?? [];
  const where = institutionLabel(institution);
  const via = found.matchedByAlias ? ' (matched by alternative name)' : '';

  const linkUnit = (unit: AdmissionUnitRecord): Resolved => {
    link.unit_id = unit.id;
    link.unit_name = unit.name_en || unit.name_bn || unitInput || '';
    return {
      link,
      check: {
        ...base,
        status: 'ok',
        message: `Linked to ${where}, ${unitLabel(unit)}${via}.`,
        institution: institutionInfo,
        unit: unitInfo(unit),
      },
    };
  };

  const withoutUnit = (
    status: ReferenceCheckStatus,
    message: string,
    suggestions: string[]
  ): Resolved => ({
    link,
    check: {
      ...base,
      status,
      message,
      institution: institutionInfo,
      ...(suggestions.length > 0 ? { suggestions } : {}),
    },
  });

  // An admission unit must be named; no unit is ever inferred from a group.
  if (unitInput) {
    const unitResult = matchUnit(unitInput, units);

    if (unitResult.status === 'matched') return linkUnit(unitResult.unit);

    if (unitResult.status === 'ambiguous') {
      return withoutUnit(
        'unit_ambiguous',
        `Unit "${unitInput}" matches several units of ${where}; it is kept as text only.`,
        unitResult.candidates.map(unitLabel)
      );
    }

    return withoutUnit(
      'unit_not_found',
      unitResult.available.length === 0
        ? `${where} has no admission units in the database, so "${unitInput}" is kept as text only.`
        : `Unit "${unitInput}" was not found for ${where}; it is kept as text only.`,
      unitResult.available
    );
  }

  if (admission) {
    return withoutUnit(
      'unit_required',
      units.length === 0
        ? `${where} has no admission units in the database; add the unit first.`
        : `${where} needs an admission unit; add @unit (e.g. @unit: A).`,
      units.map(unitLabel)
    );
  }

  return {
    link,
    check: {
      ...base,
      status: 'ok',
      message: `Linked to ${where}${via}.`,
      institution: institutionInfo,
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
  institutions: InstitutionWithAliases[],
  unitsByInstitution: Map<string, AdmissionUnitRecord[]>
): ReferenceCheck[] => {
  const resolvedByKey = new Map<string, Resolved>();

  for (const question of questions) {
    for (const reference of question.exam_references) {
      delete reference.unit_group;

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
