import { z } from 'zod';

export class AppBuilderValidationError extends Error {
  status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'AppBuilderValidationError';
  }
}

export const PUBLIC_CONFIG_KEYS = ['daily_quote', 'theme_config', 'xp_rules'] as const;

export type PublicConfigKey = (typeof PUBLIC_CONFIG_KEYS)[number];

export const isPublicConfigKey = (key: string): key is PublicConfigKey =>
  (PUBLIC_CONFIG_KEYS as readonly string[]).includes(key);

const nullableText = (max: number) =>
  z.union([z.string().trim().max(max), z.null()]).optional();

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .regex(/^https?:\/\//i, 'URL must use http or https');

const targetRulesSchema = z.record(
  z.union([
    z.string().trim().max(200),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(z.string().trim().max(200)).max(50),
  ])
);

export const bannerCreateSchema = z
  .object({
    title: nullableText(200),
    description: nullableText(1000),
    image_url: httpUrl,
    action_link: nullableText(2048),
    action_type: nullableText(50),
    button_text: nullableText(100),
    sequence: z.number().int().min(0).max(10000).optional(),
    is_active: z.boolean().optional(),
    start_date: nullableText(50),
    end_date: nullableText(50),
    target_rules: z.union([targetRulesSchema, z.null()]).optional(),
  })
  .strict();

export const bannerUpdateSchema = bannerCreateSchema.partial().strict();

export const bannerIdSchema = z.string().trim().min(1).max(100);

export const homeGridSchema = z
  .object({
    id: z.string().trim().min(1).max(100).optional(),
    title: z.string().trim().min(1).max(200),
    title_en: nullableText(200),
    icon_name: z.string().trim().min(1).max(200),
    image_url: z.union([httpUrl, z.null()]).optional(),
    link: nullableText(2048),
    type: nullableText(50),
    color: nullableText(50),
    bg_color: nullableText(50),
    serial_order: z.number().int().min(0).max(10000).optional(),
    is_active: z.boolean().optional(),
    target_rules: z.union([targetRulesSchema, z.null()]).optional(),
  })
  .strict();

export const reorderHomeGridsSchema = z
  .object({
    grids: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(100),
            serial_order: z.number().int().min(0).max(10000),
          })
          .strict()
      )
      .min(1)
      .max(200),
  })
  .strict();

export const levelsSchema = z
  .object({
    levels: z
      .array(
        z
          .object({
            id: z.number().int().positive().optional(),
            name_bn: z.string().trim().min(1).max(100),
            name_en: z.string().trim().min(1).max(100),
            min_xp: z.number().int().min(0).max(100_000_000),
            max_xp: z.union([z.number().int().min(0).max(100_000_000), z.null()]).optional(),
            badge_url: z.union([httpUrl, z.null()]).optional(),
          })
          .strict()
      )
      .min(1)
      .max(200),
  })
  .strict();

/**
 * XP rules are a flat map of non-negative numeric settings. Nested objects,
 * strings, booleans and unknown key shapes are rejected.
 */
export const xpRulesSchema = z
  .record(z.number().finite().int().min(0).max(1_000_000))
  .refine((rules) => Object.keys(rules).length > 0, {
    message: 'XP rules payload cannot be empty',
  })
  .refine((rules) => Object.keys(rules).length <= 30, {
    message: 'XP rules payload contains too many fields',
  })
  .refine(
    (rules) => Object.keys(rules).every((key) => /^[a-z][a-z0-9_]{0,49}$/.test(key)),
    { message: 'XP rules payload contains an invalid field name' }
  );

const parseOrThrow = <T>(schema: z.ZodType<T>, input: unknown, fallback: string): T => {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new AppBuilderValidationError(result.error.issues[0]?.message || fallback);
  }

  return result.data;
};

export const parseBannerCreate = (input: unknown) =>
  parseOrThrow(bannerCreateSchema, input, 'Invalid banner payload');

export const parseBannerUpdate = (input: unknown) => {
  const data = parseOrThrow(bannerUpdateSchema, input, 'Invalid banner update payload');

  if (Object.keys(data).length === 0) {
    throw new AppBuilderValidationError('No banner fields supplied');
  }

  return data;
};

export const parseBannerId = (input: unknown) =>
  parseOrThrow(bannerIdSchema, input, 'Invalid banner id');

export const parseHomeGrid = (input: unknown) =>
  parseOrThrow(homeGridSchema, input, 'Invalid home grid payload');

export const parseHomeGridReorder = (input: unknown) =>
  parseOrThrow(reorderHomeGridsSchema, input, 'Invalid home grid reorder payload').grids;

export const parseLevels = (input: unknown) =>
  parseOrThrow(levelsSchema, input, 'Invalid levels payload').levels;

export const parseXpRules = (input: unknown) =>
  parseOrThrow(xpRulesSchema, input, 'Invalid XP rules payload');

export const parseRecordId = (input: unknown) =>
  parseOrThrow(z.string().trim().min(1).max(100), input, 'Invalid record id');

export const parseConfigValue = (input: unknown, key: PublicConfigKey) => {
  if (key === 'xp_rules') return parseXpRules(input);

  if (typeof input === 'string') {
    if (input.length > 10_000) {
      throw new AppBuilderValidationError('Config value is too long');
    }
    return input;
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppBuilderValidationError('Config value must be an object or string');
  }

  let serialized = '';

  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new AppBuilderValidationError('Config value is not serializable');
  }

  if (serialized.length > 100_000) {
    throw new AppBuilderValidationError('Config value is too large');
  }

  return input;
};
