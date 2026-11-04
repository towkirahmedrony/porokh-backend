/**
 * Validation and normalisation for `questions.exam_references`.
 *
 * The column is JSONB and already holds a mix of legacy shapes, so the rules
 * here are additive: known keys are validated and canonicalised, unknown keys
 * and non-object legacy entries are preserved exactly as stored. Institution
 * and unit ids are checked against the live `institutions` / `admission_units`
 * tables; this module never invents ids.
 */

export const REFERENCE_SOURCE_KINDS = [
  'board',
  'college',
  'university',
  'school',
  'admission',
  'book',
  'unknown',
] as const;

export type ReferenceSourceKind = (typeof REFERENCE_SOURCE_KINDS)[number];

export interface InstitutionRecord {
  id: string;
  name_bn?: string | null;
  name_en?: string | null;
  short_name?: string | null;
  type?: string | null;
  code?: string | null;
  eiin?: string | null;
  aliases?: string[] | null;
  is_active?: boolean | null;
}

export interface AdmissionUnitRecord {
  id: string;
  institution_id: string;
  name_bn?: string | null;
  name_en?: string | null;
  code?: string | null;
  is_active?: boolean | null;
}

export interface ReferenceLookups {
  institutions: Map<string, InstitutionRecord>;
  units: Map<string, AdmissionUnitRecord>;
}

export class ExamReferenceValidationError extends Error {
  status = 400;
  errorCode = 'EXAM_REFERENCE_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'ExamReferenceValidationError';
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const UNIT_KINDS = new Set<string>(['admission', 'college', 'university', 'unknown']);

const KIND_ALLOWED_INSTITUTION_TYPES: Record<string, string[]> = {
  board: ['board'],
  college: ['college'],
  school: ['school'],
  university: ['university'],
  admission: ['university', 'college'],
};

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asTrimmedString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
};

export const normalizeReferenceSourceKind = (
  value: unknown
): ReferenceSourceKind | string | null => {
  if (typeof value !== 'string') return null;

  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!key) return null;

  if (key === 'madrasa' || key === 'madrasah') return 'board';
  if (key === 'school_and_college') return 'school';

  return key;
};

export const referenceKindSupportsUnit = (kind: string | null): boolean =>
  kind === null || UNIT_KINDS.has(kind);

export const readId = (value: unknown, field: string): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new ExamReferenceValidationError(`${field} must be a UUID string or null`);
  }

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (!UUID_PATTERN.test(trimmed)) {
    throw new ExamReferenceValidationError(`${field} must be a valid UUID`);
  }

  return trimmed;
};

const NAME_STOPWORDS = new Set(['of', 'the', 'and', 'for', 'at', 'in', 'on']);

/**
 * Comparison keys for legacy free-text names. Board labels in old rows are
 * short ("Dhaka Board") while the institution table stores the full name, and
 * university labels swap word order ("Dhaka University" vs "University of
 * Dhaka"), so exact string equality alone misses most existing references.
 */
export const referenceNameVariants = (value: string, kind: string | null): string[] => {
  const raw = value.trim().toLowerCase();
  if (!raw) return [];

  const variants = new Set<string>([raw]);

  if (kind === 'board') {
    const commaPart = raw.split(',').pop()?.trim().replace(/\s+/g, ' ');
    if (commaPart && commaPart !== raw) variants.add(commaPart);
    if (raw.endsWith(' board')) variants.add(raw.slice(0, -' board'.length).trim());
  }

  const tokens = raw
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token && !NAME_STOPWORDS.has(token))
    .sort();

  if (tokens.length > 0) variants.add(tokens.join(' '));

  return Array.from(variants).filter(Boolean);
};

export const referenceKindMatchesInstitutionType = (
  kind: string | null,
  type: string | null | undefined
): boolean => {
  if (!kind) return true;

  const allowed = KIND_ALLOWED_INSTITUTION_TYPES[kind];
  if (!allowed) return true;

  return typeof type === 'string' && allowed.includes(type);
};

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const toEnglishDigits = (value: string): string =>
  value.replace(/[০-৯]/g, (digit) => String(BN_DIGITS.indexOf(digit)));

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

export type AdmissionUnitMatch =
  | { status: 'matched'; unit: AdmissionUnitRecord }
  | { status: 'ambiguous'; candidates: AdmissionUnitRecord[] }
  | { status: 'not_found'; available: string[] };

const unitLabel = (unit: AdmissionUnitRecord): string =>
  unit.name_en || unit.name_bn || unit.id;

