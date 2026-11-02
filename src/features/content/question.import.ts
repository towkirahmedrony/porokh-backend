import { buildQuestionContentHash, decideQuestionWrite } from './question.policy';

/**
 * Validation and duplicate planning for the AI Question Importer.
 *
 * The importer submits the same bilingual payload shape the admin panel uses
 * (`type`, `body`, `options`, `explanation`, `difficulty_level`, `source_type`,
 * `exam_references`, `tags` plus the curriculum ids). Everything here is pure:
 * the service layer owns database access, so the rules can be tested without a
 * live project.
 */

type AnyObject = Record<string, unknown>;

/** Matches the `questions_source_type_check` constraint on the live table. */
export const IMPORT_SOURCE_TYPES = [
  'board_exam',
  'admission',
  'college_test',
  'model_test',
  'textbook',
  'guidebook',
  'school_exam',
  'university_exam',
  'unknown',
] as const;

export type ImportSourceType = (typeof IMPORT_SOURCE_TYPES)[number];

/** Matches the `questions_difficulty_level_check` constraint. */
export const IMPORT_DIFFICULTY_LEVELS = ['easy', 'medium', 'hard', 'expert'] as const;

/** Same keys the admin panel's exam reference editor reads and writes. */
export const IMPORT_REFERENCE_KINDS = [
  'board',
  'college',
  'university',
  'school',
  'admission',
  'book',
  'unknown',
] as const;

export const MAX_IMPORT_BATCH_SIZE = 500;

const SOURCE_TYPE_ALIASES: Record<string, ImportSourceType> = {
  board: 'board_exam',
  board_exam: 'board_exam',
  boardexam: 'board_exam',
  admission: 'admission',
  admission_test: 'admission',
  college_test: 'college_test',
  model_test: 'model_test',
  textbook: 'textbook',
  guidebook: 'guidebook',
  school: 'school_exam',
  school_exam: 'school_exam',
  university_exam: 'university_exam',
  other: 'unknown',
  unknown: 'unknown',
};

const REFERENCE_KIND_ALIASES: Record<string, string> = {
  madrasa: 'board',
  madrasah: 'board',
  school_and_college: 'school',
};

const REFERENCE_NAME_FIELDS = ['board', 'institution_name', 'name'] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const YEAR_PATTERN = /^(?:19|20)\d{2}(?:\s*[-–]\s*\d{2,4})?$/;

export class ImportValidationError extends Error {
  status = 400;
  errorCode = 'VALIDATION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'ImportValidationError';
  }
}

const asRecord = (value: unknown): AnyObject | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyObject)
    : null;

const asText = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
};

const parseJsonRecord = (value: string): AnyObject | null => {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
};

export interface NormalizedImportQuestion {
  /** Position in the submitted array; result rows point back with this index. */
  index: number;
  payload: AnyObject;
  errors: string[];
  warnings: string[];
  content_hash?: string;
}

export interface ImportPlanRow {
  index: number;
  action: 'insert' | 'duplicate' | 'invalid';
  existing_id?: string;
  errors: string[];
  warnings: string[];
}

export interface ImportPlanCounts {
  total: number;
  insert: number;
  duplicate: number;
  invalid: number;
}

const normalizeOptions = (
  value: unknown,
  errors: string[],
  warnings: string[]
): AnyObject[] => {
  if (!Array.isArray(value)) {
    errors.push('options must be an array of answer choices.');
    return [];
  }

  if (value.length < 2) {
    errors.push('At least 2 options are required for an MCQ.');
  }

  const options: AnyObject[] = [];

  value.forEach((entry, position) => {
    const record = asRecord(entry);
    if (!record) {
      errors.push(`Option #${position + 1} must be an object.`);
      return;
    }

    const text_bn = asText(record.text_bn);
    const text_en = asText(record.text_en);
    const image_url = asText(record.image_url);

    if (!text_bn) errors.push(`Option #${position + 1} is missing Bengali text (text_bn).`);
    if (!text_en) warnings.push(`Option #${position + 1} is missing English text (text_en).`);

    options.push({
      // Option ids are regenerated from the submitted order so a partially
      // correct upstream id can never reorder the answer key.
      id: options.length + 1,
      text_bn,
      text_en,
      ...(image_url ? { image_url } : {}),
      isCorrect: record.isCorrect === true,
    });
  });

  const correctCount = options.filter((option) => option.isCorrect === true).length;

  if (correctCount === 0) {
    errors.push('No correct option is marked. Set exactly one isCorrect: true.');
  } else if (correctCount > 1) {
    errors.push(`${correctCount} options are marked as correct; an MCQ needs exactly one.`);
  }

  return options;
};

