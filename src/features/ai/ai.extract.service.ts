import logger from '../../lib/utils/logger';
import {
  ExtractionProviderError,
  callExtractionProvider,
  readExtractionProviderConfig,
  type ExtractionProviderConfig,
} from './ai.extract.provider';
import {
  buildImageResults,
  parseExtractionRequest,
  sanitizeModelOutput,
  type ExtractionImageInput,
  type ExtractionRejection,
  type ExtractionSourceHint,
  type ExtractedQuestion,
  type ExtractionImageResult,
} from './ai.extract';

/**
 * Extraction of bilingual MCQs from a single question-paper image.
 *
 * The model call goes through the dedicated extraction Gemini project
 * (`EXTRACTION_GEMINI_API_KEY`), so the student AI Assistant's Gemini project and
 * quota are never used. Whatever comes back is re-validated by `ai.extract`
 * before it reaches the importer.
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
Read every multiple-choice question (MCQ) from the supplied question-paper image in order.

Transcription rules:
- Return each question once, in original reading order. source_image_index is always 0 because one page is supplied per request.
- Set question_number to the number printed next to the question (for example "3" or "3(a)"). Never renumber and never invent a number; leave it empty if no number is printed.
- Treat each printed question as its own item. Never merge two questions into one item, and never split one question into two items.
- body.text_bn must be the Bengali question text; body.text_en must be the English question text. If the paper is printed in only one language, translate the other faithfully. Never change the meaning, numbers, or answer options.
- Preserve mathematical and scientific notation exactly: use LaTeX between $...$ for inline math and $$...$$ for display math, keeping symbols (±, √, °, ×, ÷, ⇒, ⇌), subscripts, superscripts, chemical formulas and units. Do not "simplify" or round anything.
- Keep option order exactly as printed. Extract every printed option; do not add or drop options.
- If a question refers to a diagram or image, describe the reference inside the text (for example "[চিত্র ২]") and add the flag "diagram_required: figure 2".

Answer-key rules (critical):
- Set isCorrect true ONLY for an option confirmed by a printed answer key or a clearly marked answer (tick, circle, cross-out, filled bubble).
- answer_source must be "printed" (answer printed separately on the paper), "marked" (answer marked on the question), "none" (no answer visible) or "ambiguous" (marking is unclear or contradicts itself).
- answer_evidence must quote the exact text/line that proves the answer. Leave it empty when there is no printed or marked answer.
- NEVER solve the question yourself and NEVER guess. If no answer is printed or clearly marked, mark every option isCorrect=false and answer_source="none".
- If the confirmable answer is unclear, use answer_source="ambiguous" with isCorrect=false on every option.

Explanations:
- Write a short, correct explanation in both explanation.bn (Bangla) and explanation.en (English).
- If the answer key is absent or ambiguous, explain the concept/method without asserting which option is correct.

Metadata:
- batch_source_info and each question's exam_references should carry the board/institution, exam name and year printed on the paper. Use source_kind "board" for education boards, "college" for college tests, "university" for university admissions, "school" for school exams, else "unknown". Omit fields that are not printed; never invent them.
- source_type must be one of: board_exam, admission, college_test, model_test, textbook, guidebook, school_exam, university_exam, unknown.
- difficulty_level must be one of: easy, medium, hard, expert.

Uncertainty:
- Put concrete OCR/visual problems in uncertain_ocr_flags (for example "illegible_text: option C", "diagram_required: figure 2", "cropped_margin").
- Set requires_manual_answer_verification=true whenever the answer key needs a human check.
- Add a flag for every unreadable or incomplete part (for example "illegible_text: option C", "missing_option", "incomplete_question", "merged_question_boundary"). Never silently drop a partially readable question.

Output format:
- Reply with one JSON object and nothing else: no markdown fences, no commentary.
- Shape: {"batch_source_info":{"institution":"","exam_name":"","year":""},"questions":[{"question_number":"","body":{"text_bn":"","text_en":""},"options":[{"text_bn":"","text_en":"","isCorrect":false}],"explanation":{"bn":"","en":""},"difficulty_level":"medium","source_type":"unknown","exam_references":[{"source_kind":"unknown","board":"","institution_name":"","exam_name":"","year":""}],"tags":[""],"answer_source":"none","answer_evidence":"","requires_manual_answer_verification":true,"uncertain_ocr_flags":[""],"source_image_index":0}]}
- Every field above is required on every question, even when its value is empty.`;

const IMAGE_MIME_LABELS: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
};

const buildPrompt = (image: ExtractionImageInput, hint: ExtractionSourceHint): string => {
  const imageLabel = `"${image.file_name}" (${IMAGE_MIME_LABELS[image.mime_type] ?? image.mime_type})`;

  const hintLines = [
    hint.institution ? `Institution/board hint: ${hint.institution}` : '',
    hint.exam_name ? `Exam name hint: ${hint.exam_name}` : '',
    hint.year ? `Year hint: ${hint.year}` : '',
    hint.subject ? `Subject hint: ${hint.subject}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return `Extract every MCQ from this question-paper image:
- source_image_index 0: ${imageLabel}

${hintLines ? `The uploader supplied these hints; use them only when the paper is consistent with them:\n${hintLines}\n\n` : ''}Respond with the JSON object described by the system instructions.`;
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
        'The AI extraction timed out. Try a clearer photo or retry.',
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
  images: ExtractionImageResult[];
  questions: ExtractedQuestion[];
  rejected: ExtractionRejection[];
  batch_source_info: { institution?: string; exam_name?: string; year?: string };
  warnings: string[];
}

/**
 * Extracts questions from the single supplied question-paper image.
 *
 * Phase 4 processes one image per request, so every question cites
 * source_image_index 0 and the image status is derived from those questions.
 */
export const extractQuestionsFromImage = async (
  body: unknown
): Promise<ExtractionServiceResult> => {
  const request = parseExtractionRequest(body);
  const image = request.images[0];

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
      prompt: buildPrompt(image, request.sourceHint),
      image: { mime_type: image.mime_type, data: image.data },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    text = result.text;
  } catch (error) {
    if (error instanceof ExtractionProviderError) {
      if (error.failure !== 'not_configured') {
        // Log the normalised failure only: never the key, the image or the body.
        logger.error(`[ai:extract] provider failure: ${error.failure}`);
      }
      throw mapProviderError(error);
    }
    throw mapProviderError(
      new ExtractionProviderError('The AI extraction provider failed.', 'unavailable')
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger.error('[ai:extract] provider returned non-JSON output');
    throw new ExtractionServiceError(
      'The AI response could not be read. Please retry.',
      502,
      'EXTRACTION_INVALID_RESPONSE'
    );
  }

  let sanitized;
  try {
    sanitized = sanitizeModelOutput(parsed, request.images.length);
  } catch {
    logger.error('[ai:extract] provider response failed schema validation');
    throw new ExtractionServiceError(
      'The AI response could not be read. Please retry.',
      502,
      'EXTRACTION_INVALID_RESPONSE'
    );
  }

  return {
    model: config.model,
    images: buildImageResults(request.images, sanitized.questions),
    questions: sanitized.questions,
    rejected: sanitized.rejected,
    batch_source_info: sanitized.batchSourceInfo,
    warnings: sanitized.warnings,
  };
};
