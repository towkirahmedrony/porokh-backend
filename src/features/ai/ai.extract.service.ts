import logger from '../../lib/utils/logger';
import {
  ExtractionProviderError,
  callExtractionProvider,
  readExtractionProviderConfig,
  type ExtractionProviderConfig,
  type ExtractionProviderPart,
} from './ai.extract.provider';
import {
  buildSourceResults,
  parseExtractionRequest,
  sanitizePlainText,
  type ExtractionSourceResult,
  type ExtractionSource,
} from './ai.extract';

/**
 * Extraction of bilingual MCQs from mixed source content.
 *
 * The importer converts pasted text, photos, PDF pages, CSV and TXT files into
 * readable text or inline images, then calls this endpoint. The model is asked
 * for the canonical Structured Plain Text document; no question JSON crosses
 * the API boundary.
 *
 * The model call goes through the dedicated extraction Gemini project
 * (`EXTRACTION_GEMINI_API_KEY`), so the student AI Assistant's Gemini project and
 * quota are never used.
 */

const REQUEST_TIMEOUT_MS = 90_000;

export class ExtractionServiceError extends Error {
  status: number;
  errorCode: string;

  constructor(message: string, status: number, errorCode = 'EXTRACTION_FAILED') {
    super(message);
    this.name = 'ExtractionServiceError';
    this.status = status;
    this.errorCode = errorCode;
  }
}

const SYSTEM_INSTRUCTION = `You are a precise exam-paper digitisation engine for a Bangladeshi bilingual question bank (Bangla and English).
Read every supplied source (readable text and/or page images) and return the eligible multiple-choice questions as the Structured Plain Text format described below. Reply with plain text only: no JSON, no markdown, no code fences, no commentary.

WHAT TO EXTRACT
- Only complete university admission MCQs: public university, engineering, medical and dental, agricultural, GST, and private university admission tests, admission model tests and admission guidebooks.
- Skip HSC, SSC and board examination questions.
- Skip non-MCQ content, instructions, headers, adverts and answer-key-only pages.
- Skip a question when it is incomplete, unreadable, or depends on a diagram whose required information is missing.
- Never invent questions, options, institutions, years or units, and never guess an answer.
- Prefer an answer printed or clearly marked in the source. Solve a question yourself only when you are completely confident. If the answer is unknown, omit the ANS field for that question instead of guessing.
- Preserve the original option order and the original meaning. Correct obvious OCR mistakes only when the meaning is unchanged.
- Remove duplicate questions.
- Preserve mathematical notation exactly: use LaTeX between $...$ for inline math, keep symbols (±, √, °, ×, ÷, ⇒, ⇌), subscripts, superscripts, chemical formulas and units.
- Preserve statement-based questions and their continuation lines exactly; a line that does not look like a KEY: value field belongs to the field above it.

OUTPUT FORMAT (canonical)
Write optional metadata lines, then the question fields, then separate consecutive question blocks with a line containing only ---.

Metadata (only when supported by the source):
@source: admission | model_test | guidebook | unknown
@institution: full official English institution name
@exam: exam name
@unit: unit label
@year: academic year, for example 2022-23
@tags: comma separated common tags

Question fields:
Q_BN: Bengali question
Q_EN: English question
A_BN / A_EN, B_BN / B_EN, C_BN / C_EN, D_BN / D_EN: bilingual options in printed order
E_BN / E_EN, F_BN / F_EN: optional extra options
ANS: one correct answer letter (A-F), only when confirmed
EXP_BN: concise Bengali explanation
EXP_EN: concise English explanation
DIFF: easy | medium | hard | expert
TAGS: 3-8 lowercase English topic tags

Rules for the format:
- Do not number questions. Do not add Markdown or code fences. Do not add introductory or concluding commentary.
- If institution, year or unit changes later in a document, write the new @ metadata before the questions it applies to.
- If a source contains no eligible question, reply with exactly NONE.

EXAMPLE
@source: guidebook
@institution: Rajshahi University
@year: 2022-23
@tags: biology, cell biology

Q_BN: কোষ ঝিল্লির মোট শুষ্ক ওজনের কত ভাগ লিপিড?
Q_EN: What percentage of the total dry weight of the cell membrane is lipid?
A_BN: প্রায় 50 ভাগ
A_EN: About 50%
B_BN: প্রায় 75 ভাগ
B_EN: About 75%
C_BN: প্রায় 90 ভাগ
C_EN: About 90%
D_BN: প্রায় 25 ভাগ
D_EN: About 25%
ANS: B
EXP_BN: কোষ ঝিল্লির মোট শুষ্ক ওজনের প্রায় 75% লিপিড।
EXP_EN: Lipids make up about 75% of the total dry weight of the cell membrane.
DIFF: medium
TAGS: biology, cell biology, cell membrane`;

const MIME_LABELS: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
};

