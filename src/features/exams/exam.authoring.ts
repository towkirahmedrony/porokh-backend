/**
 * Validation for admin exam authoring (create / update).
 *
 * Exam papers are server-owned: publication state, total marks and question
 * associations are derived on the server, never taken from the browser. This
 * module is intentionally dependency-free so the contract can be unit tested
 * without a database.
 */

type AnyObject = Record<string, unknown>;

/** 400 with a machine-readable code the admin UI can branch on. */
export class ExamAuthoringError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(message: string, status = 400, code = 'VALIDATION_FAILED', details?: unknown) {
    super(message);
    this.name = 'ExamAuthoringError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Categories an administrator may author through this endpoint. */
export const EXAM_AUTHORING_CATEGORIES = ['model_test', 'board_exam', 'admission'] as const;

/** Tracks a model-test paper may target. */
export const MODEL_TEST_TRACKS = ['hsc', 'medical', 'engineering', 'varsity'] as const;

/** Admission-specific paper modes. Stored in `exam_papers.meta_data.exam_mode`. */
export const ADMISSION_EXAM_MODES = ['past_exam', 'subject_practice', 'model_test'] as const;

export type AdmissionExamMode = (typeof ADMISSION_EXAM_MODES)[number];

export const MAX_EXAM_QUESTIONS = 200;
export const MIN_EXAM_DURATION_MIN = 1;
export const MAX_EXAM_DURATION_MIN = 600;
export const MIN_QUESTION_MARKS = 0.25;
export const MAX_QUESTION_MARKS = 100;

/** Fields the client may send. Anything else is rejected, not ignored. */
const CREATE_FIELDS = [
  'title',
  'title_en',
  'subject_id',
  'category',
  'track',
  'exam_type',
  'duration_min',
  'start_time',
  'end_time',
  'result_publish_time',
  'instructions',
  'instructions_en',
  'syllabus_details',
  'syllabus_details_en',
  'pass_mark',
  'default_negative_marks',
  'show_leaderboard',
  'is_premium',
  'is_published',
  'question_ids',
  'question_marks',
  'admission_unit_id',
  'admission_university_id',
  'exam_mode',
  'admission_session',
] as const;

type CreateField = (typeof CREATE_FIELDS)[number];

/** Fields that are required when creating a paper. */
const REQUIRED_ON_CREATE: CreateField[] = [
  'title',
  'duration_min',
  'question_ids',
];

export type ExamAuthoringFields = {
  title: string;
  title_en: string | null;
  subject_id: string | null;
  category: string;
  track: string | null;
  exam_type: string | null;
  duration_min: number;
  start_time: string | null;
  end_time: string | null;
  result_publish_time: string | null;
  instructions: string | null;
  instructions_en: string | null;
  syllabus_details: string | null;
  syllabus_details_en: string | null;
  pass_mark: number;
  default_negative_marks: number;
  show_leaderboard: boolean;
  is_premium: boolean;
  is_published: boolean;
  question_ids: string[];
  question_marks: Record<string, number> | null;
  admission_unit_id: string | null;
  /** Validation-only: never persisted, because the unit owns the university. */
  admission_university_id: string | null;
  exam_mode: AdmissionExamMode | null;
  admission_session: string | null;
};

export type ExamAuthoringPatch = Partial<ExamAuthoringFields>;

const isPlainObject = (value: unknown): value is AnyObject =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readString = (
  source: AnyObject,
  field: string,
  { max, required }: { max: number; required: boolean }
): string | null => {
  const raw = source[field];

  if (raw === undefined || raw === null) {
    if (required) throw new ExamAuthoringError(`${field} is required`);
    return null;
  }

  if (typeof raw !== 'string') {
    throw new ExamAuthoringError(`${field} must be a string`);
  }

  const value = raw.trim();

  if (!value) {
    if (required) throw new ExamAuthoringError(`${field} is required`);
    return null;
  }

  if (value.length > max) {
    throw new ExamAuthoringError(`${field} must be at most ${max} characters`);
  }

  return value;
};

const readTimestamp = (
  source: AnyObject,
  field: string,
  { required }: { required: boolean }
): number | null => {
  const value = readString(source, field, { max: 64, required });

  if (value === null) return null;

  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    throw new ExamAuthoringError(`${field} must be a valid date/time`);
  }

