import test from 'node:test';
import assert from 'node:assert/strict';
import type { BatchResponse } from 'firebase-admin/messaging';
import {
  FCM_BATCH_LIMIT,
  chunkPushTokens,
  normalizePrivateKey,
  normalizePushTokens,
  readServiceAccountCredentials,
  sendFcmMulticast,
} from './fcm';

const CREDENTIALS = {
  projectId: 'porokh-test',
  clientEmail: 'fcm@porokh-test.iam.gserviceaccount.com',
  privateKey: '-----BEGIN PRIVATE KEY-----\\nMIIabc\\n-----END PRIVATE KEY-----\\n',
};

/** What the same key becomes once the escaped newlines are decoded. */
const NORMALIZED_PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----';

const response = (
  results: Array<{ success: boolean; messageId?: string; code?: string }>
): BatchResponse =>
  ({
    responses: results.map((result) => ({
      success: result.success,
      messageId: result.messageId,
      error: result.code ? { code: result.code, message: result.code } : undefined,
    })),
    successCount: results.filter((result) => result.success).length,
    failureCount: results.filter((result) => !result.success).length,
  }) as unknown as BatchResponse;

test('service account credentials come from the three server variables', () => {
  const credentials = readServiceAccountCredentials({
    FIREBASE_PROJECT_ID: 'porokh-test',
    FIREBASE_CLIENT_EMAIL: 'fcm@porokh-test.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: CREDENTIALS.privateKey,
  } as NodeJS.ProcessEnv);

  assert.deepEqual(credentials, {
    ...CREDENTIALS,
    privateKey: NORMALIZED_PRIVATE_KEY,
  });
});

test('an escaped newline in the private key becomes a real line break', () => {
  assert.equal(
    normalizePrivateKey('line1\\nline2'),
    'line1\nline2'
  );
});

test('a single JSON variable is accepted and wins over the split variables', () => {
  const credentials = readServiceAccountCredentials({
    FIREBASE_PROJECT_ID: 'ignored',
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: 'porokh-test',
      client_email: 'fcm@porokh-test.iam.gserviceaccount.com',
      private_key: CREDENTIALS.privateKey,
    }),
  } as NodeJS.ProcessEnv);

  assert.equal(credentials?.projectId, 'porokh-test');
  assert.equal(credentials?.privateKey.replace(/\n/g, '|').includes('|'), true);
});

test('missing or malformed credentials disable push instead of throwing', () => {
  assert.equal(readServiceAccountCredentials({} as NodeJS.ProcessEnv), null);
  assert.equal(
    readServiceAccountCredentials({
      FIREBASE_SERVICE_ACCOUNT_JSON: '{not json',
    } as NodeJS.ProcessEnv),
    null
  );
  assert.equal(
    readServiceAccountCredentials({
      FIREBASE_PROJECT_ID: 'porokh-test',
      FIREBASE_CLIENT_EMAIL: 'fcm@porokh-test.iam.gserviceaccount.com',
    } as NodeJS.ProcessEnv),
    null
  );
});

test('tokens are trimmed and de-duplicated before sending', () => {
  assert.deepEqual(
    normalizePushTokens([' a ', 'a', '', null, undefined, 'b']),
    ['a', 'b']
  );
});

test('tokens are chunked at the 500-token FCM limit', () => {
  const tokens = Array.from({ length: FCM_BATCH_LIMIT * 2 + 1 }, (_, index) => `t${index}`);
  const chunks = chunkPushTokens(tokens);

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, FCM_BATCH_LIMIT);
  assert.equal(chunks[2].length, 1);
});

test('an accepted batch reports per-token success and prunes invalid tokens', async () => {
  const sent: string[][] = [];

  const outcome = await sendFcmMulticast(
    ['ok-1', 'dead-1', 'ok-2'],
    { data: { type: 'exam' } },
    {
      send: async (message) => {
        sent.push([...message.tokens]);
        return response([
          { success: true, messageId: 'projects/porokh-test/messages/1' },
          { success: false, code: 'messaging/registration-token-not-registered' },
          { success: true, messageId: 'projects/porokh-test/messages/2' },
        ]);
      },
    }
  );

  assert.deepEqual(sent, [['ok-1', 'dead-1', 'ok-2']]);
  assert.equal(outcome.attempted, 3);
  assert.equal(outcome.accepted, 2);
  assert.equal(outcome.failed, 0);
  assert.deepEqual(outcome.invalidTokens, ['dead-1']);
  assert.equal(outcome.messageIds.length, 2);
  assert.equal(outcome.error, null);
});

test('more than 500 tokens are sent in separate batches', async () => {
  const batches: number[] = [];
  const tokens = Array.from({ length: FCM_BATCH_LIMIT + 10 }, (_, index) => `t${index}`);

  const outcome = await sendFcmMulticast(
    tokens,
    { data: { type: 'exam' } },
    {
      send: async (message) => {
        batches.push(message.tokens.length);
        return response(message.tokens.map(() => ({ success: true, messageId: 'm' })));
      },
    }
  );

  assert.deepEqual(batches, [FCM_BATCH_LIMIT, 10]);
  assert.equal(outcome.accepted, FCM_BATCH_LIMIT + 10);
});

test('a transient failure is retried with exponential backoff', async () => {
  const delays: number[] = [];
  let calls = 0;

  const outcome = await sendFcmMulticast(
    ['t1'],
    { data: { type: 'exam' } },
    {
      sleep: async (ms) => {
        delays.push(ms);
      },
      send: async () => {
        calls += 1;
        if (calls < 3) {
          const error = new Error('backend unavailable') as Error & { code: string };
          error.code = 'messaging/server-unavailable';
          throw error;
        }
        return response([{ success: true, messageId: 'm1' }]);
      },
    }
  );

  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 500]);
  assert.equal(outcome.accepted, 1);
  assert.equal(outcome.failed, 0);
});

test('a permanent batch failure is not retried and is not blamed on the token', async () => {
  let calls = 0;

  const outcome = await sendFcmMulticast(
    ['t1', 't2'],
    { data: { type: 'exam' } },
    {
      sleep: async () => undefined,
      send: async () => {
        calls += 1;
        const error = new Error('invalid payload') as Error & { code: string };
        error.code = 'messaging/invalid-payload';
        throw error;
      },
    }
  );

  assert.equal(calls, 1);
  assert.equal(outcome.accepted, 0);
  assert.equal(outcome.failed, 2);
  assert.deepEqual(outcome.invalidTokens, []);
  assert.match(String(outcome.error), /messaging\/invalid-payload/);
});

test('exhausted retries report a batch error and leave tokens active', async () => {
  let calls = 0;

  const outcome = await sendFcmMulticast(
    ['t1'],
    { data: { type: 'exam' } },
    {
      sleep: async () => undefined,
      send: async () => {
        calls += 1;
        const error = new Error('backend down') as Error & { code: string };
        error.code = 'messaging/internal-error';
        throw error;
      },
    }
  );

  assert.equal(calls, 3);
  assert.equal(outcome.accepted, 0);
  assert.equal(outcome.failed, 1);
  assert.deepEqual(outcome.invalidTokens, []);
  assert.ok(outcome.error);
});

test('sending no tokens makes no provider call', async () => {
  let calls = 0;

  const outcome = await sendFcmMulticast([], { data: { type: 'exam' } }, {
    send: async () => {
      calls += 1;
      return response([]);
    },
  });

  assert.equal(calls, 0);
  assert.equal(outcome.attempted, 0);
});
