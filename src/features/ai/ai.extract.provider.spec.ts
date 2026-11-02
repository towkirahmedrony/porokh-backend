import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EXTRACTION_MODEL,
  GEMINI_API_BASE_URL,
  ExtractionProviderError,
  callExtractionProvider,
  readExtractionProviderConfig,
  type ExtractionProviderConfig,
} from './ai.extract.provider';

const CONFIG: ExtractionProviderConfig = {
  apiKey: 'extraction-test-key',
  model: 'gemini-test-vision',
};

const IMAGE = {
  mime_type: 'image/jpeg',
  data: Buffer.from('fake-jpeg-bytes').toString('base64'),
};

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

const okResponse = (text: string, finishReason = 'STOP'): FetchResponse => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text }] }, finishReason }] }),
});

const rawResponse = (payload: unknown): FetchResponse => ({
  ok: true,
  status: 200,
  json: async () => payload,
});

const errorResponse = (status: number, statusCode = '', message = ''): FetchResponse => ({
  ok: false,
  status,
  json: async () => ({ error: { status: statusCode, message } }),
});

const call = (
  fetchImpl: unknown,
  overrides: Partial<Parameters<typeof callExtractionProvider>[0]> = {}
) =>
  callExtractionProvider({
    config: CONFIG,
    systemInstruction: 'system prompt',
    prompt: 'extract this page',
    image: IMAGE,
    timeoutMs: 1_000,
    fetchImpl: fetchImpl as typeof fetch,
    ...overrides,
  });

// --- configuration ---------------------------------------------------------

test('readExtractionProviderConfig defaults to a free-tier Gemini vision model', () => {
  const config = readExtractionProviderConfig({
    EXTRACTION_GEMINI_API_KEY: 'key-123',
  } as NodeJS.ProcessEnv);

  assert.equal(config.model, DEFAULT_EXTRACTION_MODEL);
  assert.equal(config.apiKey, 'key-123');
  assert.equal(DEFAULT_EXTRACTION_MODEL, 'gemini-3.8-flash');
});

test('readExtractionProviderConfig reads only the extraction-specific model variable', () => {
  const config = readExtractionProviderConfig({
    EXTRACTION_GEMINI_API_KEY: 'key-456',
    EXTRACTION_GEMINI_MODEL: 'gemini-3.5-flash-lite',
  } as NodeJS.ProcessEnv);

  assert.equal(config.model, 'gemini-3.5-flash-lite');
  assert.equal(config.apiKey, 'key-456');
});

test('readExtractionProviderConfig accepts the models/ prefix form', () => {
  const config = readExtractionProviderConfig({
    EXTRACTION_GEMINI_API_KEY: 'key-789',
    EXTRACTION_GEMINI_MODEL: 'models/gemini-3.8-flash',
  } as NodeJS.ProcessEnv);

  assert.equal(config.model, 'gemini-3.8-flash');
});

test('readExtractionProviderConfig ignores the retired OpenAI-compatible variables', () => {
  const config = readExtractionProviderConfig({
    EXTRACTION_GEMINI_API_KEY: 'key-abc',
    EXTRACTION_AI_API_KEY: 'openrouter-key',
    EXTRACTION_AI_MODEL: 'nvidia/nemotron-3.5-super-vl:free',
  } as NodeJS.ProcessEnv);

  assert.equal(config.apiKey, 'key-abc');
  assert.equal(config.model, DEFAULT_EXTRACTION_MODEL);
});

test('readExtractionProviderConfig refuses to fall back to the Gemini assistant key', () => {
  assert.throws(
    () =>
      readExtractionProviderConfig({
        GEMINI_API_KEY: 'assistant-key',
        GEMINI_EMBEDDING_API_KEY: 'assistant-embedding-key',
      } as NodeJS.ProcessEnv),
    (error: unknown) => {
      assert.ok(error instanceof ExtractionProviderError);
      assert.equal(error.failure, 'not_configured');
      // A missing key must never surface any key material.
      assert.ok(!error.message.includes('assistant-key'));
      return true;
    }
  );
});

test('readExtractionProviderConfig rejects a model id that could break the request URL', () => {
  assert.throws(
    () =>
      readExtractionProviderConfig({
        EXTRACTION_GEMINI_API_KEY: 'key-abc',
        EXTRACTION_GEMINI_MODEL: 'gemini-3.8-flash?key=leak',
      } as NodeJS.ProcessEnv),
    (error: unknown) => {
      assert.ok(error instanceof ExtractionProviderError);
      assert.equal(error.failure, 'not_configured');
      assert.ok(!error.message.includes('leak'));
      return true;
    }
  );
});

// --- request shape ---------------------------------------------------------