  return parsed;
};

const readInteger = (
  source: AnyObject,
  field: string,
  { min, max, required }: { min: number; max: number; required: boolean }
): number | null => {
  const raw = source[field];

  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new ExamAuthoringError(`${field} is required`);
    return null;
  }

  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ExamAuthoringError(`${field} must be a whole number between ${min} and ${max}`);
  }

  return value;
};

const readNumber = (
  source: AnyObject,
  field: string,
  { min, max, required }: { min: number; max: number; required: boolean }
): number | null => {
  const raw = source[field];

  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new ExamAuthoringError(`${field} is required`);
    return null;
  }

  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());

  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ExamAuthoringError(`${field} must be a number between ${min} and ${max}`);
  }

  return value;
};

const readBoolean = (source: AnyObject, field: string): boolean | null => {
  const raw = source[field];

  if (raw === undefined || raw === null) return null;

  if (typeof raw !== 'boolean') {
    throw new ExamAuthoringError(`${field} must be a boolean`);
  }

  return raw;
};

/** Normalises the question id list: non-empty, bounded and duplicate-free. */
const readQuestionIds = (source: AnyObject, { required }: { required: boolean }): string[] | null => {
  const raw = source.question_ids;

  if (raw === undefined || raw === null) {
    if (required) throw new ExamAuthoringError('question_ids is required');
    return null;
  }

  if (!Array.isArray(raw)) {
    throw new ExamAuthoringError('question_ids must be an array of question ids');
  }

  const ids = raw.map((value) => (typeof value === 'string' ? value.trim() : ''));

  if (ids.some((id) => !id)) {
    throw new ExamAuthoringError('question_ids must contain non-empty question ids');
  }

  if (ids.length === 0) {
    if (required) throw new ExamAuthoringError('Select at least one question');
    return [];
  }

  if (ids.length > MAX_EXAM_QUESTIONS) {
    throw new ExamAuthoringError(`An exam may contain at most ${MAX_EXAM_QUESTIONS} questions`);
  }

  const unique = new Set(ids);

  if (unique.size !== ids.length) {
    throw new ExamAuthoringError('question_ids contains duplicate questions');
  }

  return ids;
};

/**
 * Reads optional per-question marks. Missing marks default to 1 (the existing
 * behaviour); every supplied key must belong to the submitted question list so
 * a client cannot smuggle marks for a question it did not select.
 */
const readQuestionMarks = (
  source: AnyObject,
  questionIds: string[]
): Record<string, number> | null => {
  const raw = source.question_marks;

  if (raw === undefined || raw === null) return null;

  if (!isPlainObject(raw)) {
    throw new ExamAuthoringError('question_marks must be an object of question id to marks');
  }

  const allowed = new Set(questionIds);
  const marks: Record<string, number> = {};

  for (const [questionId, value] of Object.entries(raw)) {
    const id = questionId.trim();

    if (!id || !allowed.has(id)) {
      throw new ExamAuthoringError(
        'question_marks contains a question that is not in question_ids',
        400,
        'VALIDATION_FAILED',
        { unsupported_question_ids: [questionId] }
      );
    }

    const numeric = typeof value === 'number' ? value : Number(String(value).trim());

    if (!Number.isFinite(numeric) || numeric < MIN_QUESTION_MARKS || numeric > MAX_QUESTION_MARKS) {
      throw new ExamAuthoringError(
        `question_marks must be between ${MIN_QUESTION_MARKS} and ${MAX_QUESTION_MARKS}`,
        400,
        'VALIDATION_FAILED',
        { invalid_question_ids: [questionId] }
      );
    }

    marks[id] = numeric;
  }

  return marks;
};

