import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtractionServiceError, extractQuestionsFromImage } from './ai.extract.service';
import { DEFAULT_EXTRACTION_MODEL, GEMINI_API_BASE_URL } from './ai.extract.provider';

/**
 * Service-level checks for the extraction Gemini integration.
 *
 * The provider is never called for real: `globalThis.fetch` is stubbed, so no
 * API quota is consumed and no credential leaves the test process.
 */

const IMAGE = {
  image_id: 'img_1',
  file_name: 'page-1.jpg',
  mime_type: 'image/jpeg',
  data: Buffer.from('fake-jpeg-bytes').toString('base64'),
};

const REQUEST_BODY = {
  images: [IMAGE],
  source_hint: { institution: 'Dhaka Board', year: '2024' },
};

/** A bilingual page as the extraction model would return it. */
const GEMINI_ANSWER = {
  batch_source_info: { institution: 'Dhaka Board', exam_name: 'SSC', year: '2024' },
  questions: [
    {
      question_number: '1',
      body: {
        text_bn: 'বাংলাদেশের রাজধানী কোনটি?',
        text_en: 'What is the capital of Bangladesh?',
      },
      options: [
        { text_bn: 'ঢাকা', text_en: 'Dhaka', isCorrect: true },
        { text_bn: 'খুলনা', text_en: 'Khulna', isCorrect: false },
        { text_bn: 'চট্টগ্রাম', text_en: 'Chattogram', isCorrect: false },
        { text_bn: 'রাজশাহী', text_en: 'Rajshahi', isCorrect: false },
      ],
      explanation: {
        bn: 'ঢাকা বাংলাদেশের রাজধানী।',
        en: 'Dhaka is the capital of Bangladesh.',
      },
      difficulty_level: 'easy',
      source_type: 'board_exam',
      exam_references: [
        { source_kind: 'board', board: 'Dhaka Board', exam_name: 'SSC', year: '2024' },
      ],
      tags: ['capital'],
      answer_source: 'printed',
      answer_evidence: 'Answer key: 1. ঢাকা',
      requires_manual_answer_verification: false,
      uncertain_ocr_flags: [],
      source_image_index: 0,
    },
  ],
};

interface SeenCall {
  url: string;
  init: RequestInit;
}

/** Replaces the global fetch and records each call. */
const stubFetch = (handler: (url: string, init: RequestInit) => Promise<unknown>): SeenCall[] => {
  const calls: SeenCall[] = [];

  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;

  return calls;
};

const geminiReply = (text: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }),
});

const geminiError = (status: number, statusCode: string) => ({
  ok: false,
  status,
  json: async () => ({ error: { status: statusCode, message: 'upstream detail' } }),
});

/** Runs one case with a clean AI environment, then restores env and fetch. */
const withEnv = async (
  env: NodeJS.ProcessEnv,
  run: () => Promise<void>
): Promise<void> => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  for (const key of [
    'EXTRACTION_GEMINI_API_KEY',
    'EXTRACTION_GEMINI_MODEL',
    'GEMINI_API_KEY',
    'GEMINI_EMBEDDING_API_KEY',
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);

  try {
    await run();
  } finally {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  }
};

test('extraction works with only EXTRACTION_GEMINI_API_KEY configured', async () => {
  await withEnv({ EXTRACTION_GEMINI_API_KEY: 'extraction-project-key' }, async () => {
    const calls = stubFetch(async () => geminiReply(JSON.stringify(GEMINI_ANSWER)));

    const result = await extractQuestionsFromImage(REQUEST_BODY);

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      `${GEMINI_API_BASE_URL}/models/${DEFAULT_EXTRACTION_MODEL}:generateContent`
    );

    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['x-goog-api-key'], 'extraction-project-key');

    assert.equal(result.model, DEFAULT_EXTRACTION_MODEL);
    assert.equal(result.questions.length, 1);

    const [question] = result.questions;
    // Bangla and English text, and the bilingual explanation, survive intact.
    assert.equal(question.body.text_bn, 'বাংলাদেশের রাজধানী কোনটি?');
    assert.equal(question.body.text_en, 'What is the capital of Bangladesh?');
    assert.equal(question.explanation.bn, 'ঢাকা বাংলাদেশের রাজধানী।');
    assert.equal(question.explanation.en, 'Dhaka is the capital of Bangladesh.');
    // The printed answer key is preserved because it is backed by evidence.
    assert.equal(question.options[0].isCorrect, true);
    assert.equal(question.requires_manual_answer_verification, false);
    assert.equal(result.images[0].status, 'extracted');
  });
});

test('a missing extraction key returns a configuration error without calling Gemini', async () => {
  await withEnv({ GEMINI_API_KEY: 'assistant-key' }, async () => {
    const calls = stubFetch(async () => geminiReply(JSON.stringify(GEMINI_ANSWER)));

    await assert.rejects(
      () => extractQuestionsFromImage(REQUEST_BODY),
      (error: unknown) => {
        assert.ok(error instanceof ExtractionServiceError);
        assert.equal(error.status, 503);
        assert.equal(error.errorCode, 'EXTRACTION_NOT_CONFIGURED');
        assert.ok(!error.message.includes('assistant-key'));
        return true;
      }
    );

    // The assistant credential is never borrowed for extraction.
    assert.equal(calls.length, 0);
  });
});

test('a malformed Gemini reply is reported as an invalid response', async () => {
  await withEnv({ EXTRACTION_GEMINI_API_KEY: 'extraction-project-key' }, async () => {
    stubFetch(async () => geminiReply('not json at all'));

    await assert.rejects(
      () => extractQuestionsFromImage(REQUEST_BODY),
      (error: unknown) => {
        assert.ok(error instanceof ExtractionServiceError);
        assert.equal(error.status, 502);
        assert.equal(error.errorCode, 'EXTRACTION_INVALID_RESPONSE');
        return true;
      }
    );
  });
});

test('a Gemini rate limit is surfaced as a retryable 429', async () => {
  await withEnv({ EXTRACTION_GEMINI_API_KEY: 'extraction-project-key' }, async () => {
    stubFetch(async () => geminiError(429, 'RESOURCE_EXHAUSTED'));

    await assert.rejects(
      () => extractQuestionsFromImage(REQUEST_BODY),
      (error: unknown) => {
        assert.ok(error instanceof ExtractionServiceError);
        assert.equal(error.status, 429);
        assert.equal(error.errorCode, 'EXTRACTION_RATE_LIMITED');
        assert.ok(!error.message.includes('upstream detail'));
        return true;
      }
    );
  });
});
