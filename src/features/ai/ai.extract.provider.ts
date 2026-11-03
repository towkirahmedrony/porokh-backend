import logger from '../../lib/utils/logger';

/**
 * Dedicated Gemini client for AI question extraction.
 *
 * Extraction runs on its own Google Cloud project and API key
 * (`EXTRACTION_GEMINI_API_KEY`), so importer traffic never spends the student AI
 * Assistant's Gemini project quota. The assistant's `GEMINI_API_KEY` is
 * deliberately never read here: there is no fallback between the two.
 */

export const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Free-tier, vision-capable default. Gemini 3.8 Flash is offered on the free
 * tier and handles bilingual Bangla + English page OCR well; it can be swapped
 * with `EXTRACTION_GEMINI_MODEL` (gemini-3.5-flash-lite is the cheaper
 * free-tier alternative).
 */
export const DEFAULT_EXTRACTION_MODEL = 'gemini-3.8-flash';

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_TOKENS = 8192;
const TEMPERATURE = 0.15;

/** Model ids go into the URL path, so they are restricted to a safe alphabet. */
const MODEL_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export type ExtractionProviderFailure =
  | 'not_configured'
  | 'timeout'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_response';

/**
 * Safe, client-independent failure. Messages never carry the API key, the image
 * or the upstream response body; the service maps `failure` to an HTTP status.
 */
export class ExtractionProviderError extends Error {
  failure: ExtractionProviderFailure;

  constructor(message: string, failure: ExtractionProviderFailure) {
    super(message);
    this.name = 'ExtractionProviderError';
    this.failure = failure;
  }
}

export interface ExtractionProviderConfig {
  apiKey: string;
  model: string;
}

const readEnv = (value: string | undefined): string =>
  typeof value === 'string' ? value.trim() : '';

/** Accepts both `gemini-3.8-flash` and the `models/gemini-3.8-flash` form. */
const normalizeModelId = (value: string): string => value.replace(/^models\//, '');

/**
 * Reads the extraction provider settings. Only `EXTRACTION_GEMINI_*` is read:
 * the assistant key must never pay for importer traffic.
 */
export const readExtractionProviderConfig = (
  env: NodeJS.ProcessEnv = process.env
): ExtractionProviderConfig => {
  const apiKey = readEnv(env.EXTRACTION_GEMINI_API_KEY);

  if (!apiKey) {
    throw new ExtractionProviderError(
      'The question-extraction AI provider is not configured.',
      'not_configured'
    );
  }

  const configuredModel = readEnv(env.EXTRACTION_GEMINI_MODEL);
  const model = configuredModel ? normalizeModelId(configuredModel) : DEFAULT_EXTRACTION_MODEL;

  if (!MODEL_ID_PATTERN.test(model)) {
    throw new ExtractionProviderError(
      'The question-extraction AI model is not configured correctly.',
      'not_configured'
    );
  }

  return { apiKey, model };
};

export interface ExtractionProviderImage {
  mime_type: string;
  data: string;
}

/**
 * One ordered user turn: text labels and inline images interleaved so the model
 * can tell which page a block belongs to when a request carries several pages.
 */
export type ExtractionProviderPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; image: ExtractionProviderImage };

export interface ExtractionProviderRequest {
  config: ExtractionProviderConfig;
  systemInstruction: string;
  parts: ExtractionProviderPart[];
  timeoutMs?: number;
  /** Injectible for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface VisionExtractionResult {
  text: string;
  model: string;
}

interface GeminiPart {
  text?: unknown;
  /** Thinking-model parts are not part of the JSON reply. */
  thought?: unknown;
}

interface GeminiPayload {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] } | null;
    finishReason?: string | null;
  }>;
  promptFeedback?: { blockReason?: string | null } | null;
  error?: { status?: unknown; message?: unknown } | null;
}

/** Finish reasons that mean the model refused or truncated the answer. */
const UNUSABLE_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'MAX_TOKENS',
]);

/** Removes a markdown code fence some models wrap JSON in despite JSON mode. */
const stripCodeFence = (value: string): string => {
  const trimmed = value.trim();

  if (!trimmed.startsWith('```')) return trimmed;

  return trimmed
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
};