test('callExtractionProvider posts one inline image to generateContent', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;

  const fetchImpl = async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenInit = init;
    return okResponse('{"questions":[]}');
  };

  const result = await call(fetchImpl);

  assert.equal(
    seenUrl,
    `${GEMINI_API_BASE_URL}/models/gemini-test-vision:generateContent`
  );
  // The key travels in a header so it never appears in a URL.
  assert.ok(!seenUrl.includes(CONFIG.apiKey));

  assert.equal(result.text, '{"questions":[]}');
  assert.equal(result.model, 'gemini-test-vision');

  const headers = seenInit?.headers as Record<string, string>;
  assert.equal(headers['x-goog-api-key'], 'extraction-test-key');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers.Authorization, undefined);

  const body = JSON.parse(String(seenInit?.body));
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'system prompt' }] });

  const contents = body.contents;
  assert.equal(contents.length, 1);
  assert.equal(contents[0].role, 'user');
  assert.equal(contents[0].parts[0].text, 'extract this page');
  assert.deepEqual(contents[0].parts[1].inlineData, {
    mimeType: 'image/jpeg',
    data: IMAGE.data,
  });

  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.maxOutputTokens, 8192);
  assert.equal(body.generationConfig.temperature, 0.15);
});

test('callExtractionProvider unwraps a fenced JSON reply', async () => {
  const result = await call(async () => okResponse('```json\n{"questions":[]}\n```'));

  assert.equal(result.text, '{"questions":[]}');
});

test('callExtractionProvider joins answer parts and skips thinking parts', async () => {
  const result = await call(async () =>
    rawResponse({
      candidates: [
        {
          content: {
            parts: [
              { text: 'ignored reasoning', thought: true },
              { text: '{"questions":' },
              { text: '[]}' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    })
  );

  assert.equal(result.text, '{"questions":[]}');
});

// --- upstream failures -----------------------------------------------------

test('callExtractionProvider maps 429 RESOURCE_EXHAUSTED to a rate-limit failure', async () => {
  await assert.rejects(
    () => call(async () => errorResponse(429, 'RESOURCE_EXHAUSTED', 'quota exceeded')),
    (error: unknown) => {
      assert.ok(error instanceof ExtractionProviderError);
      assert.equal(error.failure, 'rate_limited');
      assert.ok(!error.message.includes('quota exceeded'));
      assert.ok(!error.message.includes(CONFIG.apiKey));
      return true;
    }
  );
});

test('callExtractionProvider reports a rejected or missing key as a configuration error', async () => {
  const responses: FetchResponse[] = [
    errorResponse(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.'),
    errorResponse(403, 'PERMISSION_DENIED', 'Permission denied'),
    errorResponse(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.'),
  ];

  for (const response of responses) {
    await assert.rejects(
      () => call(async () => response),
      (error: unknown) => {
        assert.ok(error instanceof ExtractionProviderError);
        assert.equal(error.failure, 'not_configured');
        assert.ok(!error.message.includes(CONFIG.apiKey));
        assert.ok(!error.message.includes('API key not valid'));
        return true;
      }
    );
  }
});

test('callExtractionProvider maps server errors to unavailable', async () => {
  for (const status of [500, 502, 503]) {
    await assert.rejects(
      () => call(async () => errorResponse(status, 'INTERNAL', 'upstream failure')),
      (error: unknown) => {
        assert.ok(error instanceof ExtractionProviderError);
        assert.equal(error.failure, 'unavailable');
        // The provider's raw body and the key stay out of client-visible text.
        assert.ok(!error.message.includes('upstream failure'));
        assert.ok(!error.message.includes(CONFIG.apiKey));
        return true;
      }
    );
  }
});

test('callExtractionProvider reports a timeout when the request is aborted', async () => {
  const abortingFetch = (_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });

  await assert.rejects(
    () => call(abortingFetch, { timeoutMs: 5 }),
    (error: unknown) => {
      assert.ok(error instanceof ExtractionProviderError);
      assert.equal(error.failure, 'timeout');
      return true;
    }
  );
});

test('callExtractionProvider rejects responses without usable content', async () => {
  const cases = [
    { candidates: [] },
    { candidates: [{ content: { parts: [] } }] },
    { candidates: [{ content: { parts: [{ text: '' }] } }] },
    { candidates: [{ content: { parts: [{ text: '   ' }] } }] },
    { candidates: [{ content: { parts: [{ text: '{"q":1}', thought: true }] } }] },
    {},
  ];

  for (const payload of cases) {
    await assert.rejects(
      () => call(async () => rawResponse(payload)),
      (error: unknown) => {
        assert.ok(error instanceof ExtractionProviderError);
        assert.equal(error.failure, 'invalid_response');
        return true;
      }
    );
  }
});

test('callExtractionProvider rejects a non-JSON body from the provider', async () => {
  await assert.rejects(
    () =>
      call(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json');
        },
      })),
    (error: unknown) => {
      assert.ok(error instanceof ExtractionProviderError);
      assert.equal(error.failure, 'invalid_response');
      return true;
    }
  );
});

test('callExtractionProvider flags a blocked or truncated completion', async () => {
  const cases = [
    rawResponse({ promptFeedback: { blockReason: 'SAFETY' } }),
    rawResponse({
      candidates: [{ content: { parts: [{ text: '{"questions":[]}' }] }, finishReason: 'SAFETY' }],
    }),
    rawResponse({
      candidates: [{ content: { parts: [{ text: '{"questions":[{"bo' }] }, finishReason: 'MAX_TOKENS' }],
    }),
  ];

  for (const response of cases) {
    await assert.rejects(
      () => call(async () => response),
      (error: unknown) => {
        assert.ok(error instanceof ExtractionProviderError);
        assert.equal(error.failure, 'invalid_response');
        return true;
      }
    );
  }
});