const normalizeExplanation = (
  value: unknown,
  warnings: string[]
): { bn: string; en: string } | undefined => {
  if (value === undefined || value === null || value === '') return undefined;

  const record = typeof value === 'string' ? parseJsonRecord(value) : asRecord(value);

  if (!record) {
    warnings.push('explanation must be an object with bn/en text.');
    return undefined;
  }

  const bn = asText(record.bn) || asText(record.text_bn);
  const en = asText(record.en) || asText(record.text_en);

  if (!bn && !en) return undefined;

  return { bn, en };
};

const normalizeReference = (
  entry: unknown,
  position: number,
  errors: string[],
  warnings: string[]
): AnyObject | null => {
  const record = asRecord(entry);

  if (!record) {
    errors.push(`exam_references[${position}] must be a reference object.`);
    return null;
  }

  const reference: AnyObject = {};

  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) reference[key] = trimmed;
      continue;
    }
    reference[key] = value;
  }

  const rawKind = asText(reference.source_kind).toLowerCase().replace(/[\s-]+/g, '_');

  if (rawKind) {
    const kind = REFERENCE_KIND_ALIASES[rawKind] ?? rawKind;
    if (!(IMPORT_REFERENCE_KINDS as readonly string[]).includes(kind)) {
      errors.push(`exam_references[${position}].source_kind "${rawKind}" is not supported.`);
    } else {
      reference.source_kind = kind;
    }
  }

  for (const field of ['institution_id', 'unit_id'] as const) {
    const id = asText(reference[field]);
    if (id && !UUID_PATTERN.test(id)) {
      errors.push(`exam_references[${position}].${field} must be a UUID.`);
    }
  }

  const hasName = REFERENCE_NAME_FIELDS.some((field) => asText(reference[field]) !== '');
  if (!hasName && !asText(reference.institution_id)) {
    errors.push(
      `exam_references[${position}] needs a board or institution name (or an institution_id).`
    );
  }

  if (reference.year !== undefined) {
    const year = asText(reference.year);
    if (!year) {
      delete reference.year;
    } else {
      reference.year = year;
      if (!YEAR_PATTERN.test(year)) {
        warnings.push(`exam_references[${position}].year "${year}" is not a 4-digit year.`);
      }
    }
  }

  return reference;
};

const normalizeReferences = (
  value: unknown,
  errors: string[],
  warnings: string[]
): AnyObject[] => {
  if (value === undefined || value === null || value === '') return [];

  const parsed = typeof value === 'string' ? parseJsonRecordArray(value) : value;

  if (!Array.isArray(parsed)) {
    errors.push('exam_references must be an array of reference objects.');
    return [];
  }

  return parsed
    .map((entry, position) => normalizeReference(entry, position, errors, warnings))
    .filter((entry): entry is AnyObject => entry !== null);
};

function parseJsonRecordArray(value: string): unknown[] | null {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    const record = asRecord(parsed);
    return record ? [record] : null;
  } catch {
    return null;
  }
}

const normalizeTags = (value: unknown): string[] => {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const entry of raw) {
    const tag = asText(entry);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }

  return tags;
};

const normalizeSourceType = (
  value: unknown,
  errors: string[],
  warnings: string[]
): ImportSourceType => {
  const raw = asText(value).toLowerCase().replace(/[\s-]+/g, '_');

  if (!raw) {
    warnings.push('source_type is missing; stored as "unknown".');
    return 'unknown';
  }

  const mapped = SOURCE_TYPE_ALIASES[raw];

  if (!mapped) {
    errors.push(`source_type "${raw}" is not a supported source type.`);
    return 'unknown';
  }

  return mapped;
};

const normalizeDifficulty = (value: unknown, errors: string[]): string => {
  const raw = asText(value).toLowerCase();
  if (!raw) return 'medium';

  if (!(IMPORT_DIFFICULTY_LEVELS as readonly string[]).includes(raw)) {
    errors.push(`difficulty_level "${raw}" must be one of ${IMPORT_DIFFICULTY_LEVELS.join(', ')}.`);
    return 'medium';
  }

  return raw;
};

/**
 * Normalises one submitted question into the payload that will be inserted.
 *
 * `isCorrect` is copied verbatim from the submitted options (only an explicit
 * `true` counts) and option ids are regenerated from position, so the answer
 * key survives the round trip unchanged.
 */
