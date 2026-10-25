export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Mirrors the database CHECK on study_groups.slug (3-40 chars, no edge dash). */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

export const isUuid = (value: unknown): boolean =>
  typeof value === 'string' && UUID_PATTERN.test(value);

export const normalizeSlug = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase();

export const isValidSlug = (value: unknown): boolean =>
  SLUG_PATTERN.test(normalizeSlug(value));

/** Deterministic suggestion used by the create form; the DB adds a suffix when omitted. */
export const slugifyName = (value: unknown): string =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');

export const OFFENSE_TYPES = ['Profanity', 'Spam', 'Harassment', 'Other'] as const;
export type OffenseType = (typeof OFFENSE_TYPES)[number];

export const isOffenseType = (value: unknown): value is OffenseType =>
  typeof value === 'string' && (OFFENSE_TYPES as readonly string[]).includes(value);

export const MAX_REPORT_REASON_LENGTH = 200;

export const normalizeReportReason = (value: unknown): string =>
  String(value ?? '').trim().slice(0, MAX_REPORT_REASON_LENGTH);
