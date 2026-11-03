import { MAX_PARSE_TEXT_LENGTH, type ParsedQuestion } from './question.textparse';

/**
 * Plain-text import contract.
 *
 * The importer submits one approved Structured Plain Text document. The
 * question content itself is parsed by `question.textparse`; this module only
 * validates the transport fields and attaches the curriculum ids the text
 * deliberately does not carry.
 *
 * Pure and database-free, like `question.import`.
 */

export class TextImportValidationError extends Error {
  status = 400;
  errorCode = 'VALIDATION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'TextImportValidationError';
  }
}

export interface TextImportTaxonomy {
  subject_id: string;
  chapter_id: string;
  topic_id?: string;
}

export interface TextImportRequest {
  text: string;
  taxonomy: TextImportTaxonomy;
}

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Reads `{ text, subject_id, chapter_id, topic_id }`.
 *
 * Subject and chapter are required because the database row cannot exist
 * without them; the plain text never carries database ids.
 */
export const readTextImportRequest = (body: unknown): TextImportRequest => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TextImportValidationError('Request body must be an object.');
  }

  const record = body as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text.trim() : '';

  if (text === '') {
    throw new TextImportValidationError('text is required.');
  }

  if (text.length > MAX_PARSE_TEXT_LENGTH) {
    throw new TextImportValidationError(
      `text is too long; submit at most ${MAX_PARSE_TEXT_LENGTH} characters at a time.`
    );
  }

  const subject_id = asText(record.subject_id);
  const chapter_id = asText(record.chapter_id);
  const topic_id = asText(record.topic_id);

  if (!subject_id) throw new TextImportValidationError('subject_id is required.');
  if (!chapter_id) throw new TextImportValidationError('chapter_id is required.');

  return {
    text,
    taxonomy: {
      subject_id,
      chapter_id,
      ...(topic_id ? { topic_id } : {}),
    },
  };
};

/**
 * Adds the selected curriculum ids to every parsed question. Nothing else is
 * changed: the parser already produced the canonical bilingual question shape.
 */
export const applyTextImportTaxonomy = (
  questions: ParsedQuestion[],
  taxonomy: TextImportTaxonomy
): Array<Record<string, unknown>> =>
  questions.map((question) => ({
    ...question,
    subject_id: taxonomy.subject_id,
    chapter_id: taxonomy.chapter_id,
    ...(taxonomy.topic_id ? { topic_id: taxonomy.topic_id } : {}),
  }));
