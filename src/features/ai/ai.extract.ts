/**
 * Pure request/response handling for AI question extraction.
 *
 * Everything here is deterministic and database-free, so the extraction rules
 * (limits, answer-key guard, uncertain-flag propagation) can be tested without
 * calling Gemini or a live project. The service layer owns the model call.
 */

type AnyObject = Record<string, unknown>;

export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** Phase 4 extracts one page per request; multi-page batches are not accepted. */
export const EXTRACT_IMAGE_COUNT = 1;

/** Gemini accepts these inline image formats; anything else is rejected early. */
export const ACCEPTED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const DIFFICULTY_LEVELS = ['easy', 'medium', 'hard', 'expert'] as const;

const SOURCE_TYPE_ALIASES: Record<string, string> = {
  board: 'board_exam',
  board_exam: 'board_exam',
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

const REFERENCE_KINDS = new Set([
  'board',
  'college',
  'university',
  'school',
  'admission',
  'book',
  'unknown',
]);

/**
 * Only these Gemini-reported answer sources may set `isCorrect`. Everything
 * else is left blank for a human, because an unprinted answer must never be
 * invented by the model.
 */
const TRUSTED_ANSWER_SOURCES = new Set(['printed', 'marked']);

export class ExtractionValidationError extends Error {
  status = 400;
  errorCode = 'VALIDATION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'ExtractionValidationError';
  }
}

const asRecord = (value: unknown): AnyObject | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyObject) : null;

const asText = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
};

const asInt = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
};

export interface ExtractionImageInput {
  image_id: string;
  file_name: string;
  mime_type: string;
  data: string;
}

export interface ExtractionSourceHint {
  institution?: string;
  exam_name?: string;
  year?: string;
  subject?: string;
}

export interface ParsedExtractionRequest {
  images: ExtractionImageInput[];
  sourceHint: ExtractionSourceHint;
}

/** Strips an optional data-URL prefix and whitespace from inline base64. */
const normalizeBase64 = (value: string): string =>
  (value.includes(';base64,') ? value.slice(value.indexOf(';base64,') + 8) : value).replace(/\s+/g, '');

const decodedBytes = (base64: string): number => {
  try {
    return Buffer.from(base64, 'base64').length;
  } catch {
    return 0;
  }
};

/**
 * Validates the extraction request before any model call is made.
 *
 * The limits mirror the importer's client-side limits; the server is the
 * authority because the client limits can be bypassed.
 */
export const parseExtractionRequest = (body: unknown): ParsedExtractionRequest => {
  const record = asRecord(body);

  if (!record) throw new ExtractionValidationError('Request body must be an object.');

  const rawImages = record.images;

  if (!Array.isArray(rawImages) || rawImages.length === 0) {
    throw new ExtractionValidationError('Exactly one question-paper image is required.');
  }

  if (rawImages.length !== EXTRACT_IMAGE_COUNT) {
    throw new ExtractionValidationError(
      'Only one question-paper image can be extracted per request. Remove the extra images.'
    );
  }

  const images: ExtractionImageInput[] = [];
  const seenIds = new Set<string>();

  rawImages.forEach((entry, position) => {
    const image = asRecord(entry);

    if (!image) {
      throw new ExtractionValidationError(`images[${position}] must be an object.`);
    }

    const data = typeof image.data === 'string' ? normalizeBase64(image.data) : '';
    if (!data) {
      throw new ExtractionValidationError(`images[${position}] is missing base64 data.`);
    }

    const mimeType = asText(image.mime_type).toLowerCase();
    if (!(ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
      throw new ExtractionValidationError(
        `images[${position}].mime_type must be one of ${ACCEPTED_IMAGE_MIME_TYPES.join(', ')}.`
      );
    }

    const bytes = decodedBytes(data);
    if (bytes === 0) {
      throw new ExtractionValidationError(`images[${position}] is not valid base64 data.`);
    }
    if (bytes > MAX_IMAGE_BYTES) {
      throw new ExtractionValidationError(
        `images[${position}] exceeds the ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB per-image limit.`
      );
    }

    const imageId = asText(image.image_id) || `image_${position + 1}`;
    if (seenIds.has(imageId)) {
      throw new ExtractionValidationError(`Duplicate image_id "${imageId}" in the request.`);
    }
    seenIds.add(imageId);

    images.push({
      image_id: imageId,
      file_name: asText(image.file_name) || `page_${position + 1}`,
      mime_type: mimeType,
      data,
    });
  });

  const rawHint = asRecord(record.source_hint);
  const sourceHint: ExtractionSourceHint = {};

  if (rawHint) {
    for (const field of ['institution', 'exam_name', 'year', 'subject'] as const) {
      const value = asText(rawHint[field]);
      if (value) sourceHint[field] = value;
    }
  }

  return { images, sourceHint };
};

export type ExtractionConfidence = 'high' | 'medium' | 'low';

export interface ExtractedQuestion {
  /** Number printed on the paper, kept verbatim so the original order survives. */
  question_number: string;
  type: 'mcq';
  body: { text_bn: string; text_en: string; image_url: string | null };
  options: Array<{ id: number; text_bn: string; text_en: string; isCorrect: boolean }>;
  explanation: { bn: string; en: string };
  difficulty_level: (typeof DIFFICULTY_LEVELS)[number];
  source_type: string;
  exam_references: AnyObject[];
  tags: string[];
  source_metadata?: { institution?: string; exam_name?: string; year?: string };
  requires_manual_answer_verification: boolean;
  uncertain_ocr_flags: string[];
  /** Server-side review indicator derived from the flags, never model-reported. */
  confidence: ExtractionConfidence;
  source_image_index: number;
}

export interface ExtractionRejection {
  index: number;
  source_image_index: number;
  reason: string;
}

export interface SanitizedModelOutput {
  questions: ExtractedQuestion[];
  rejected: ExtractionRejection[];
  batchSourceInfo: { institution?: string; exam_name?: string; year?: string };
  warnings: string[];
}

const normalizeSourceType = (value: unknown): string =>
  SOURCE_TYPE_ALIASES[asText(value).toLowerCase().replace(/[\s-]+/g, '_')] ?? 'unknown';

const normalizeDifficulty = (value: unknown): (typeof DIFFICULTY_LEVELS)[number] => {
  const raw = asText(value).toLowerCase();
  return (DIFFICULTY_LEVELS as readonly string[]).includes(raw)
    ? (raw as (typeof DIFFICULTY_LEVELS)[number])
    : 'medium';
};

const normalizeTags = (value: unknown): string[] => {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const tag = asText(entry);
    if (tag && !seen.has(tag)) seen.add(tag);
    if (seen.size >= 12) break;
  }

  return Array.from(seen);
};