const readExamMode = (source: AnyObject): AdmissionExamMode | null => {
  const value = readString(source, 'exam_mode', { max: 32, required: false });

  if (value === null) return null;

  if (!(ADMISSION_EXAM_MODES as readonly string[]).includes(value)) {
    throw new ExamAuthoringError(`exam_mode must be one of: ${ADMISSION_EXAM_MODES.join(', ')}`);
  }

  return value as AdmissionExamMode;
};

const readAdmissionUnitId = (source: AnyObject): string | null =>
  readString(source, 'admission_unit_id', { max: 64, required: false });

const readAdmissionUniversityId = (source: AnyObject): string | null =>
  readString(source, 'admission_university_id', { max: 64, required: false });

const readAdmissionSession = (source: AnyObject): string | null =>
  readString(source, 'admission_session', { max: 64, required: false });

const assertKnownFields = (source: AnyObject, allowed: readonly string[]): void => {
  const unknown = Object.keys(source).filter((key) => !allowed.includes(key));

  if (unknown.length > 0) {
    // `id`, `total_marks`, `created_at` and every other server-managed column
    // lands here: the client cannot set them.
    throw new ExamAuthoringError(`Unsupported field(s): ${unknown.join(', ')}`, 400, 'VALIDATION_FAILED', {
      unsupported_fields: unknown,
    });
  }
};

const validateWindow = (
  startMs: number | null,
  endMs: number | null,
  publishMs: number | null
): void => {
  if (startMs !== null && endMs !== null && endMs <= startMs) {
    throw new ExamAuthoringError('end_time must be later than start_time');
  }

  if (startMs !== null && publishMs !== null && publishMs < startMs) {
    throw new ExamAuthoringError('result_publish_time cannot be earlier than start_time');
  }

  if (startMs !== null && endMs !== null && publishMs !== null && publishMs > endMs + 30 * 24 * 60 * 60 * 1000) {
    throw new ExamAuthoringError('result_publish_time is too far after end_time');
  }
};

/**
 * Re-validates an effective window (existing row + patch) before an update is
 * persisted, so a partial edit cannot produce an impossible exam window.
 */
export const assertValidExamWindow = (
  startIso: string | null | undefined,
  endIso: string | null | undefined,
  publishIso: string | null | undefined
): void => {
  const toMs = (value: string | null | undefined, field: string): number | null => {
    if (value === null || value === undefined || value === '') return null;

    const parsed = Date.parse(String(value));

    if (Number.isNaN(parsed)) {
      throw new ExamAuthoringError(`Stored ${field} is not a valid timestamp`);
    }

    return parsed;
  };

  validateWindow(toMs(startIso, 'start_time'), toMs(endIso, 'end_time'), toMs(publishIso, 'result_publish_time'));
};

const readCategory = (source: AnyObject): string | null => {
  const value = readString(source, 'category', { max: 32, required: false });

  if (value === null) return null;

  if (!(EXAM_AUTHORING_CATEGORIES as readonly string[]).includes(value)) {
    throw new ExamAuthoringError(
      `category must be one of: ${EXAM_AUTHORING_CATEGORIES.join(', ')}`
    );
  }

  return value;
};

/**
 * Reads `subject_id`, treating a missing/blank value as "no subject". Only a
 * model test may omit it (a full paper); that pairing is enforced separately by
 * `assertValidExamSubject`.
 */
const readSubjectId = (source: AnyObject): string | null => {
  const raw = source.subject_id;

  if (raw === undefined || raw === null) return null;

  if (typeof raw !== 'string') {
    throw new ExamAuthoringError('subject_id must be a string or null');
  }

  const value = raw.trim();

  if (!value) return null;

  if (value.length > 64) {
    throw new ExamAuthoringError('subject_id must be at most 64 characters');
  }

  return value;
};

/**
 * Enforces the category/subject pairing on the effective paper state.
 *
 * A model test may be full (`subject_id = NULL`). Board exams always target one
 * subject. Admission papers follow their mode: subject practice requires a
 * subject, while past exams and unit model tests may span subjects.
 */
