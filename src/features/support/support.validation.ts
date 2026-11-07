import { z } from 'zod';
import {
  SUPPORT_CATEGORIES,
  SUPPORT_PRIORITIES,
  SUPPORT_STATUSES,
  SupportCategory,
  SupportPriority,
  SupportStatus,
} from './support.types';
import { SupportValidationError } from './support.errors';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Search reaches a PostgREST `or` filter, so the value must not be able to add
 * filter terms. Commas, parentheses, quotes and LIKE wildcards are rejected.
 */
const SEARCH_PATTERN = /^[\p{L}\p{N}@.+\-\s]{1,100}$/u;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const dateString = z
  .string()
  .regex(DATE_PATTERN, 'Invalid date')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, 'Invalid date');

const queryString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
};

const text = (min: number, max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length >= min && value.length <= max, {
      message: `Must be between ${min} and ${max} characters`,
    });

export const parseSupportTicketId = (value: unknown): string => {
  const id = queryString(value)?.trim();
  if (!id || !UUID_PATTERN.test(id)) {
    throw new SupportValidationError('Invalid ticket id');
  }
  return id;
};

const attachmentSchema = z.object({
  file_name: text(1, 120),
  mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  data_url: z.string().min(32).max(2_900_000),
});

export type SupportAttachmentInput = z.infer<typeof attachmentSchema>;

const contextSchema = z
  .object({
    question_id: z.string().max(128).optional().nullable(),
    exam_id: z.string().max(128).optional().nullable(),
    screen: z.string().max(128).optional().nullable(),
  })
  .optional()
  .nullable();

const createTicketSchema = z.object({
  category: z.enum(SUPPORT_CATEGORIES),
  subject: text(5, 140),
  description: text(10, 5000),
  context: contextSchema,
  attachments: z.array(attachmentSchema).max(3).optional(),
});

export type CreateSupportTicketInput = {
  category: SupportCategory;
  subject: string;
  description: string;
  contextQuestionId: string | null;
  contextExamId: string | null;
  contextScreen: string | null;
  attachments: SupportAttachmentInput[];
};

const firstIssue = (error: z.ZodError): string =>
  error.issues[0]?.message ?? 'Invalid request';

const parseWith = <S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> => {
  const result = schema.safeParse(value);
  if (!result.success) throw new SupportValidationError(firstIssue(result.error));
  return result.data;
};

const optionalContextValue = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

export const parseCreateSupportTicket = (body: unknown): CreateSupportTicketInput => {
  const parsed = parseWith(createTicketSchema, body);
  return {
    category: parsed.category,
    subject: parsed.subject,
    description: parsed.description,
    contextQuestionId: optionalContextValue(parsed.context?.question_id),
    contextExamId: optionalContextValue(parsed.context?.exam_id),
    contextScreen: optionalContextValue(parsed.context?.screen),
    attachments: parsed.attachments ?? [],
  };
};

const listBase = {
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
  status: z.enum(SUPPORT_STATUSES).optional(),
  category: z.enum(SUPPORT_CATEGORIES).optional(),
  search: z.string().trim().regex(SEARCH_PATTERN, 'Invalid search text').optional(),
};

const studentListSchema = z.object(listBase);

export interface SupportListQuery {
  limit: number;
  offset: number;
  status?: SupportStatus;
  category?: SupportCategory;
  priority?: SupportPriority;
  assignedTo?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  sort?: 'updated' | 'created';
  direction?: 'asc' | 'desc';
}

export const parseSupportListQuery = (query: unknown): SupportListQuery => {
  const source = (query ?? {}) as Record<string, unknown>;
  const parsed = parseWith(studentListSchema, {
    limit: queryString(source.limit),
    offset: queryString(source.offset),
    status: queryString(source.status) || undefined,
    category: queryString(source.category) || undefined,
    search: queryString(source.search) || undefined,
  });

  return {
    limit: parsed.limit ?? 20,
    offset: parsed.offset ?? 0,
    status: parsed.status,
    category: parsed.category,
    search: parsed.search,
  };
};

const adminListSchema = z.object({
  ...listBase,
  priority: z.enum(SUPPORT_PRIORITIES).optional(),
  assigned: z.enum(['all', 'unassigned', 'me']).or(z.string().regex(UUID_PATTERN)).optional(),
  date_from: dateString.optional(),
  date_to: dateString.optional(),
  sort: z.enum(['updated', 'created']).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
});

export const parseSupportAdminListQuery = (
  query: unknown,
  viewerId: string
): SupportListQuery => {
  const source = (query ?? {}) as Record<string, unknown>;
  const parsed = parseWith(adminListSchema, {
    limit: queryString(source.limit),
    offset: queryString(source.offset),
    status: queryString(source.status) || undefined,
    category: queryString(source.category) || undefined,
    priority: queryString(source.priority) || undefined,
    assigned: queryString(source.assigned) || undefined,
    search: queryString(source.search) || undefined,
    date_from: queryString(source.date_from) || undefined,
    date_to: queryString(source.date_to) || undefined,
    sort: queryString(source.sort) || undefined,
    direction: queryString(source.direction) || undefined,
  });

  return {
    limit: parsed.limit ?? 20,
    offset: parsed.offset ?? 0,
    status: parsed.status,
    category: parsed.category,
    priority: parsed.priority,
    assignedTo:
      parsed.assigned === 'unassigned'
        ? 'unassigned'
        : parsed.assigned === 'me'
          ? viewerId
          : parsed.assigned,
    search: parsed.search,
    dateFrom: parsed.date_from,
    dateTo: parsed.date_to,
    sort: parsed.sort ?? 'updated',
    direction: parsed.direction ?? 'desc',
  };
};

const replySchema = z.object({
  body: text(1, 5000),
});

export const parseSupportReply = (body: unknown): string => {
  return parseWith(replySchema, body).body;
};

const statusSchema = z.object({
  status: z.enum(SUPPORT_STATUSES),
});

export const parseSupportStatusUpdate = (body: unknown): SupportStatus =>
  parseWith(statusSchema, body).status;

const prioritySchema = z.object({
  priority: z.enum(SUPPORT_PRIORITIES),
});

export const parseSupportPriorityUpdate = (body: unknown): SupportPriority =>
  parseWith(prioritySchema, body).priority;

const assignmentSchema = z.object({
  assigned_to: z.string().regex(UUID_PATTERN).nullable(),
});

export const parseSupportAssignment = (body: unknown): string | null =>
  parseWith(assignmentSchema, body).assigned_to;