const normalizeFlags = (value: unknown): string[] => {
  const raw = Array.isArray(value) ? value : [];
  return raw
    .map((entry) => asText(entry))
    .filter((flag) => flag !== '')
    .slice(0, 10);
};

const normalizeReferences = (value: unknown): AnyObject[] => {
  if (!Array.isArray(value)) return [];

  return value.slice(0, 3).flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) return [];

    const reference: AnyObject = {};

    for (const field of [
      'source_kind',
      'board',
      'institution_name',
      'institution_id',
      'unit_id',
      'unit_name',
      'exam_name',
      'year',
      'eiin',
      'code',
    ]) {
      const text = asText(record[field]);
      if (!text) continue;

      if (field === 'source_kind') {
        const kind = text.toLowerCase().replace(/[\s-]+/g, '_');
        reference.source_kind = REFERENCE_KINDS.has(kind) ? kind : 'unknown';
      } else {
        reference[field] = text;
      }
    }

    // A reference without any institution or board name cannot be traced and
    // would be rejected by the import endpoint, so it is dropped here.
    const hasName = Boolean(reference.board || reference.institution_name || reference.institution_id);
    return hasName ? [reference] : [];
  });
};

const normalizeSourceMetadata = (
  value: unknown,
  batch: { institution?: string; exam_name?: string; year?: string }
): ExtractedQuestion['source_metadata'] => {
  const record = asRecord(value) ?? {};
  const metadata = {
    institution: asText(record.institution) || batch.institution,
    exam_name: asText(record.exam_name) || batch.exam_name,
    year: asText(record.year) || batch.year,
  };

  const cleaned = Object.fromEntries(
    Object.entries(metadata).filter(([, entry]) => typeof entry === 'string' && entry !== '')
  ) as { institution?: string; exam_name?: string; year?: string };

  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
};

const sanitizeOptions = (value: unknown): Array<{
  id: number;
  text_bn: string;
  text_en: string;
  isCorrect: boolean;
}> | null => {
  if (!Array.isArray(value) || value.length < 2 || value.length > 6) return null;

  const options = value.map((entry, position) => {
    const record = asRecord(entry);
    if (!record) return null;

    const text_bn = asText(record.text_bn);
    if (!text_bn) return null;

    return {
      // Option ids are positional; a model-supplied id could reorder the key.
      id: position + 1,
      text_bn,
      text_en: asText(record.text_en),
      isCorrect: record.isCorrect === true,
    };
  });

  return options.every((option) => option !== null)
    ? (options as Array<{ id: number; text_bn: string; text_en: string; isCorrect: boolean }>)
    : null;
};