export const assertValidExamSubject = (
  category: string | null | undefined,
  subjectId: string | null | undefined,
  _examMode?: AdmissionExamMode | null
): void => {
  if (category === 'model_test') return;

  if (category === 'admission') {
    // Admission subject rules are mode-aware and enforced by
    // assertValidAdmissionState, including legacy papers without a mode.
    return;
  }

  if (!subjectId) {
    throw new ExamAuthoringError(
      `subject_id is required for ${category || 'this category'}`,
      400,
      'VALIDATION_FAILED'
    );
  }
};

export interface AdmissionAuthoringState {
  unitId: string | null | undefined;
  universityId: string | null | undefined;
  examMode: AdmissionExamMode | null | undefined;
  admissionSession: string | null | undefined;
  subjectId: string | null | undefined;
}

/**
 * Validates the admission contract on the effective paper state.
 *
 * `enforce` is false for legacy admission papers being edited without touching
 * admission fields, so a paper created before this feature (NULL unit, no
 * exam_mode) can still have its title changed. Once an admission field is
 * supplied, the full contract applies.
 */
export const assertValidAdmissionState = (
  category: string | null | undefined,
  state: AdmissionAuthoringState,
  { enforce, requireMode }: { enforce: boolean; requireMode: boolean }
): void => {
  if (category !== 'admission') {
    if (
      state.unitId ||
      state.universityId ||
      state.examMode ||
      state.admissionSession
    ) {
      throw new ExamAuthoringError(
        'Admission fields are only allowed when category is admission'
      );
    }

    return;
  }

  if (!enforce) {
    if (state.examMode && state.examMode === 'past_exam' && !state.admissionSession) {
      throw new ExamAuthoringError(
        'admission_session is required for past exams',
        400,
        'ADMISSION_SESSION_REQUIRED'
      );
    }

    return;
  }

  if (!state.unitId) {
    throw new ExamAuthoringError(
      'admission_unit_id is required for admission exams',
      400,
      'ADMISSION_UNIT_REQUIRED'
    );
  }

  if (requireMode && !state.examMode) {
    throw new ExamAuthoringError(
      'exam_mode is required for admission exams',
      400,
      'ADMISSION_MODE_REQUIRED'
    );
  }

  if (state.examMode && !(ADMISSION_EXAM_MODES as readonly string[]).includes(state.examMode)) {
    throw new ExamAuthoringError(`exam_mode must be one of: ${ADMISSION_EXAM_MODES.join(', ')}`);
  }

  if (state.examMode === 'past_exam' && !state.admissionSession) {
    throw new ExamAuthoringError(
      'admission_session is required for past exams',
      400,
      'ADMISSION_SESSION_REQUIRED'
    );
  }

  if (state.examMode === 'subject_practice' && !state.subjectId) {
    throw new ExamAuthoringError(
      'subject_id is required for subject practice admission exams',
      400,
      'ADMISSION_SUBJECT_REQUIRED'
    );
  }
};

/**
 * Reads `track`, preserving the difference between "not supplied" (undefined)
 * and an explicit clear (`null`). Only model-test papers may carry a track.
 */
const readTrack = (source: AnyObject): string | null | undefined => {
  if (!('track' in source)) return undefined;

  const raw = source.track;

  if (raw === undefined || raw === null) return null;

  if (typeof raw !== 'string') {
    throw new ExamAuthoringError('track must be a string or null');
  }

  const value = raw.trim();

  if (!value) return null;

  if (!(MODEL_TEST_TRACKS as readonly string[]).includes(value)) {
    throw new ExamAuthoringError(`track must be one of: ${MODEL_TEST_TRACKS.join(', ')}`);
  }

  return value;
};

/**
 * Enforces the category/track pairing on the effective paper state. Model tests
 * must target a track; board and admission papers must not.
 */
