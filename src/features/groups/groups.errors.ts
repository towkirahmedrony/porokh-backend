/**
 * Groups / battles error contract.
 *
 * The database RPCs signal failures with a PostgREST error whose `message` is
 * exactly a machine-readable code (for example `GROUP_FULL`). Those codes are
 * forwarded to the client unchanged so the student app can render a localized
 * message, and are never replaced with SQL text.
 */

export const GROUP_ERROR_CODES = [
  'GROUP_FULL',
  'ALREADY_IN_SQUAD',
  'ALREADY_MEMBER',
  'REQUEST_PENDING',
  'BANNED',
  'INVALID_JOIN_CODE',
  'GROUP_NOT_FOUND',
  'GROUP_INACTIVE',
  'FORBIDDEN',
  'COMMUNITY_ADMIN_ONLY',
  'INVALID_NAME',
  'NOT_A_MEMBER',
  'CANNOT_KICK_OWNER',
  'CANNOT_REMOVE_OWNER',
  'MEMBER_NOT_FOUND',
  'MEMBER_NOT_ACTIVE',
  'USER_NOT_FOUND',
  'OWNER_ROLE_FIXED',
  'OWNER_NOT_MEMBER',
  'REQUEST_NOT_FOUND',
  'INVALID_MAX_MEMBERS',
  'INVALID_SLUG',
  'SLUG_TAKEN',
  'INVALID_GROUP_TYPE',
  'INVALID_VISIBILITY',
  'USE_LEAVE_GROUP',
  'CODE_GENERATION_FAILED',
  'MESSAGE_NOT_FOUND',
  'CANNOT_REPORT_THIS_MESSAGE',
  'INVALID_OFFENSE_TYPE',
  'BATTLE_NOT_FOUND',
  'ALREADY_REPORTED',
  'PROTECTED_FIELD',
  'BATTLE_ALREADY_OPEN',
  'BATTLE_CLOSED',
  'BATTLE_NOT_STARTED',
  'BATTLE_NOT_FINISHED',
  'BATTLE_CANCELLED',
  'NOT_JOINED_OR_ALREADY_SUBMITTED',
  'INVALID_QUESTIONS',
  'INVALID_DURATION',
  'INVALID_START_TIME',
  'AUTH_REQUIRED',
  // Backend-side additions used by the HTTP layer before/around an RPC.
  'MESSAGE_BLOCKED',
  'MESSAGE_RATE_LIMITED',
  'VALIDATION_FAILED',
  'CRON_UNAUTHORIZED',
] as const;

export type GroupErrorCode = (typeof GROUP_ERROR_CODES)[number];

const GROUP_ERROR_CODE_SET = new Set<string>(GROUP_ERROR_CODES);

const STATUS_BY_CODE: Partial<Record<GroupErrorCode, number>> = {
  AUTH_REQUIRED: 401,
  CRON_UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  COMMUNITY_ADMIN_ONLY: 403,
  NOT_A_MEMBER: 403,
  BANNED: 403,
  CANNOT_KICK_OWNER: 403,
  CANNOT_REMOVE_OWNER: 409,
  MEMBER_NOT_FOUND: 404,
  MEMBER_NOT_ACTIVE: 409,
  USER_NOT_FOUND: 404,
  OWNER_ROLE_FIXED: 409,
  OWNER_NOT_MEMBER: 409,
  GROUP_NOT_FOUND: 404,
  GROUP_INACTIVE: 404,
  REQUEST_NOT_FOUND: 404,
  GROUP_FULL: 409,
  ALREADY_IN_SQUAD: 409,
  ALREADY_MEMBER: 409,
  REQUEST_PENDING: 409,
  BATTLE_ALREADY_OPEN: 409,
  BATTLE_CLOSED: 409,
  BATTLE_NOT_FINISHED: 409,
  BATTLE_CANCELLED: 409,
  NOT_JOINED_OR_ALREADY_SUBMITTED: 409,
  INVALID_JOIN_CODE: 400,
  INVALID_NAME: 400,
  INVALID_MAX_MEMBERS: 400,
  INVALID_SLUG: 400,
  INVALID_GROUP_TYPE: 400,
  INVALID_VISIBILITY: 400,
  USE_LEAVE_GROUP: 400,
  INVALID_OFFENSE_TYPE: 400,
  CANNOT_REPORT_THIS_MESSAGE: 400,
  MESSAGE_NOT_FOUND: 404,
  BATTLE_NOT_FOUND: 404,
  SLUG_TAKEN: 409,
  ALREADY_REPORTED: 409,
  CODE_GENERATION_FAILED: 500,
  PROTECTED_FIELD: 400,
  INVALID_QUESTIONS: 400,
  INVALID_DURATION: 400,
  INVALID_START_TIME: 400,
  BATTLE_NOT_STARTED: 400,
  MESSAGE_BLOCKED: 400,
  MESSAGE_RATE_LIMITED: 429,
  VALIDATION_FAILED: 400,
};

export class GroupError extends Error {
  statusCode: number;
  errorCode: GroupErrorCode;

  constructor(code: GroupErrorCode, statusCode?: number) {
    super(code);
    this.name = 'GroupError';
    this.errorCode = code;
    this.statusCode = statusCode ?? STATUS_BY_CODE[code] ?? 400;
  }
}

export const groupError = (code: GroupErrorCode, statusCode?: number): GroupError =>
  new GroupError(code, statusCode);

/** True when a raw message is a documented RPC error code. */
export const isGroupErrorCode = (value: unknown): value is GroupErrorCode =>
  typeof value === 'string' && GROUP_ERROR_CODE_SET.has(value.trim());

type PostgrestLikeError = { message?: string | null; code?: string | null; details?: string | null };

/**
 * Translates a Supabase/PostgREST failure into an application error.
 *
 * `message` is the RPC error code by contract. Anything else is an operational
 * failure and is deliberately replaced with a generic server error so SQL text
 * never reaches a student.
 */
export const mapDataError = (error: PostgrestLikeError | null | undefined): GroupError => {
  const raw = typeof error?.message === 'string' ? error.message.trim() : '';

  if (isGroupErrorCode(raw)) {
    return new GroupError(raw);
  }

  // PostgREST reports a unique violation with this SQLSTATE. It is a race on a
  // membership row, which the caller surfaces as "already a member".
  if (error?.code === '23505') {
    return new GroupError('ALREADY_MEMBER');
  }

  const operational = new GroupError('VALIDATION_FAILED', 500);
  operational.message = 'GROUPS_INTERNAL_ERROR';
  return operational;
};
