import { SearchInputError, normalizeSearchTerm } from '../../lib/utils/search';

/**
 * Query parsing and status derivation for the admin exam list.
 *
 * The list endpoint used to return every paper and the browser filtered them,
 * so the payload grew with the catalog and no filter could be validated. The
 * rules below keep the same values the exam pages already use and reject
 * anything else instead of silently showing a different set of papers.
 */

export const DEFAULT_EXAM_PAGE_SIZE = 20;
export const MAX_EXAM_PAGE_SIZE = 100;

/** Filters the list endpoint accepts, mirroring the UI's status select. */
export const EXAM_ADMIN_STATUSES = ['all', 'draft', 'scheduled', 'live', 'completed', 'open'] as const;

export const EXAM_ADMIN_SORTS = ['created_at', 'updated_at', 'start_time', 'title'] as const;

export type ExamAdminStatus = (typeof EXAM_ADMIN_STATUSES)[number];
export type ExamAdminSort = (typeof EXAM_ADMIN_SORTS)[number];

/**
 * Lifecycle state derived from the columns the student engine actually uses.
 *
 * `checkExamWindow` treats a missing start or end bound as unbounded, so a
 * published paper with no window is readable at any time. That case gets its
 * own state (`open`) instead of being reported as "live" forever.
 */
export type DerivedExamStatus = 'draft' | 'scheduled' | 'live' | 'completed' | 'open';

export interface ExamAdminListQuery {
  page: number;
  page_size: number;
  q: string;
  status: ExamAdminStatus;
  category: string;
  track: string;
  sort: ExamAdminSort;
  direction: 'asc' | 'desc';
}

export class ExamAdminQueryError extends Error {
  status = 400;
  code = 'VALIDATION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'ExamAdminQueryError';
  }
}

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const parseInteger = (
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number
): number => {
  if (value === undefined || value === null || value === '') return fallback;

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ExamAdminQueryError(`${field} must be a whole number between ${min} and ${max}`);
  }

  return parsed;
};

/**
 * Upper bound for the paper-rows read used by the overview aggregate. The
 * catalog is small next to attempts, but the read must still be bounded.
 */
export const MAX_OVERVIEW_PAPERS = 2000;

export interface ExamStatusInput {
  is_published: boolean | null;
  start_time?: unknown;
  end_time?: unknown;
}

/**
 * Maps a paper to its operator-facing status at `nowMs`.
 *
 * Draft wins over every timing rule: a draft is never shown to students no
 * matter what its window says.
 */
export const deriveExamStatus = (
  exam: ExamStatusInput,
  nowMs: number = Date.now()
): DerivedExamStatus => {
  if (exam?.is_published !== true) return 'draft';

  const start = exam.start_time ? Date.parse(String(exam.start_time)) : Number.NaN;
  const end = exam.end_time ? Date.parse(String(exam.end_time)) : Number.NaN;

  const hasStart = Number.isFinite(start);
  const hasEnd = Number.isFinite(end);

  // Same order as `checkExamWindow`: a closed window wins, then a missing start
  // bound means the paper is readable at any time.
  if (hasEnd && nowMs > end) return 'completed';
  if (!hasStart) return 'open';
  if (nowMs < start) return 'scheduled';

  return 'live';
};

export const parseExamAdminQuery = (raw: Record<string, unknown>): ExamAdminListQuery => {
  const status = (asString(raw.status) || 'all') as ExamAdminStatus;

  if (!(EXAM_ADMIN_STATUSES as readonly string[]).includes(status)) {
    throw new ExamAdminQueryError(`status must be one of ${EXAM_ADMIN_STATUSES.join(', ')}`);
  }

  const sort = (asString(raw.sort) || 'created_at') as ExamAdminSort;

  if (!(EXAM_ADMIN_SORTS as readonly string[]).includes(sort)) {
    throw new ExamAdminQueryError(`sort must be one of ${EXAM_ADMIN_SORTS.join(', ')}`);
  }

  const direction = asString(raw.direction) || 'desc';

  if (direction !== 'asc' && direction !== 'desc') {
    throw new ExamAdminQueryError('direction must be asc or desc');
  }

  let q = '';

  try {
    q = normalizeSearchTerm(raw.q);
  } catch (error) {
    if (error instanceof SearchInputError) throw new ExamAdminQueryError(error.message);
    throw error;
  }

  // Category and track are free-form in the database (legacy papers keep
  // retired values), so they are passed through as exact matches rather than
  // validated against an allowlist that would hide those rows.
  const category = asString(raw.category);
  const track = asString(raw.track);

  if (category.length > 64) throw new ExamAdminQueryError('category is too long');
  if (track.length > 64) throw new ExamAdminQueryError('track is too long');

  return {
    page: parseInteger(raw.page, 'page', 1, 100_000, 1),
    page_size: parseInteger(raw.page_size, 'page_size', 1, MAX_EXAM_PAGE_SIZE, DEFAULT_EXAM_PAGE_SIZE),
    q,
    status,
    category,
    track,
    sort,
    direction,
  };
};
