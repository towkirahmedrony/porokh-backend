/**
 * Pure request/response handling for AI question extraction.
 *
 * The importer converts every supported input (pasted text, photos, PDF pages,
 * CSV and TXT files) into one of two source kinds: readable text or an inline
 * image. The model is asked for the canonical Structured Plain Text format, so
 * this module only validates request limits and normalises that text; it never
 * parses questions into database objects (the import endpoint owns that).
 *
 * Everything here is deterministic and database-free, so the limits and the
 * plain-text rules can be tested without calling the provider.
 */

export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;

/** These inline image formats are accepted; anything else is rejected early. */
export const ACCEPTED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** One extraction call should never carry more than a few pages. */
export const MAX_SOURCES = 8;

/** Total readable text per call, kept below the model's context budget. */
export const MAX_TEXT_SOURCE_CHARS = 120_000;

export class ExtractionValidationError extends Error {
  status = 400;
  errorCode = 'VALIDATION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'ExtractionValidationError';
  }
}

type AnyObject = Record<string, unknown>;

const asRecord = (value: unknown): AnyObject | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyObject) : null;

const asText = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
};

export interface ExtractionTextSource {
  source_id: string;
  file_name: string;
  kind: 'text';
  /** Already-readable content (pasted text, CSV rows, PDF text or TXT file). */
  text: string;
}

export interface ExtractionImageSource {
  source_id: string;
  file_name: string;
  kind: 'image';
  mime_type: string;
  data: string;
}

export type ExtractionSource = ExtractionTextSource | ExtractionImageSource;

export interface ExtractionSourceHint {
  institution?: string;
  exam_name?: string;
  year?: string;
  subject?: string;
}

export interface ParsedExtractionRequest {
  sources: ExtractionSource[];
  sourceHint: ExtractionSourceHint;
}

/** Strips an optional data-URL prefix and whitespace from inline base64. */
const normalizeBase64 = (value: string): string =>
  (value.includes(';base64,') ? value.slice(value.indexOf(';base64,') + 8) : value).replace(/\s+/g, '');

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const decodedBytes = (base64: string): number => {
  // Buffer.from is lenient, so the alphabet and padding are checked first.
  if (base64.length % 4 !== 0 || !BASE64_PATTERN.test(base64)) return 0;

  try {
    return Buffer.from(base64, 'base64').length;
  } catch {
    return 0;
  }
};

/**
 * Validates an extraction request before any model call is made.
 *
 * The client applies the same limits, but the server is the authority because
 * client limits can be bypassed.
 */
export const parseExtractionRequest = (body: unknown): ParsedExtractionRequest => {
  const record = asRecord(body);

  if (!record) throw new ExtractionValidationError('Request body must be an object.');

  const rawSources = record.sources;

  if (!Array.isArray(rawSources) || rawSources.length === 0) {
    throw new ExtractionValidationError('At least one text or image source is required.');
  }

  if (rawSources.length > MAX_SOURCES) {
    throw new ExtractionValidationError(
      `At most ${MAX_SOURCES} sources can be extracted per request; split the batch into smaller parts.`
    );
  }

  const sources: ExtractionSource[] = [];
  const seenIds = new Set<string>();
  let totalImageBytes = 0;
  let totalTextChars = 0;

  rawSources.forEach((entry, position) => {
    const source = asRecord(entry);

    if (!source) {
      throw new ExtractionValidationError(`sources[${position}] must be an object.`);
    }

    const kind = asText(source.kind).toLowerCase();
    const sourceId = asText(source.source_id) || `source_${position + 1}`;

    if (seenIds.has(sourceId)) {
      throw new ExtractionValidationError(`Duplicate source_id "${sourceId}" in the request.`);
    }
    seenIds.add(sourceId);

    if (kind === 'text') {
      const text = typeof source.text === 'string' ? source.text : '';

      if (text.trim() === '') {
        throw new ExtractionValidationError(`sources[${position}].text is empty.`);
      }

      totalTextChars += text.length;
      if (totalTextChars > MAX_TEXT_SOURCE_CHARS) {
        throw new ExtractionValidationError(
          `The readable text exceeds ${MAX_TEXT_SOURCE_CHARS} characters; split it into smaller parts.`
        );
      }

      sources.push({
        source_id: sourceId,
        file_name: asText(source.file_name) || `text_${position + 1}`,
        kind: 'text',
        text,
      });
      return;
    }

    if (kind === 'image') {
      const data = typeof source.data === 'string' ? normalizeBase64(source.data) : '';
      if (!data) {
        throw new ExtractionValidationError(`sources[${position}] is missing base64 image data.`);
      }

      const mimeType = asText(source.mime_type).toLowerCase();
      if (!(ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
        throw new ExtractionValidationError(
          `sources[${position}].mime_type must be one of ${ACCEPTED_IMAGE_MIME_TYPES.join(', ')}.`
        );
      }

      const bytes = decodedBytes(data);
      if (bytes === 0) {
        throw new ExtractionValidationError(`sources[${position}] is not valid base64 data.`);
      }
      if (bytes > MAX_IMAGE_BYTES) {
        throw new ExtractionValidationError(
          `sources[${position}] exceeds the ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB per-image limit.`
        );
      }

      totalImageBytes += bytes;
      if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
        throw new ExtractionValidationError(
          `The images exceed the ${Math.round(MAX_TOTAL_IMAGE_BYTES / (1024 * 1024))}MB request limit.`
        );
      }

      sources.push({
        source_id: sourceId,
        file_name: asText(source.file_name) || `page_${position + 1}`,
        kind: 'image',
        mime_type: mimeType,
        data,
      });
      return;
    }

    throw new ExtractionValidationError(
      `sources[${position}].kind must be either "text" or "image".`
    );
  });

  if (!sources.some((source) => (source.kind === 'text' ? source.text.trim() : true))) {
    throw new ExtractionValidationError('No readable source content was supplied.');
  }

  const rawHint = asRecord(record.source_hint);
  const sourceHint: ExtractionSourceHint = {};

  if (rawHint) {
    for (const field of ['institution', 'exam_name', 'year', 'subject'] as const) {
      const value = asText(rawHint[field]);
      if (value) sourceHint[field] = value;
    }
  }

  return { sources, sourceHint };
};

