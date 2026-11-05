/**
 * Preparation Category is a placement, not question content: one master
 * question can belong to the HSC bank, the Admission bank, or both.
 *
 * The database stores the placement as rows in `question_preparation_tracks`.
 * Callers submit one of three canonical values; `both` maps to two rows.
 */

export const PREPARATION_CATEGORIES = ['hsc', 'admission', 'both'] as const;

export type PreparationCategory = (typeof PREPARATION_CATEGORIES)[number];

/** Tracks this feature owns. Other tracks (engineering, medical) are preserved. */
export const PREPARATION_TRACK_IDS = ['hsc', 'admission'] as const;

export class PreparationCategoryValidationError extends Error {
  status = 400;
  errorCode = 'VALIDATION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'PreparationCategoryValidationError';
  }
}

const BOTH_ALIASES = new Set([
  'hsc+admission',
  'admission+hsc',
  'hsc,admission',
  'admission,hsc',
  'hsc admission',
  'admission hsc',
  'hsc_admission',
  'admission_hsc',
  'hsc & admission',
  'admission & hsc',
  'hsc and admission',
  'admission and hsc',
]);

export interface ParsedPreparationCategory {
  /** False when the request did not mention the field at all. */
  present: boolean;
  /** Null means "no HSC or Admission placement". */
  category: PreparationCategory | null;
  error?: string;
}

/**
 * Reads one submitted value.
 *
 * `null`, an empty string and `none` clear the category. Absent means the
 * caller did not ask to change it, which matters for partial updates.
 */
export const parsePreparationCategory = (value: unknown): ParsedPreparationCategory => {
  if (value === undefined) return { present: false, category: null };

  if (value === null) return { present: true, category: null };

  const raw =
    typeof value === 'string'
      ? value
          .trim()
          .toLowerCase()
          .replace(/\s*\+\s*/g, '+')
          .replace(/\s+/g, ' ')
      : '';

  if (raw === '' || raw === 'none') return { present: true, category: null };

  if (raw === 'hsc' || raw === 'admission') {
    return { present: true, category: raw };
  }

  if (raw === 'both' || BOTH_ALIASES.has(raw)) {
    return { present: true, category: 'both' };
  }

  return {
    present: true,
    category: null,
    error: 'preparation_category must be hsc, admission, both, or empty.',
  };
};

export const assertPreparationCategory = (value: unknown): ParsedPreparationCategory => {
  const parsed = parsePreparationCategory(value);
  if (parsed.error) throw new PreparationCategoryValidationError(parsed.error);
  return parsed;
};

/** Track ids to write for a category; `none` clears only the owned tracks. */
export const trackIdsForCategory = (category: PreparationCategory | null): string[] => {
  if (category === 'both') return ['hsc', 'admission'];
  return category ? [category] : [];
};

/** Reads the category back from the tracks present on a question. */
export const categoryFromTrackIds = (trackIds: readonly string[]): PreparationCategory | null => {
  const hasHsc = trackIds.includes('hsc');
  const hasAdmission = trackIds.includes('admission');

  if (hasHsc && hasAdmission) return 'both';
  if (hasHsc) return 'hsc';
  if (hasAdmission) return 'admission';
  return null;
};
