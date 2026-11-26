import { HscBatchesError } from './hscBatches.types';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_YEAR = 2015;
const MAX_YEAR = 2100;
const NOTES_MAX_LENGTH = 500;

export const MAX_BATCH_NOTES_LENGTH = NOTES_MAX_LENGTH;

const isRealDate = (value: string): boolean => {
  if (!DATE_PATTERN.test(value)) return false;

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

export const parseBatchYear = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new HscBatchesError('Batch year is required');
  }

  const year = value.trim();

  if (!/^20[0-9]{2}$/.test(year)) {
    throw new HscBatchesError('Batch year must be a four-digit year such as 2027');
  }

  const numeric = Number(year);
  if (numeric < MIN_YEAR || numeric > MAX_YEAR) {
    throw new HscBatchesError(`Batch year must be between ${MIN_YEAR} and ${MAX_YEAR}`);
  }

  return year;
};

/**
 * `null` and the empty string both mean "the exam has no end date yet", which is
 * a real answer, not a missing one: the batch simply is not finished.
 */
export const parseExamEndDate = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;

  if (typeof value !== 'string') {
    throw new HscBatchesError('Exam end date must be a YYYY-MM-DD string');
  }

  const raw = value.trim();
  if (!raw) return null;

  if (!isRealDate(raw)) {
    throw new HscBatchesError('Exam end date must be a real date in YYYY-MM-DD form');
  }

  return raw;
};

export const parseBatchNotes = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;

  if (typeof value !== 'string') {
    throw new HscBatchesError('Notes must be text');
  }

  const notes = value.trim();
  if (!notes) return null;

  if (notes.length > NOTES_MAX_LENGTH) {
    throw new HscBatchesError(`Notes cannot be longer than ${NOTES_MAX_LENGTH} characters`);
  }

  return notes;
};

export const parseCreateBatchBody = (body: unknown) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HscBatchesError('Batch payload must be an object');
  }

  const raw = body as Record<string, unknown>;

  return {
    batch_year: parseBatchYear(raw.batch_year),
    exam_end_date: parseExamEndDate(raw.exam_end_date),
    notes: parseBatchNotes(raw.notes),
  };
};

/**
 * Only the fields present in the request are returned, so a patch that changes
 * the date cannot silently clear the notes (or the other way round).
 */
export const parseUpdateBatchBody = (body: unknown) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HscBatchesError('Batch payload must be an object');
  }

  const raw = body as Record<string, unknown>;
  const patch: { exam_end_date?: string | null; notes?: string | null } = {};

  if (Object.prototype.hasOwnProperty.call(raw, 'exam_end_date')) {
    patch.exam_end_date = parseExamEndDate(raw.exam_end_date);
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'notes')) {
    patch.notes = parseBatchNotes(raw.notes);
  }

  if (Object.keys(patch).length === 0) {
    throw new HscBatchesError('Nothing to update: send exam_end_date or notes');
  }

  return patch;
};