export const normalizeImportQuestion = (
  input: unknown,
  index: number,
  role?: string | null
): NormalizedImportQuestion => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const record = asRecord(input);

  if (!record) {
    return {
      index,
      payload: {},
      errors: ['Question must be an object.'],
      warnings,
    };
  }

  const type = asText(record.type).toLowerCase() || 'mcq';
  if (type !== 'mcq') {
    errors.push(`Question type "${type}" is not supported; only mcq can be imported.`);
  }

  const bodyRecord = asRecord(record.body);
  const text_bn = asText(bodyRecord?.text_bn);
  const text_en = asText(bodyRecord?.text_en);
  const image_url = asText(bodyRecord?.image_url);

  if (!text_bn) errors.push('body.text_bn (Bengali question text) is required.');

  if (!text_en) {
    warnings.push('body.text_en (English question text) is empty; bilingual text is recommended.');
  }

  const options = normalizeOptions(record.options, errors, warnings);
  const explanation = normalizeExplanation(record.explanation, warnings);
  const difficulty_level = normalizeDifficulty(record.difficulty_level, errors);
  const source_type = normalizeSourceType(record.source_type, errors, warnings);
  const exam_references = normalizeReferences(record.exam_references, errors, warnings);
  const tags = normalizeTags(record.tags);

  const subject_id = asText(record.subject_id);
  const chapter_id = asText(record.chapter_id);
  const topic_id = asText(record.topic_id);

  if (!subject_id) errors.push('subject_id is required.');
  if (!chapter_id) errors.push('chapter_id is required.');
  if (!topic_id) warnings.push('topic_id is missing; the question is not linked to a topic.');

  const candidate: AnyObject = {
    type: 'mcq',
    body: {
      text_bn,
      text_en,
      image_url: image_url || null,
    },
    options,
    ...(explanation ? { explanation } : {}),
    difficulty_level,
    source_type,
    exam_references,
    tags,
    subject_id,
    chapter_id,
    ...(topic_id ? { topic_id } : {}),
  };

  // The create policy allow-lists the persisted fields and decides the status
  // from the verified role, exactly as the single-question endpoint does.
  const { payload } = decideQuestionWrite({ role, body: candidate, mode: 'create' });

  return { index, payload, errors, warnings };
};

export const normalizeImportQuestions = (
  input: unknown,
  role?: string | null
): NormalizedImportQuestion[] => {
  if (!Array.isArray(input)) {
    throw new ImportValidationError('questions must be an array.');
  }

  if (input.length === 0) {
    throw new ImportValidationError('questions array is empty.');
  }

  if (input.length > MAX_IMPORT_BATCH_SIZE) {
    throw new ImportValidationError(
      `A single import batch may contain at most ${MAX_IMPORT_BATCH_SIZE} questions.`
    );
  }

  return input.map((item, index) => normalizeImportQuestion(item, index, role));
};

/**
 * Copies backend-resolved exam references onto each payload and computes the
 * canonical content hash afterwards, because `exam_references` is one of the
 * hashed fields.
 */
export const assignResolvedExamReferences = (
  items: NormalizedImportQuestion[],
  resolvedLists: Array<unknown[] | null | undefined>
): NormalizedImportQuestion[] =>
  items.map((item, position) => {
    const resolved = resolvedLists[position];
    if (resolved !== undefined) item.payload.exam_references = resolved;
    return item;
  });

/** Computes the shared duplicate-detection hash for every valid question. */
export const withContentHashes = (
  items: NormalizedImportQuestion[]
): NormalizedImportQuestion[] =>
  items.map((item) => ({
    ...item,
    content_hash:
      item.errors.length === 0 ? buildQuestionContentHash(item.payload) : undefined,
  }));

export const importPlanCounts = (rows: ImportPlanRow[]): ImportPlanCounts => ({
  total: rows.length,
  insert: rows.filter((row) => row.action === 'insert').length,
  duplicate: rows.filter((row) => row.action === 'duplicate').length,
  invalid: rows.filter((row) => row.action === 'invalid').length,
});

/**
 * Decides each question's fate before any insert.
 *
 * A question is a duplicate when the same subject already holds a row with the
 * same canonical `content_hash`, or when an earlier question in this batch
 * already claimed that hash. Nothing is overwritten: duplicates are reported
 * and skipped.
 */
export const planImportBatch = (
  items: NormalizedImportQuestion[],
  existingBySubject: Map<string, Map<string, string>> = new Map()
): ImportPlanRow[] => {
  const claimed = new Map<string, number>();

  return items.map((item) => {
    const base = {
      index: item.index,
      errors: item.errors,
      warnings: item.warnings,
    };

    if (item.errors.length > 0 || !item.content_hash) {
      return { ...base, action: 'invalid' as const };
    }

    const subject = String(item.payload.subject_id ?? '');
    const key = `${subject}::${item.content_hash}`;

    const existingId = existingBySubject.get(subject)?.get(item.content_hash);
    if (existingId) {
      return { ...base, action: 'duplicate' as const, existing_id: existingId };
    }

    const firstIndex = claimed.get(key);
    if (firstIndex !== undefined) {
      return {
        ...base,
        action: 'duplicate' as const,
        errors: [`Duplicate of question #${firstIndex + 1} in this batch.`],
      };
    }

    claimed.set(key, item.index);
    return { ...base, action: 'insert' as const };
  });
};
