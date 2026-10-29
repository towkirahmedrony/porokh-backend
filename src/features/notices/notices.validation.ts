import { z } from 'zod';
import { NOTICE_PRIORITIES } from './notices.types';

export class NoticeValidationError extends Error {
  status = 400;
  errorCode = 'VALIDATION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'NoticeValidationError';
  }
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === '' ? null : value));

/**
 * A safe action link is either an internal app route ("/notices/abc", never
 * protocol-relative) or an absolute https URL.
 */
export const isSafeNoticeActionLink = (value: string): boolean => {
  if (value.startsWith('/')) {
    return !value.startsWith('//') && !/[\s\\]/.test(value);
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Notices may only reference assets uploaded through the existing Cloudinary
 * media flow (`/media` -> media_library). Supabase storage is not used for
 * notice images or PDFs in this project.
 */
export const isOwnedMediaUrl = (
  value: string,
  cloudName: string | undefined = process.env.CLOUDINARY_CLOUD_NAME
): boolean => {
  const name = cloudName?.trim();
  if (!name) return false;
  return value.startsWith(`https://res.cloudinary.com/${name}/`);
};

const optionalActionLink = z
  .string()
  .trim()
  .max(2048)
  .nullable()
  .optional()
  .refine(
    (value) => value == null || value === '' || isSafeNoticeActionLink(value),
    'Action link must be an internal route or an https URL'
  )
  .transform((value) => (value === '' ? null : value));

const optionalMediaUrl = z
  .string()
  .trim()
  .max(2048)
  .nullable()
  .optional()
  .refine(
    (value) => value == null || value === '' || isOwnedMediaUrl(value),
    'Media must be uploaded to the project storage'
  )
  .transform((value) => (value === '' ? null : value));

const optionalDateTime = z
  .string()
  .trim()
  .max(60)
  .nullable()
  .optional()
  .refine(
    (value) => value == null || value === '' || !Number.isNaN(Date.parse(value)),
    'Invalid date'
  )
  .transform((value) => (value === '' ? null : value));

const stringList = z.array(z.string().trim().min(1).max(50)).max(20).optional();

export const noticeTargetRulesSchema = z
  .object({
    roles: stringList,
    class_levels: stringList,
    subscription: z.enum(['all', 'premium', 'free']).optional(),
    languages: z.array(z.enum(['bn', 'en'])).max(2).optional(),
  })
  .strict();

export const noticeCreateSchema = z
  .object({
    title_bn: z.string().trim().min(1, 'Bangla title is required').max(200),
    title_en: optionalText(200),
    body_bn: z.string().trim().min(1, 'Bangla body is required').max(10_000),
    body_en: optionalText(10_000),
    image_url: optionalMediaUrl,
    attachment_url: optionalMediaUrl,
    action_link: optionalActionLink,
    target_rules: z.union([noticeTargetRulesSchema, z.null()]).optional(),
    priority: z.enum(NOTICE_PRIORITIES).optional(),
    is_active: z.boolean().optional(),
    published_at: optionalDateTime,
    expires_at: optionalDateTime,
    also_notify: z.boolean().optional(),
  })
  .strict();

export const noticeUpdateSchema = noticeCreateSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'No notice fields supplied');

export const noticeListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
    priority: z.enum(NOTICE_PRIORITIES).optional(),
  })
  .strict();

export const noticePublishSchema = z
  .object({
    published_at: optionalDateTime,
    also_notify: z.boolean().optional(),
  })
  .strict();

export const noticeStatusSchema = z
  .object({
    is_active: z.boolean(),
  })
  .strict();

const parseOrThrow = <T>(schema: z.ZodType<T>, input: unknown, fallback: string): T => {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new NoticeValidationError(result.error.issues[0]?.message || fallback);
  }

  return result.data;
};

export const parseNoticeCreate = (input: unknown): z.infer<typeof noticeCreateSchema> =>
  parseOrThrow(noticeCreateSchema, input, 'Invalid notice payload');

export const parseNoticeUpdate = (input: unknown): z.infer<typeof noticeUpdateSchema> =>
  parseOrThrow(noticeUpdateSchema, input, 'Invalid notice update payload');

export const parseNoticeId = (input: unknown) =>
  parseOrThrow(z.string().uuid('Invalid notice id'), input, 'Invalid notice id');

export const parseNoticeListQuery = (input: unknown) =>
  parseOrThrow(noticeListQuerySchema, input, 'Invalid notice query');

export const parseNoticePublish = (input: unknown): z.infer<typeof noticePublishSchema> =>
  parseOrThrow(noticePublishSchema, input, 'Invalid publish payload');

export const parseNoticeStatus = (input: unknown): z.infer<typeof noticeStatusSchema> =>
  parseOrThrow(noticeStatusSchema, input, 'Invalid notice status payload');

/** Throws when the expiry window is empty or invalid. */
export const assertNoticeWindow = (
  publishedAt: string | null | undefined,
  expiresAt: string | null | undefined
): void => {
  if (!expiresAt) return;

  const publishTime = publishedAt ? Date.parse(publishedAt) : Date.now();
  const expiryTime = Date.parse(expiresAt);

  if (Number.isNaN(expiryTime)) {
    throw new NoticeValidationError('Invalid expiry date');
  }

  if (expiryTime <= publishTime) {
    throw new NoticeValidationError('Expiry must be after publish time');
  }
};