/** Matches a printed unit label against the units of one institution. */
export const matchAdmissionUnit = (
  input: string,
  units: AdmissionUnitRecord[]
): AdmissionUnitMatch => {
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

const assertKindMatchesInstitution = (
  kind: string | null,
  institution: InstitutionRecord
): void => {
  if (!kind) return;

  if (!referenceKindMatchesInstitutionType(kind, institution.type)) {
    throw new ExamReferenceValidationError(
      `Institution "${institution.name_en || institution.name_bn || institution.id}" is not a valid ${kind} reference`
    );
  }
};

const preferredInstitutionName = (institution: InstitutionRecord): string =>
  asTrimmedString(institution.name_en) || asTrimmedString(institution.name_bn);

const preferredUnitName = (unit: AdmissionUnitRecord): string =>
  asTrimmedString(unit.name_en) || asTrimmedString(unit.name_bn);

const fillInstitutionIdentifiers = (
  reference: Record<string, unknown>,
  institution: InstitutionRecord,
  kind: string | null
): void => {
  if (!asTrimmedString(reference.institution_id)) {
    reference.institution_id = institution.id;
  }

  const name = preferredInstitutionName(institution);
  if (kind === 'board') {
    if (!asTrimmedString(reference.board) && name) reference.board = name;
  } else if (!asTrimmedString(reference.institution_name) && name) {
    reference.institution_name = name;
  }

  const code = asTrimmedString(institution.code);
  if (!asTrimmedString(reference.code) && code) reference.code = code;

  const eiin = asTrimmedString(institution.eiin) || code;
  if (!asTrimmedString(reference.eiin) && eiin) reference.eiin = eiin;
};

/**
 * Validates one stored reference object against the resolved database rows.
 * Unknown keys are copied through untouched.
 */
export const normalizeExamReference = (
  input: Record<string, unknown>,
  lookups: ReferenceLookups
): Record<string, unknown> => {
  const reference: Record<string, unknown> = { ...input };
  const kind = normalizeReferenceSourceKind(reference.source_kind);
  if (kind) reference.source_kind = kind;

  // Group classification is retired; old payloads may still send it.
  delete reference.unit_group;

  const institutionId = readId(reference.institution_id, 'institution_id');
  const unitId = readId(reference.unit_id, 'unit_id');

  let institution = institutionId ? lookups.institutions.get(institutionId) : undefined;
  if (institutionId && !institution) {
    throw new ExamReferenceValidationError('institution_id does not match an existing institution');
  }

  if (institution) {
    assertKindMatchesInstitution(kind, institution);
    fillInstitutionIdentifiers(reference, institution, kind);
  }

  if (unitId) {
    if (!referenceKindSupportsUnit(kind)) {
      throw new ExamReferenceValidationError(
        'Admission units are only valid for admission, college or university references'
      );
    }

    const unit = lookups.units.get(unitId);
    if (!unit) {
      throw new ExamReferenceValidationError('unit_id does not match an existing admission unit');
    }

    if (institutionId && unit.institution_id !== institutionId) {
      throw new ExamReferenceValidationError(
        'The selected admission unit does not belong to the selected institution'
      );
    }

    if (!institutionId) reference.institution_id = unit.institution_id;
    institution = lookups.institutions.get(unit.institution_id);

    if (!institution) {
      throw new ExamReferenceValidationError(
        'The admission unit is not linked to an existing institution'
      );
    }

    assertKindMatchesInstitution(kind, institution);
    fillInstitutionIdentifiers(reference, institution, kind);

    const unitName = preferredUnitName(unit);
    if (!asTrimmedString(reference.unit_name) && unitName) {
      reference.unit_name = unitName;
    }
  } else if (institutionId && asTrimmedString(reference.unit_name)) {
    const units = Array.from(lookups.units.values()).filter(
      (unit) => unit.institution_id === institutionId
    );
    const matched = matchAdmissionUnit(asTrimmedString(reference.unit_name), units);

    if (matched.status === 'matched') {
      reference.unit_id = matched.unit.id;
      const unitName = preferredUnitName(matched.unit);
      if (unitName) reference.unit_name = unitName;
    }
  } else if ('unit_id' in reference) {
    reference.unit_id = null;
    if (reference.unit_name === undefined || reference.unit_name === '') {
      reference.unit_name = null;
    }
  }

  return reference;
};

export const parseReferenceList = (input: unknown): unknown[] | null | undefined => {
  if (input === undefined) return undefined;
  if (input === null || input === '') return null;

  if (typeof input === 'string') {
    try {
      return parseReferenceList(JSON.parse(input));
    } catch {
      throw new ExamReferenceValidationError(
        'exam_references must be valid JSON or an array of reference objects'
      );
    }
  }

  if (Array.isArray(input)) return input;
  if (asRecord(input)) return [input];

  throw new ExamReferenceValidationError(
    'exam_references must be an array of reference objects, an object, null or empty'
  );
};