export const assertValidExamTrack = (
  category: string | null | undefined,
  track: string | null | undefined
): void => {
  if (category === 'model_test') {
    if (!track) throw new ExamAuthoringError('track is required for model_test');
    return;
  }

  if (track) {
    throw new ExamAuthoringError('track must be empty unless category is model_test');
  }
};

/**
 * Parses a create payload into fully-normalised fields.
 *
 * All required fields must be present; window consistency is enforced here so
 * the service never persists an exam nobody can take.
 */
export const parseExamCreatePayload = (input: unknown): ExamAuthoringFields => {
  if (!isPlainObject(input)) {
    throw new ExamAuthoringError('A JSON object body is required');
  }

  assertKnownFields(input, CREATE_FIELDS);

  const missing = REQUIRED_ON_CREATE.filter((field) => input[field] === undefined);

  if (missing.length > 0) {
    throw new ExamAuthoringError(`Missing required field(s): ${missing.join(', ')}`, 400, 'VALIDATION_FAILED', {
      missing_fields: missing,
    });
  }

  const startMs = readTimestamp(input, 'start_time', { required: false });
  const endMs = readTimestamp(input, 'end_time', { required: false });
  const publishMs = readTimestamp(input, 'result_publish_time', { required: false });

  validateWindow(startMs, endMs, publishMs);

  const questionIds = readQuestionIds(input, { required: true }) ?? [];

  if (questionIds.length === 0) {
    throw new ExamAuthoringError('Select at least one question');
  }

  const category = readCategory(input) ?? 'model_test';
  const track = readTrack(input) ?? null;
  const subjectId = readSubjectId(input);
  const questionMarks = readQuestionMarks(input, questionIds);
  const admissionUnitId = readAdmissionUnitId(input);
  const admissionUniversityId = readAdmissionUniversityId(input);
  const examMode = readExamMode(input);
  const admissionSession = readAdmissionSession(input);

  assertValidExamTrack(category, track);
  assertValidExamSubject(category, subjectId, examMode);
  assertValidAdmissionState(
    category,
    {
      unitId: admissionUnitId,
      universityId: admissionUniversityId,
      examMode,
      admissionSession,
      subjectId,
    },
    { enforce: true, requireMode: true }
  );

  return {
    title: readString(input, 'title', { max: 200, required: true }) as string,
    title_en: readString(input, 'title_en', { max: 200, required: false }),
    subject_id: subjectId,
    category,
    track,
    exam_type: readString(input, 'exam_type', { max: 64, required: false }),
    duration_min: readInteger(input, 'duration_min', {
      min: MIN_EXAM_DURATION_MIN,
      max: MAX_EXAM_DURATION_MIN,
      required: true,
    }) as number,
    start_time: startMs === null ? null : new Date(startMs).toISOString(),
    end_time: endMs === null ? null : new Date(endMs).toISOString(),
    result_publish_time: publishMs === null ? null : new Date(publishMs).toISOString(),
    instructions: readString(input, 'instructions', { max: 5000, required: false }),
    instructions_en: readString(input, 'instructions_en', { max: 5000, required: false }),
    syllabus_details: readString(input, 'syllabus_details', { max: 5000, required: false }),
    syllabus_details_en: readString(input, 'syllabus_details_en', { max: 5000, required: false }),
    pass_mark: readInteger(input, 'pass_mark', { min: 0, max: 10_000, required: false }) ?? 0,
    default_negative_marks:
      readNumber(input, 'default_negative_marks', { min: 0, max: 1, required: false }) ?? 0.25,
    show_leaderboard: readBoolean(input, 'show_leaderboard') ?? true,
    is_premium: readBoolean(input, 'is_premium') ?? false,
    is_published: readBoolean(input, 'is_published') ?? false,
    question_ids: questionIds,
    question_marks: questionMarks,
    admission_unit_id: admissionUnitId,
    admission_university_id: admissionUniversityId,
    exam_mode: examMode,
    admission_session: admissionSession,
  };
};

/**
 * Parses a partial update. Only supplied fields are returned, and the same
 * field-level rules apply, so an update can never smuggle an invalid window or
 * a protected column.
 */
