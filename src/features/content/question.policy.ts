import crypto from 'crypto';

/**
 * Write policy for question content.
 *
 * Question rows carry moderation-controlled columns (status, is_active,
 * approved_*, counters, embeddings, audit notes). Only the fields below may be
 * supplied by a content author; everything else is either server-derived or
 * changed through an authorised review endpoint.
 */

/** Fields a content author may set on create or update. */
export const EDITABLE_QUESTION_FIELDS = [
  'type',
  'body',
  'options',
  'answer',
  'explanation',
  'difficulty_level',
  'subject_id',
  'chapter_id',
  'topic_id',
  'tags',
  'exam_references',
  'source_type',
  'media_id',
  'comprehension_id',
  'explanation_media_id',
] as const;

/** Moderation-controlled fields, only accepted from privileged roles. */
export const MODERATION_QUESTION_FIELDS = ['status', 'is_active'] as const;

export const QUESTION_STATUSES = [
  'draft',
  'review',
  'approved',
  'rejected',
  'published',
  'deleted',
  'flagged',
  'pending',
] as const;

/** Roles allowed to publish, activate or otherwise moderate questions. */
export const PRIVILEGED_CONTENT_ROLES = ['super_admin', 'admin', 'moderator'] as const;

export const isPrivilegedContentRole = (role?: string | null): boolean =>
  typeof role === 'string' &&
  (PRIVILEGED_CONTENT_ROLES as readonly string[]).includes(role);

export const canEditQuestion = (role: string | null | undefined, userId: string | null | undefined, ownerId: string | null | undefined): boolean =>
  isPrivilegedContentRole(role) ||
  ((role === 'editor' || role === 'teacher') && Boolean(userId && ownerId && userId === ownerId));

type AnyObject = Record<string, unknown>;

/**
 * Content fields that participate in duplicate detection.
 *
 * This is the single canonicalisation used by both the single-question and the
 * bulk path: identical content yields an identical hash regardless of which
 * endpoint created it, and server-managed fields (created_by, status, counters,
 * embeddings) never change the result.
 */
export const HASHED_QUESTION_FIELDS = [
  'subject_id',
  'chapter_id',
  'topic_id',
  'comprehension_id',
  'type',
  'body',
  'options',
  'answer',
  'explanation',
  'difficulty_level',
  'source_type',
  'tags',
  'exam_references',
  'media_id',
  'explanation_media_id',
] as const;

const stableStringify = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  if (typeof value === 'object') {
    const entries = Object.entries(value as AnyObject)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }

  return JSON.stringify(value);
};

/** Canonical content hash shared by every question-write path. */
export const buildQuestionContentHash = (question: AnyObject): string => {
  const canonical: AnyObject = {};

  for (const field of HASHED_QUESTION_FIELDS) {
    const value = question?.[field];
    if (value === undefined) continue;
    canonical[field] =
      value === null || value === '' || (Array.isArray(value) && value.length === 0)
        ? null
        : value;
  }

  return crypto.createHash('md5').update(stableStringify(canonical)).digest('hex');
};

const OPTION_FLAG_KEYS = ['is_correct', 'isCorrect', 'correct', 'answer'] as const;

const isTruthyFlag = (value: unknown): boolean =>
  value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');

/**
 * Canonical option shape for every write path.
 *
 * `is_correct` is stored; the older `isCorrect` spelling is accepted and
 * rewritten so the two cannot drift. An option without an id would be dropped
 * by the student question bank and could never be graded, so its position
 * supplies the id. Unknown option keys are copied through untouched.
 */
export const normalizeQuestionOptions = (value: unknown): unknown => {
  if (!Array.isArray(value)) return value;

  return value.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];

    const option: AnyObject = { ...(raw as AnyObject) };
    const id = option.id;
    const hasId =
      (typeof id === 'string' && id.trim() !== '') ||
      (typeof id === 'number' && Number.isFinite(id));

    if (!hasId) option.id = index + 1;

    option.is_correct = OPTION_FLAG_KEYS.some((key) => isTruthyFlag(option[key]));
    delete option.isCorrect;

    return [option];
  });
};

/** Copies only author-editable fields from an untrusted request body. */
export const pickEditableQuestionFields = (input: unknown): AnyObject => {
  const source = (input ?? {}) as AnyObject;
  const picked: AnyObject = {};

  for (const field of EDITABLE_QUESTION_FIELDS) {
    if (source[field] === undefined) continue;

    picked[field] =
      field === 'options' ? normalizeQuestionOptions(source[field]) : source[field];
  }

  return picked;
};

export type QuestionWriteDecision = {
  /** Fields that will be persisted. */
  payload: AnyObject;
  /** True when the write must be routed back to review. */
  requiresReview: boolean;
  status?: string;
};

const hasContentChange = (patch: AnyObject): boolean =>
  ['body', 'options', 'answer'].some((field) => patch[field] !== undefined);

/**
 * Decides what a create/update may persist for a given role.
 *
 * - Teachers (and any non-privileged role) can never publish or activate a
 *   question: status/is_active are dropped, new content is `pending`, and any
 *   edit touching body/options/answer returns the question to `pending`.
 * - Admins and moderators keep the existing publishing workflow, including
 *   `status`/`is_active`, but still only through the allow-listed fields.
 */
export const decideQuestionWrite = (params: {
  role?: string | null;
  body: unknown;
  mode: 'create' | 'update';
}): QuestionWriteDecision => {
  const privileged = isPrivilegedContentRole(params.role);
  const payload = pickEditableQuestionFields(params.body);
  const requestedStatus =
    privileged && params.mode === 'create'
      ? (params.body as AnyObject | undefined)?.status
      : undefined;

  if (params.mode === 'create') {
    const status =
      typeof requestedStatus === 'string' &&
      (QUESTION_STATUSES as readonly string[]).includes(requestedStatus) &&
      requestedStatus !== 'deleted'
        ? requestedStatus
        : 'pending';

    payload.status = status;

    if (privileged) {
      const isActive = (params.body as AnyObject | undefined)?.is_active;
      if (typeof isActive === 'boolean') payload.is_active = isActive;
    }

    return { payload, requiresReview: status === 'pending', status };
  }

  if (!privileged) {
    // A content edit is a new moderation event: the question returns to review
    // until a privileged reviewer publishes it again.
    if (hasContentChange(payload)) {
      payload.status = 'pending';
      return { payload, requiresReview: true, status: 'pending' };
    }

    return { payload, requiresReview: false };
  }

  const moderationPayload = params.body as AnyObject | undefined;
  const requestedUpdateStatus = moderationPayload?.status;

  if (
    typeof requestedUpdateStatus === 'string' &&
    (QUESTION_STATUSES as readonly string[]).includes(requestedUpdateStatus)
  ) {
    payload.status = requestedUpdateStatus;
  }

  if (typeof moderationPayload?.is_active === 'boolean') {
    payload.is_active = moderationPayload.is_active;
  }

  return { payload, requiresReview: payload.status === 'pending', status: payload.status as string | undefined };
};