export interface SanitizedPlainText {
  plain_text: string;
  question_count: number;
  warnings: string[];
}

const QUESTION_START = /^(?:@[A-Za-z]|Q(?:_BN|_EN)?\s*:)/;
const QUESTION_FIELD = /^Q(?:_BN|_EN)?\s*:/m;
const FENCE_LINE = /^\s*`{3,}[A-Za-z0-9_-]*\s*$/;

const normalizeBlock = (block: string): string =>
  block
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();

const blockKey = (block: string): string =>
  normalizeBlock(block).toLowerCase().replace(/\s+/g, ' ').replace(/\s*---\s*/g, '|');

/**
 * Normalises the model's plain-text answer.
 *
 * The model is told to return only question blocks, but chat models still
 * sometimes add a code fence, a sentence before the first block, or a block
 * twice. Those are removed here; question content itself is never rewritten.
 * `NONE` means the source had no eligible MCQ and becomes an empty string.
 */
export const sanitizePlainText = (raw: unknown): SanitizedPlainText => {
  const warnings: string[] = [];

  if (typeof raw !== 'string') {
    throw new ExtractionValidationError('The AI response was not plain text.');
  }

  let text = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !FENCE_LINE.test(line))
    .join('\n')
    .trim();

  if (/^none$/i.test(text)) {
    return { plain_text: '', question_count: 0, warnings };
  }

  // Drop any leading commentary before the first question or @header line.
  const lines = text.split('\n');
  const firstMeaningful = lines.findIndex((line) => QUESTION_START.test(line.trim()));
  if (firstMeaningful > 0) {
    warnings.push('Text before the first question was removed from the AI output.');
    text = lines.slice(firstMeaningful).join('\n').trim();
  }

  const blocks = text
    .split(/^\s*-{3,}\s*$/m)
    .map(normalizeBlock)
    .filter((block) => block !== '' && block.toUpperCase() !== 'NONE');

  const seen = new Set<string>();
  const kept: string[] = [];
  let duplicates = 0;

  for (const block of blocks) {
    const key = blockKey(block);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    kept.push(block);
  }

  if (duplicates > 0) {
    warnings.push(`${duplicates} duplicated question block(s) were removed from the AI output.`);
  }

  const questionCount = kept.filter((block) => QUESTION_FIELD.test(block)).length;

  if (questionCount === 0) {
    warnings.push('The AI output did not contain any question blocks in the expected format.');
  }

  return {
    plain_text:
      questionCount > 0 && kept.length > 0 ? `${kept.join('\n\n---\n\n')}\n` : '',
    question_count: questionCount,
    warnings,
  };
};

export interface ExtractionSourceResult {
  source_id: string;
  file_name: string;
  status: 'extracted' | 'empty';
}

/**
 * Derives per-source statuses. The plain-text answer is one document, so a
 * source is credited when the request produced any question at all.
 */
export const buildSourceResults = (
  sources: ExtractionSource[],
  questionCount: number
): ExtractionSourceResult[] =>
  sources.map((source) => ({
    source_id: source.source_id,
    file_name: source.file_name,
    status: questionCount > 0 ? 'extracted' : 'empty',
  }));