export const parseExamUpdatePayload = (input: unknown): ExamAuthoringPatch => {
  if (!isPlainObject(input)) {
    throw new ExamAuthoringError('A JSON object body is required');
  }

  assertKnownFields(input, CREATE_FIELDS);

  if (Object.keys(input).length === 0) {
    throw new ExamAuthoringError('No supported fields to update');
  }

  const patch: ExamAuthoringPatch = {};

  if ('title' in input) patch.title = readString(input, 'title', { max: 200, required: true }) as string;

  if ('title_en' in input) patch.title_en = readString(input, 'title_en', { max: 200, required: false });

  if ('subject_id' in input) {
    patch.subject_id = readSubjectId(input);
  }

  if ('admission_unit_id' in input) {
    patch.admission_unit_id = readAdmissionUnitId(input);
  }

  if ('admission_university_id' in input) {
    patch.admission_university_id = readAdmissionUniversityId(input);
  }

  if ('exam_mode' in input) {
    patch.exam_mode = readExamMode(input);
  }

  if ('admission_session' in input) {
    patch.admission_session = readAdmissionSession(input);
  }

  if ('category' in input) {
    const category = readCategory(input);
    if (category) patch.category = category;
  }

  if ('track' in input) {
    patch.track = readTrack(input) ?? null;
  }

  if ('exam_type' in input) {
    patch.exam_type = readString(input, 'exam_type', { max: 64, required: false });
  }

  if ('duration_min' in input) {
    patch.duration_min = readInteger(input, 'duration_min', {
      min: MIN_EXAM_DURATION_MIN,
      max: MAX_EXAM_DURATION_MIN,
      required: true,
    }) as number;
  }

  if ('start_time' in input) {
    const startMs = readTimestamp(input, 'start_time', { required: false });
    patch.start_time = startMs === null ? null : new Date(startMs).toISOString();
  }

  if ('end_time' in input) {
    const endMs = readTimestamp(input, 'end_time', { required: false });
    patch.end_time = endMs === null ? null : new Date(endMs).toISOString();
  }

  if ('result_publish_time' in input) {
    const publishMs = readTimestamp(input, 'result_publish_time', { required: false });
    patch.result_publish_time = publishMs === null ? null : new Date(publishMs).toISOString();
  }

  if ('instructions' in input) {
    patch.instructions = readString(input, 'instructions', { max: 5000, required: false });
  }

  if ('instructions_en' in input) {
    patch.instructions_en = readString(input, 'instructions_en', { max: 5000, required: false });
  }

  if ('syllabus_details' in input) {
    patch.syllabus_details = readString(input, 'syllabus_details', { max: 5000, required: false });
  }

  if ('syllabus_details_en' in input) {
    patch.syllabus_details_en = readString(input, 'syllabus_details_en', { max: 5000, required: false });
  }

  if ('pass_mark' in input) {
    patch.pass_mark = readInteger(input, 'pass_mark', { min: 0, max: 10_000, required: false }) ?? 0;
  }

  if ('default_negative_marks' in input) {
    patch.default_negative_marks =
      readNumber(input, 'default_negative_marks', { min: 0, max: 1, required: false }) ?? 0.25;
  }

  if ('show_leaderboard' in input) {
    patch.show_leaderboard = readBoolean(input, 'show_leaderboard') ?? true;
  }

  if ('is_premium' in input) {
    patch.is_premium = readBoolean(input, 'is_premium') ?? false;
  }

  if ('is_published' in input) {
    patch.is_published = readBoolean(input, 'is_published') ?? false;
  }

  if ('question_ids' in input) {
    patch.question_ids = readQuestionIds(input, { required: false }) ?? [];
  }

  if ('question_marks' in input) {
    if (!Array.isArray(patch.question_ids)) {
      throw new ExamAuthoringError('question_marks requires question_ids');
    }

    patch.question_marks = readQuestionMarks(input, patch.question_ids);
  }

  return patch;
};