const readCandidateText = (payload: unknown): string => {
  const parsed = payload as GeminiPayload | null;

  if (parsed?.promptFeedback?.blockReason) {
    throw new ExtractionProviderError(
      'The AI provider filtered the response.',
      'invalid_response'
    );
  }

  const candidate = parsed?.candidates?.[0];
  const finishReason = typeof candidate?.finishReason === 'string' ? candidate.finishReason : '';

  if (UNUSABLE_FINISH_REASONS.has(finishReason)) {
    throw new ExtractionProviderError(
      'The AI provider did not return a complete answer.',
      'invalid_response'
    );
  }

  // A thinking model can emit reasoning parts next to the answer.
  const rawText = (candidate?.content?.parts ?? [])
    .filter((part) => part && part.thought !== true && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');

  const text = stripCodeFence(rawText);

  if (!text) {
    throw new ExtractionProviderError(
      'The AI provider returned no usable content.',
      'invalid_response'
    );
  }

  return text;
};

/**
 * Reads Gemini's error envelope for classification only. The message is never
 * logged or forwarded, because upstream text can echo the request.
 */
const readUpstreamError = async (
  response: Response
): Promise<{ status: string; message: string }> => {
  try {
    const payload = (await response.json()) as GeminiPayload | null;
    const error = payload?.error;

    return {
      status: typeof error?.status === 'string' ? error.status : '',
      message: typeof error?.message === 'string' ? error.message : '',
    };
  } catch {
    return { status: '', message: '' };
  }
};

/**
 * Maps an upstream failure to a normalised kind. Credential and project
 * problems are reported as configuration errors, so a missing or rejected
 * extraction key can never look like a transient provider outage.
 */
const failureForResponse = (
  httpStatus: number,
  upstream: { status: string; message: string }
): ExtractionProviderFailure => {
  if (httpStatus === 429 || upstream.status === 'RESOURCE_EXHAUSTED') return 'rate_limited';
  if (httpStatus === 408 || httpStatus === 504 || upstream.status === 'DEADLINE_EXCEEDED') {
    return 'timeout';
  }

  const credentialProblem =
    httpStatus === 401 ||
    httpStatus === 403 ||
    upstream.status === 'UNAUTHENTICATED' ||
    upstream.status === 'PERMISSION_DENIED' ||
    /api[\s_-]?key/i.test(upstream.message);

  if (credentialProblem) return 'not_configured';

  return 'unavailable';
};

/**
 * Sends the prepared sources to the extraction Gemini model and returns the
 * raw text. Transport, timeout and provider failures are normalised to
 * `ExtractionProviderError` so no upstream detail reaches the importer.
 */
export const callExtractionProvider = async ({
  config,
  systemInstruction,
  parts,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}: ExtractionProviderRequest): Promise<VisionExtractionResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(
      `${GEMINI_API_BASE_URL}/models/${config.model}:generateContent`,
      {
        method: 'POST',
        headers: {
          // Sent as a header, never a query parameter, so the key cannot end up
          // in a logged or proxied URL.
          'x-goog-api-key': config.apiKey,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [
            {
              role: 'user',
              parts: parts.map((part) =>
                part.kind === 'text'
                  ? { text: part.text }
                  : { inlineData: { mimeType: part.image.mime_type, data: part.image.data } }
              ),
            },
          ],
          generationConfig: {
            temperature: TEMPERATURE,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          },
        }),
      }
    );

    if (!response.ok) {
      const upstream = await readUpstreamError(response);
      const failure = failureForResponse(response.status, upstream);

      logger.error(`[ai:extract] provider responded with status ${response.status} (${failure})`);
      throw new ExtractionProviderError(
        'The AI extraction provider rejected the request.',
        failure
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ExtractionProviderError(
        'The AI extraction provider returned an unreadable body.',
        'invalid_response'
      );
    }

    return { text: readCandidateText(payload), model: config.model };
  } catch (error) {
    if (error instanceof ExtractionProviderError) throw error;

    const name = error instanceof Error ? error.name : '';

    if (controller.signal.aborted || name === 'AbortError' || name === 'TimeoutError') {
      throw new ExtractionProviderError('The AI extraction request timed out.', 'timeout');
    }

    // Log the error type only: never the key, the image or the request body.
    logger.error(`[ai:extract] provider request failed: ${name || 'unknown'}`);
    throw new ExtractionProviderError(
      'The AI extraction provider is unreachable.',
      'unavailable'
    );
  } finally {
    clearTimeout(timer);
  }
};