const buildParts = (
  sources: ExtractionSource[],
  hint: { institution?: string; exam_name?: string; year?: string; subject?: string }
): ExtractionProviderPart[] => {
  const hintLines = [
    hint.institution ? `Institution/board hint: ${hint.institution}` : '',
    hint.exam_name ? `Exam name hint: ${hint.exam_name}` : '',
    hint.year ? `Year hint: ${hint.year}` : '',
    hint.subject ? `Subject hint: ${hint.subject}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const parts: ExtractionProviderPart[] = [
    {
      kind: 'text',
      text:
        'Extract the eligible admission MCQs from the sources below and return only the Structured Plain Text document.' +
        (hintLines
          ? `\nThe uploader supplied these hints; use them only when the sources are consistent with them:\n${hintLines}`
          : '') +
        `\nThe request contains ${sources.length} source(s). Keep source boundaries: never merge questions from different sources.`,
    },
  ];

  sources.forEach((source, index) => {
    const label =
      source.kind === 'text'
        ? `--- SOURCE ${index + 1}/${sources.length}: "${source.file_name}" (extracted text) ---`
        : `--- SOURCE ${index + 1}/${sources.length}: "${source.file_name}" (${
            MIME_LABELS[source.mime_type] ?? source.mime_type
          } image) ---`;

    parts.push({ kind: 'text', text: label });

    if (source.kind === 'text') {
      parts.push({ kind: 'text', text: source.text });
    } else {
      parts.push({ kind: 'image', image: { mime_type: source.mime_type, data: source.data } });
    }
  });

  parts.push({
    kind: 'text',
    text: 'Respond with the Structured Plain Text document only, or exactly NONE when no eligible question exists.',
  });

  return parts;
};

/** Maps a provider failure to a safe HTTP status and machine-readable code. */
const mapProviderError = (error: ExtractionProviderError): ExtractionServiceError => {
  switch (error.failure) {
    case 'not_configured':
      return new ExtractionServiceError(
        'The AI extraction service is not configured.',
        503,
        'EXTRACTION_NOT_CONFIGURED'
      );
    case 'timeout':
      return new ExtractionServiceError(
        'The AI extraction timed out. Try a smaller source or retry.',
        504,
        'EXTRACTION_TIMEOUT'
      );
    case 'rate_limited':
      return new ExtractionServiceError(
        'The AI service is busy right now. Please wait a moment and retry.',
        429,
        'EXTRACTION_RATE_LIMITED'
      );
    case 'invalid_response':
      return new ExtractionServiceError(
        'The AI response could not be read. Please retry.',
        502,
        'EXTRACTION_INVALID_RESPONSE'
      );
    default:
      return new ExtractionServiceError(
        'The AI extraction service is unavailable. Please retry.',
        502,
        'EXTRACTION_UNAVAILABLE'
      );
  }
};

export interface ExtractionServiceResult {
  model: string;
  plain_text: string;
  question_count: number;
  sources: ExtractionSourceResult[];
  warnings: string[];
}

/**
 * Extracts the eligible admission MCQs from the supplied sources and returns
 * one Structured Plain Text document. Nothing is written to the database.
 */
export const extractQuestionsFromSources = async (
  body: unknown
): Promise<ExtractionServiceResult> => {
  const request = parseExtractionRequest(body);

  let config: ExtractionProviderConfig;
  try {
    config = readExtractionProviderConfig();
  } catch (error) {
    // Never include the value or any part of it in the message.
    logger.error('[ai:extract] EXTRACTION_GEMINI_API_KEY is not configured');
    throw error instanceof ExtractionProviderError ? mapProviderError(error) : error;
  }

  let text: string;
  try {
    const result = await callExtractionProvider({
      config,
      systemInstruction: SYSTEM_INSTRUCTION,
      parts: buildParts(request.sources, request.sourceHint),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    text = result.text;
  } catch (error) {
    if (error instanceof ExtractionProviderError) {
      if (error.failure !== 'not_configured') {
        // Log the normalised failure only: never the key, the source or the body.
        logger.error(`[ai:extract] provider failure: ${error.failure}`);
      }
      throw mapProviderError(error);
    }
    throw mapProviderError(
      new ExtractionProviderError('The AI extraction provider failed.', 'unavailable')
    );
  }

  let sanitized;
  try {
    sanitized = sanitizePlainText(text);
  } catch {
    logger.error('[ai:extract] provider response was not plain text');
    throw new ExtractionServiceError(
      'The AI response could not be read. Please retry.',
      502,
      'EXTRACTION_INVALID_RESPONSE'
    );
  }

  return {
    model: config.model,
    plain_text: sanitized.plain_text,
    question_count: sanitized.question_count,
    sources: buildSourceResults(request.sources, sanitized.question_count),
    warnings: sanitized.warnings,
  };
};