/**
 * Enforces "never invent a missing answer".
 *
 * Gemini may only keep an answer key when it says the answer was printed or
 * marked on the paper AND exactly one option is flagged. Any other combination
 * clears the key and asks the reviewer to choose, so an ambiguous or absent
 * answer can never be imported silently.
 */
const applyAnswerGuard = (
  options: ExtractedQuestion['options'],
  answerSource: unknown,
  existingFlags: string[]
): { options: ExtractedQuestion['options']; flags: string[]; requiresVerification: boolean } => {
  const flags = [...existingFlags];
  const source = asText(answerSource).toLowerCase();
  const marked = options.filter((option) => option.isCorrect).length;

  if (!TRUSTED_ANSWER_SOURCES.has(source)) {
    flags.push('answer_not_printed');
    return {
      options: options.map((option) => ({ ...option, isCorrect: false })),
      flags: Array.from(new Set(flags)),
      requiresVerification: true,
    };
  }

  if (marked !== 1) {
    flags.push('answer_ambiguous');
    return {
      options: options.map((option) => ({ ...option, isCorrect: false })),
      flags: Array.from(new Set(flags)),
      requiresVerification: true,
    };
  }

  return { options, flags: Array.from(new Set(flags)), requiresVerification: false };
};

type DraftQuestion = Omit<ExtractedQuestion, 'confidence'>;

type BatchSourceInfo = { institution?: string; exam_name?: string; year?: string };

const sanitizeQuestion = (
  raw: unknown,
  index: number,
  imageCount: number,
  batch: BatchSourceInfo
): DraftQuestion | { reason: string; source_image_index: number } => {
  const record = asRecord(raw);
  const fallbackImageIndex = 0;

  if (!record) {
    return { reason: 'Question entry is not an object.', source_image_index: fallbackImageIndex };
  }

  const sourceImageIndex = asInt(record.source_image_index, fallbackImageIndex);
  const clampedImageIndex =
    sourceImageIndex >= 0 && sourceImageIndex < imageCount ? sourceImageIndex : fallbackImageIndex;

  const bodyRecord = asRecord(record.body) ?? {};
  const text_bn = asText(bodyRecord.text_bn);
  const text_en = asText(bodyRecord.text_en);

  if (!text_bn) {
    return {
      reason: 'Question is missing Bengali text (body.text_bn).',
      source_image_index: clampedImageIndex,
    };
  }

  const options = sanitizeOptions(record.options);
  if (!options) {
    return {
      reason: 'Question needs 2-6 options with Bengali text.',
      source_image_index: clampedImageIndex,
    };
  }

  const flags = normalizeFlags(record.uncertain_ocr_flags);
  if (sourceImageIndex !== clampedImageIndex) {
    flags.push('source_image_index_out_of_range');
  }
  if (!text_en) flags.push('english_text_missing');

  // Anything other than the usual four options is kept but surfaced for a
  // human, because an incomplete option list is a quality signal.
  if (options.length !== 4) {
    flags.push(`option_count_unexpected: ${options.length}`);
  }

  const questionNumber = asText(record.question_number);
  if (!questionNumber) flags.push('question_number_missing');

  // A claimed printed answer without the quoted proving line is still kept,
  // but it is never trusted silently: the reviewer has to confirm it.
  const evidenceMissing = !asText(record.answer_evidence);
  if (evidenceMissing && !flags.includes('answer_not_printed')) {
    flags.push('answer_evidence_missing');
  }

  const guarded = applyAnswerGuard(options, record.answer_source, flags);
  const explanationRecord = asRecord(record.explanation) ?? {};
  const sourceMetadata = normalizeSourceMetadata(record.source_metadata, batch);

  if (!sourceMetadata) {
    // Not a confidence signal by itself (many papers do not print a source),
    // but the reviewer must still see that the metadata was not detected.
    guarded.flags.push('source_metadata_not_detected');
  }

  return {
    question_number: questionNumber,
    type: 'mcq',
    body: {
      text_bn,
      text_en,
      image_url: null,
    },
    options: guarded.options,
    explanation: {
      bn: asText(explanationRecord.bn),
      en: asText(explanationRecord.en),
    },
    difficulty_level: normalizeDifficulty(record.difficulty_level),
    source_type: normalizeSourceType(record.source_type),
    exam_references: normalizeReferences(record.exam_references),
    tags: normalizeTags(record.tags),
    ...(sourceMetadata ? { source_metadata: sourceMetadata } : {}),
    requires_manual_answer_verification:
      guarded.requiresVerification || (evidenceMissing && guarded.options.some((option) => option.isCorrect)),
    uncertain_ocr_flags: guarded.flags,
    source_image_index: clampedImageIndex,
  };
};

/**
 * Flags that make a question unreliable enough to need a careful human read.
 * Confidence is derived here, so the model cannot talk its way to "high".
 */
