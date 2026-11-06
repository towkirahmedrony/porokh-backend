import {
  ACCOUNT_STATUSES,
  ACCESS_FILTERS,
  DIRECTORY_SORTS,
  UsersAdminError,
  type AccountStatus,
  type AccessFilter,
  type DirectoryQuery,
  type DirectorySort,
} from './users.admin.types';
import { CANONICAL_ROLES, isCanonicalRole } from '../../middlewares/authorization';
import { SearchInputError, normalizeSearchTerm } from '../../lib/utils/search';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
/** Upper bound for one CSV export so a single request cannot stream the table. */
export const MAX_EXPORT_ROWS = 5000;

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const parseInteger = (value: unknown, field: string, min: number, max: number, fallback: number): number => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new UsersAdminError(`${field} must be a whole number between ${min} and ${max}`);
  }
  return parsed;
};

const parseDateBoundary = (value: unknown, field: string, endOfDay: boolean): string | undefined => {
  const raw = asString(value);
  if (!raw) return undefined;

  // `<input type="date">` sends YYYY-MM-DD, which Date.parse reads as UTC
  // midnight; an end boundary must cover the whole day.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = dateOnly && endOfDay ? Date.parse(`${raw}T23:59:59.999Z`) : Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new UsersAdminError(`${field} must be a valid date`);
  }
  return new Date(parsed).toISOString();
};

/**
 * Normalises the directory query string. Unknown enum values and malformed
 * numbers are rejected instead of silently falling back to a different filter,
 * so a mis-typed link cannot quietly show the wrong user set.
 */
export const parseDirectoryQuery = (raw: Record<string, unknown>): DirectoryQuery => {
  const status = asString(raw.status) || 'all';
  if (status !== 'all' && !(ACCOUNT_STATUSES as readonly string[]).includes(status)) {
    throw new UsersAdminError(`status must be one of ${['all', ...ACCOUNT_STATUSES].join(', ')}`);
  }

  const access = (asString(raw.access) || 'all') as AccessFilter;
  if (!(ACCESS_FILTERS as readonly string[]).includes(access)) {
    throw new UsersAdminError(`access must be one of ${ACCESS_FILTERS.join(', ')}`);
  }

  const role = asString(raw.role) || 'all';
  if (role !== 'all' && !isCanonicalRole(role)) {
    throw new UsersAdminError(`role must be one of ${['all', ...CANONICAL_ROLES].join(', ')}`);
  }

  const sort = (asString(raw.sort) || 'created_at') as DirectorySort;
  if (!(DIRECTORY_SORTS as readonly string[]).includes(sort)) {
    throw new UsersAdminError(`sort must be one of ${DIRECTORY_SORTS.join(', ')}`);
  }

  const direction = asString(raw.direction) || 'desc';
  if (direction !== 'asc' && direction !== 'desc') {
    throw new UsersAdminError('direction must be asc or desc');
  }

  let q = '';
  try {
    q = normalizeSearchTerm(raw.q);
  } catch (error) {
    if (error instanceof SearchInputError) throw new UsersAdminError(error.message);
    throw error;
  }

  const createdFrom = parseDateBoundary(raw.created_from, 'created_from', false);
  const createdTo = parseDateBoundary(raw.created_to, 'created_to', true);
  if (createdFrom && createdTo && Date.parse(createdFrom) > Date.parse(createdTo)) {
    throw new UsersAdminError('created_from must not be after created_to');
  }

  return {
    page: parseInteger(raw.page, 'page', 1, 100_000, 1),
    page_size: parseInteger(raw.page_size, 'page_size', 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE),
    q,
    status: status as AccountStatus | 'all',
    access,
    role,
    created_from: createdFrom,
    created_to: createdTo,
    sort,
    direction,
  };
};

export type CsvValue = string | number | boolean | null | undefined;

/**
 * Escapes one CSV cell.
 *
 * A cell whose value starts with a formula character is prefixed with a single
 * quote, because spreadsheet applications execute `=`, `+`, `-` and `@` cells on
 * open. User-controlled names and reasons reach this function, so the export
 * must not hand a formula to Excel.
 */
export const escapeCsvCell = (value: CsvValue): string => {
  if (value === null || value === undefined) return '';
  let text = String(value);

  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  if (/["\n\r,]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
};

export const toCsv = (headers: string[], rows: CsvValue[][]): string =>
  [headers.map(escapeCsvCell).join(','), ...rows.map((row) => row.map(escapeCsvCell).join(','))].join('\r\n');
