import { z } from 'zod';
import {
  ADMISSION_ERROR_CODES,
  AdmissionError,
} from './admissions.errors';
import { ADMISSION_PRACTICE_MAX_QUESTIONS } from './admissions.practice';

const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional();

const unitFields = {
  name_bn: z.string().trim().min(1, 'Bangla unit name is required').max(160),
  name_en: optionalText(160),
  code: z.string().trim().min(1, 'Unit code is required').max(50),
  description: optionalText(2000),
  is_active: z.boolean().optional(),
  display_order: z.number().int().min(0).max(1_000_000).optional(),
};

const createUnitSchema = z.object(unitFields).strict();

const updateUnitSchema = z
  .object(unitFields)
  .partial()
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'At least one editable field is required'
  );

const unitStatusSchema = z
  .object({
    is_active: z.boolean(),
  })
  .strict();

const practiceSchema = z
  .object({
    subject_id: z.string().trim().uuid('A valid subject id is required'),
    chapter_id: z
      .string()
      .trim()
      .uuid('A valid chapter id is required')
      .nullable()
      .optional(),
    limit: z.number().int().min(1).max(ADMISSION_PRACTICE_MAX_QUESTIONS).optional(),
  })
  .strict();

const uuidSchema = z.string().trim().uuid('A valid id is required');

export interface CreateAdmissionUnitInput {
  name_bn: string;
  name_en: string | null;
  code: string;
  description: string | null;
  is_active: boolean;
  display_order: number;
}

export interface UpdateAdmissionUnitInput {
  name_bn?: string;
  name_en?: string | null;
  code?: string;
  description?: string | null;
  is_active?: boolean;
  display_order?: number;
}

const parseOrThrow = <T>(
  schema: z.ZodType<T>,
  input: unknown,
  fallback: string
): T => {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new AdmissionError(
      result.error.issues[0]?.message || fallback,
      400,
      ADMISSION_ERROR_CODES.VALIDATION_FAILED
    );
  }

  return result.data;
};

const normalizeOptionalText = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined) return undefined;
  return value === '' ? null : value;
};

/** Unit codes are unique per university ignoring case and surrounding whitespace. */
export const normalizeUnitCode = (code: string): string => code.trim().toLowerCase();

export const parseAdmissionId = (value: unknown, label: string): string => {
  const result = uuidSchema.safeParse(value);

  if (!result.success) {
    throw new AdmissionError(
      `A valid ${label} is required`,
      400,
      ADMISSION_ERROR_CODES.VALIDATION_FAILED
    );
  }

  return result.data;
};

export const parseCreateAdmissionUnit = (input: unknown): CreateAdmissionUnitInput => {
  const data = parseOrThrow(createUnitSchema, input, 'Invalid admission unit payload');

  return {
    name_bn: data.name_bn,
    name_en: normalizeOptionalText(data.name_en) ?? null,
    code: data.code,
    description: normalizeOptionalText(data.description) ?? null,
    is_active: data.is_active ?? true,
    display_order: data.display_order ?? 0,
  };
};

export const parseUpdateAdmissionUnit = (input: unknown): UpdateAdmissionUnitInput => {
  const data = parseOrThrow(updateUnitSchema, input, 'Invalid admission unit update');

  const patch: UpdateAdmissionUnitInput = {};

  if (data.name_bn !== undefined) patch.name_bn = data.name_bn;
  if (data.name_en !== undefined) patch.name_en = normalizeOptionalText(data.name_en) ?? null;
  if (data.code !== undefined) patch.code = data.code;
  if (data.description !== undefined) {
    patch.description = normalizeOptionalText(data.description) ?? null;
  }
  if (data.is_active !== undefined) patch.is_active = data.is_active;
  if (data.display_order !== undefined) patch.display_order = data.display_order;

  return patch;
};

export const parseAdmissionUnitStatus = (input: unknown): { is_active: boolean } =>
  parseOrThrow(unitStatusSchema, input, 'Invalid admission unit status');

export interface AdmissionPracticeInput {
  subject_id: string;
  chapter_id: string | null;
  limit?: number;
}

/**
 * Student practice selection. Only a subject and an optional chapter are
 * accepted; question ids are always resolved server-side from the unit pool.
 */
export const parseAdmissionPracticeInput = (input: unknown): AdmissionPracticeInput => {
  const data = parseOrThrow(practiceSchema, input, 'Invalid admission practice request');

  return {
    subject_id: data.subject_id,
    chapter_id: data.chapter_id ?? null,
    ...(data.limit !== undefined ? { limit: data.limit } : {}),
  };
};