const LOW_CONFIDENCE_PATTERN =
  /illegible|unreadable|ambiguous|missing|cropped|unexpected|boundary|merged|incomplete|duplicate/i;

const deriveConfidence = (question: DraftQuestion): ExtractionConfidence => {
  if (question.requires_manual_answer_verification) return 'low';
  if (question.uncertain_ocr_flags.some((flag) => LOW_CONFIDENCE_PATTERN.test(flag))) return 'low';
  return question.uncertain_ocr_flags.length > 0 ? 'medium' : 'high';
};

/**
 * Cross-question checks that need the whole page: duplicate printed numbers and
 * out-of-order numbering usually mean two questions were merged or a boundary
 * was missed, so they are reported instead of silently trusting the model.
 */
const finalizeQuestions = (
  drafts: DraftQuestion[]
): { questions: ExtractedQuestion[]; warnings: string[] } => {
  const warnings: string[] = [];
  const positionsByNumber = new Map<string, number[]>();

  drafts.forEach((question, index) => {
    if (!question.question_number) return;
    const positions = positionsByNumber.get(question.question_number) ?? [];
    positions.push(index);
    positionsByNumber.set(question.question_number, positions);
  });

  for (const [number, positions] of positionsByNumber) {
    if (positions.length < 2) continue;

    warnings.push(
      `Question number ${number} appears ${positions.length} times; check the question boundaries on the image.`
    );

    for (const index of positions) {
      drafts[index].uncertain_ocr_flags = Array.from(
        new Set([...drafts[index].uncertain_ocr_flags, `duplicate_question_number: ${number}`])
      );
    }
  }

  const numericNumbers = drafts
    .map((question) => Number.parseInt(question.question_number, 10))
    .filter((value) => Number.isFinite(value));

  const outOfOrder = numericNumbers.some((value, index) => index > 0 && value < numericNumbers[index - 1]);
  if (outOfOrder) {
    warnings.push('Questions are not in the printed numerical order; the original order was kept.');
  }

  return {
    questions: drafts.map((question) => ({ ...question, confidence: deriveConfidence(question) })),
    warnings,
  };
};

/**
 * Turns the raw model JSON into the importer's exact question shape.
 *
 * Malformed questions are rejected individually so one unreadable item does not
 * discard the rest of a page.
 */
export const sanitizeModelOutput = (
  raw: unknown,
  imageCount: number
): SanitizedModelOutput => {
  const record = asRecord(raw);

  if (!record || !Array.isArray(record.questions)) {
    throw new Error('The AI response did not contain a questions array.');
  }

  const batchRecord = asRecord(record.batch_source_info) ?? {};
  const batchSourceInfo = {
    institution: asText(batchRecord.institution),
    exam_name: asText(batchRecord.exam_name),
    year: asText(batchRecord.year),
  };

  const cleanedBatch = Object.fromEntries(
    Object.entries(batchSourceInfo).filter(([, value]) => value !== '')
  ) as { institution?: string; exam_name?: string; year?: string };

  const drafts: DraftQuestion[] = [];
  const rejected: ExtractionRejection[] = [];

  record.questions.forEach((entry, index) => {
    const result = sanitizeQuestion(entry, index, imageCount, cleanedBatch);

    if ('reason' in result) {
      rejected.push({ index, source_image_index: result.source_image_index, reason: result.reason });
      return;
    }

    drafts.push(result);
  });

  const finalized = finalizeQuestions(drafts);
  const warnings = [...finalized.warnings];

  finalized.questions.forEach((question, position) => {
    if (question.requires_manual_answer_verification) {
      warnings.push(`Question #${position + 1}: the answer key needs manual confirmation.`);
    }
  });

  if (rejected.length > 0) {
    warnings.push(
      `${rejected.length} question(s) could not be read completely and need a manual re-check of the image.`
    );
  }

  if (finalized.questions.length === 0) {
    warnings.push('No questions could be read from the supplied image.');
  }

  return {
    questions: finalized.questions,
    rejected,
    batchSourceInfo: cleanedBatch,
    warnings,
  };
};

export interface ExtractionImageResult {
  image_id: string;
  file_name: string;
  status: 'extracted' | 'empty';
  question_count: number;
}

/** Derives per-image statuses from the questions that cite each image. */
export const buildImageResults = (
  images: ExtractionImageInput[],
  questions: ExtractedQuestion[]
): ExtractionImageResult[] =>
  images.map((image, position) => {
    const question_count = questions.filter(
      (question) => question.source_image_index === position
    ).length;

    return {
      image_id: image.image_id,
      file_name: image.file_name,
      status: question_count > 0 ? 'extracted' : 'empty',
      question_count,
    };
  });
