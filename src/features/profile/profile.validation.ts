import { z } from 'zod';

/**
 * Fields an ordinary authenticated user may edit on their own profile.
 *
 * Everything else on `profiles` (XP, coins, subscription/account status, 2FA,
 * verification flags, roles, timestamps, ...) is server-controlled.
 */
export const PROFILE_SELF_EDITABLE_FIELDS = [
  'full_name',
  'username',
  'phone_number',
  'bio',
  'avatar_url',
  'gender',
  'date_of_birth',
  'institution',
  'institution_id',
  'class_level',
  'group',
  'education_board',
  'batch_year',
  'hsc_batch',
  'hsc_group',
  'admission_targets',
  'other_admission_target',
  'guardian_phone',
  'study_goal',
  'language_preference',
  'address',
] as const;

export const ADMIN_PROFILE_EDITABLE_FIELDS = [
  ...PROFILE_SELF_EDITABLE_FIELDS,
  'username',
] as const;

export class ProfileValidationError extends Error {
  status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'ProfileValidationError';
  }
}

const PHONE_PATTERN = /^\+?[0-9][0-9\s-]{5,19}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (value: string): boolean => {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const nullableText = (max: number) =>
  z.union([z.string().trim().max(max), z.null()]).optional();

const nullablePhone = z
  .union([z.string().trim().regex(PHONE_PATTERN, 'Invalid phone number format'), z.null()])
  .optional();

const normalizedUsername = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9_]{3,20}$/, 'Username must be 3-20 lowercase letters, numbers, or underscores'));

const addressSchema = z
  .record(
    z.union([
      z.string().trim().max(200),
      z.number().finite(),
      z.boolean(),
      z.null(),
    ])
  )
  .refine((value) => Object.keys(value).length <= 20, {
    message: 'Address contains too many fields',
  })
  .refine(
    (value) =>
      Object.keys(value).every(
        (key) =>
          key !== '__proto__' &&
          key !== 'prototype' &&
          key !== 'constructor' &&
          /^[a-zA-Z0-9_]{1,40}$/.test(key)
      ),
    { message: 'Address contains an invalid field name' }
  );

const profileFields = {
  full_name: z.string().trim().min(1, 'Full name is required').max(100).optional(),
  username: normalizedUsername.optional(),
  phone_number: nullablePhone,
  bio: nullableText(500),
  avatar_url: z
    .union([
      z
        .string()
        .trim()
        .max(2048)
        .regex(/^https?:\/\//i, 'Avatar URL must use http or https'),
      z.literal(''),
      z.null(),
    ])
    .optional(),
  gender: nullableText(30),
  date_of_birth: z
    .union([
      z
        .string()
        .trim()
        .regex(DATE_PATTERN, 'Date of birth must use YYYY-MM-DD')
        .refine(isRealDate, 'Date of birth is not a real date'),
      z.null(),
    ])
    .optional(),
  institution: nullableText(200),
  institution_id: nullableText(100),
  class_level: nullableText(50),
  group: nullableText(50),
  education_board: nullableText(100),
  batch_year: nullableText(20),
  hsc_batch: z
    .union([z.literal(''), z.string().trim().regex(/^[0-9]{4}$/, 'HSC batch must be a four-digit year'), z.null()])
    .optional(),
  hsc_group: z
    .union([z.literal(''), z.enum(['science', 'humanities', 'business_studies']), z.null()])
    .optional(),
  admission_targets: z
    .array(
      z.enum([
        'university',
        'engineering',
        'medical',
        'dental',
        'agricultural',
        'general_university',
        'national_university',
        'other',
      ])
    )
    .max(8, 'Too many admission targets')
    .transform((values) => Array.from(new Set(values)))
    .optional(),
  other_admission_target: nullableText(100),
  guardian_phone: nullablePhone,
  study_goal: nullableText(200),
  language_preference: z.enum(['bn', 'en'], {
    errorMap: () => ({ message: "Language preference must be either 'bn' or 'en'" }),
  }).optional(),
  address: z.union([addressSchema, z.null()]).optional(),
};

// Unknown keys are stripped by Zod's default object behaviour, so a crafted
// request cannot smuggle server-controlled columns into the update payload.
const selfSchema = z.object(profileFields);
const adminSchema = z.object({
  ...profileFields,
  username: z.union([normalizedUsername, z.null()]).optional(),
});

type AllowlistedField = string;

const buildAllowlistedPayload = (
  input: unknown,
  schema: z.ZodTypeAny,
  allowedFields: readonly AllowlistedField[]
): Record<string, unknown> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProfileValidationError('Profile update payload must be an object');
  }

  const result = schema.safeParse(input);

  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new ProfileValidationError(firstIssue?.message || 'Invalid profile update payload');
  }

  const parsed = result.data as Record<string, unknown>;
  const payload: Record<string, unknown> = {};

  for (const field of allowedFields) {
    if (!Object.prototype.hasOwnProperty.call(parsed, field)) continue;

    let value = parsed[field];

    if (typeof value === 'string') {
      value = value.trim();
      if (value === '' && field !== 'full_name') value = null;
    }

    if (field === 'full_name' && (typeof value !== 'string' || value.length === 0)) {
      throw new ProfileValidationError('Full name is required');
    }

    if (value !== undefined) payload[field] = value;
  }

  return payload;
};

export const buildProfileUpdatePayload = (input: unknown) =>
  buildAllowlistedPayload(input, selfSchema, PROFILE_SELF_EDITABLE_FIELDS);

export const buildAdminProfileUpdatePayload = (input: unknown) =>
  buildAllowlistedPayload(input, adminSchema, ADMIN_PROFILE_EDITABLE_FIELDS);

export const parseThemePreference = (theme: unknown): string => {
  if (typeof theme !== 'string') {
    throw new ProfileValidationError('Theme must be a string');
  }

  const normalized = theme.trim();

  if (!/^[a-zA-Z0-9_-]{1,50}$/.test(normalized)) {
    throw new ProfileValidationError('Invalid theme value');
  }

  return normalized;
};
