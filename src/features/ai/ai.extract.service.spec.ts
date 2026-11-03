import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtractionServiceError, extractQuestionsFromSources } from './ai.extract.service';
import { DEFAULT_EXTRACTION_MODEL, GEMINI_API_BASE_URL } from './ai.extract.provider';

/**
 * Service-level checks for the extraction Gemini integration.
 *
 * The provider is never called for real: `globalThis.fetch` is stubbed, so no
 * API quota is consumed and no credential leaves the test process.
 */

const IMAGE = {
  source_id: 'img_1',
  file_name: 'page-1.jpg',
  kind: 'image',
  mime_type: 'image/jpeg',
  data: Buffer.from('fake-jpeg-bytes').toString('base64'),
};

const REQUEST_BODY = {
  sources: [
    IMAGE,
    {
      source_id: 'txt_1',
      file_name: 'csv-questions.csv',
      kind: 'text',
      text: 'Question: রাজধানী? | Answer: ঢাকা',
    },
  ],
  source_hint: { institution: 'Dhaka Board', year: '2024' },
};

/** Structured Plain Text as the extraction model would return it. */
const PLAIN_TEXT_ANSWER = `@source: admission
@institution: University of Dhaka
@year: 2024-25

Q_BN: বাংলাদেশের রাজধানী কোনটি?
Q_EN: What is the capital of Bangladesh?
A_BN: ঢাকা
A_EN: Dhaka
B_BN: খুলনা
B_EN: Khulna
C_BN: চট্টগ্রাম
C_EN: Chattogram
D_BN: রাজশাহী
D_EN: Rajshahi
ANS: A
EXP_BN: ঢাকা বাংলাদেশের রাজধানী।
EXP_EN: Dhaka is the capital of Bangladesh.
DIFF: easy
TAGS: bangladesh, capital, geography`;

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

test('extraction sends every source to the model and returns plain text', async () => {
  await withEnv({ EXTRACTION_GEMINI_API_KEY: 'extraction-project-key' }, async () => {
    const calls = stubFetch(async () => geminiReply(PLAIN_TEXT_ANSWER));

    const result = await extractQuestionsFromSources(REQUEST_BODY);

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      `${GEMINI_API_BASE_URL}/models/${DEFAULT_EXTRACTION_MODEL}:generateContent`
    );

    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['x-goog-api-key'], 'extraction-project-key');

    // The request carries the canonical format instructions and both sources.
    const body = JSON.parse(String(calls[0].init.body));
    const systemText = body.systemInstruction.parts[0].text as string;
    assert.ok(systemText.includes('Structured Plain Text'));
    assert.ok(systemText.includes('Q_BN'));
    assert.ok(systemText.includes('Never invent'));

    const parts = body.contents[0].parts as Array<Record<string, unknown>>;
    const textParts = parts
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('\n');
    assert.ok(textParts.includes('page-1.jpg'));
    assert.ok(textParts.includes('csv-questions.csv'));
    assert.ok(textParts.includes('রাজধানী?'));
    assert.ok(parts.some((part) => part.inlineData));

    assert.equal(result.model, DEFAULT_EXTRACTION_MODEL);
    assert.equal(result.plain_text, `${PLAIN_TEXT_ANSWER}\n`);
    assert.equal(result.question_count, 1);
    assert.equal(result.sources.length, 2);
    assert.ok(result.sources.every((source) => source.status === 'extracted'));
  });
});

test('a missing extraction key returns a configuration error without calling Gemini', async () => {
  await withEnv({ GEMINI_API_KEY: 'assistant-key' }, async () => {
    const calls = stubFetch(async () => geminiReply(PLAIN_TEXT_ANSWER));

    await assert.rejects(
      () => extractQuestionsFromSources(REQUEST_BODY),
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

test('an empty or NONE reply produces no questions and no plain text', async () => {
  await withEnv({ EXTRACTION_GEMINI_API_KEY: 'extraction-project-key' }, async () => {
    stubFetch(async () => geminiReply('NONE'));

    const result = await extractQuestionsFromSources(REQUEST_BODY);

    assert.equal(result.plain_text, '');
    assert.equal(result.question_count, 0);
    assert.ok(result.sources.every((source) => source.status === 'empty'));
  });
});

test('a non-question reply is returned with a warning instead of failing the batch', async () => {
  await withEnv({ EXTRACTION_GEMINI_API_KEY: 'extraction-project-key' }, async () => {
    stubFetch(async () => geminiReply('I could not read this page.'));

    const result = await extractQuestionsFromSources(REQUEST_BODY);

    assert.equal(result.plain_text, '');
    assert.equal(result.question_count, 0);
    assert.ok(result.warnings.length > 0);
  });
});

test('a Gemini rate limit is surfaced as a retryable 429', async () => {
  await withEnv({ EXTRACTION_GEMINI_API_KEY: 'extraction-project-key' }, async () => {
    stubFetch(async () => geminiError(429, 'RESOURCE_EXHAUSTED'));

    await assert.rejects(
      () => extractQuestionsFromSources(REQUEST_BODY),
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

test('invalid request content never reaches the provider', async () => {
  await withEnv({ EXTRACTION_GEMINI_API_KEY: 'extraction-project-key' }, async () => {
    const calls = stubFetch(async () => geminiReply(PLAIN_TEXT_ANSWER));

    await assert.rejects(
      () => extractQuestionsFromSources({ sources: [] }),
      /At least one text or image source is required/
    );

    assert.equal(calls.length, 0);
  });
});
