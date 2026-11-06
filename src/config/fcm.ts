import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import {
  getMessaging,
  type BatchResponse,
  type Messaging,
  type MulticastMessage,
} from 'firebase-admin/messaging';

/**
 * Firebase Cloud Messaging transport.
 *
 * Push is addressed to FCM registration tokens stored in `user_devices`, so the
 * Mongo-style "external id" fan-out of the previous provider is gone: recipient
 * resolution happens in our database and only tokens reach Google.
 *
 * The service account lives in the server environment only. Nothing in this file
 * may be imported by a client bundle: the credentials are read from
 * FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY (or a single
 * FIREBASE_SERVICE_ACCOUNT_JSON) and never logged, returned or rethrown.
 */

/** FCM accepts at most 500 registration tokens per multicast request. */
export const FCM_BATCH_LIMIT = 500;

/** Attempts per batch, including the first one. */
const MAX_BATCH_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 250;

const APP_NAME = 'porokh-fcm';

/**
 * Per-token errors that can never succeed again. The token is removed from the
 * device row instead of being retried forever.
 */
const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
  'messaging/mismatched-credential',
]);

/** Errors where the same request may succeed on a later attempt. */
const RETRYABLE_CODES = new Set([
  'messaging/internal-error',
  'messaging/server-unavailable',
  'messaging/unknown-error',
  'messaging/quota-exceeded',
  'app/network-error',
  'app/network-timeout',
]);

export type ServiceAccountCredentials = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

const readEnv = (env: NodeJS.ProcessEnv, name: string): string =>
  String(env[name] ?? '').trim();

/**
 * A PEM body stored in an environment variable arrives on one line, with the
 * line breaks escaped. Converting them back is the only transformation applied:
 * the key itself is never trimmed beyond whitespace or rewritten.
 */
export const normalizePrivateKey = (value: string): string =>
  String(value ?? '').replace(/\\n/g, '\n').trim();

/**
 * Reads credentials from either form. Returns null when they are missing or
 * unparsable, which callers treat as "push disabled" rather than a crash at
 * import time.
 */
export const readServiceAccountCredentials = (
  env: NodeJS.ProcessEnv = process.env
): ServiceAccountCredentials | null => {
  const inlineJson = readEnv(env, 'FIREBASE_SERVICE_ACCOUNT_JSON');

  if (inlineJson) {
    try {
      const parsed = JSON.parse(inlineJson) as Record<string, unknown>;
      const credentials: ServiceAccountCredentials = {
        projectId: String(parsed.project_id ?? '').trim(),
        clientEmail: String(parsed.client_email ?? '').trim(),
        privateKey: normalizePrivateKey(String(parsed.private_key ?? '')),
      };

      return credentials.projectId && credentials.clientEmail && credentials.privateKey
        ? credentials
        : null;
    } catch {
      return null;
    }
  }

  const credentials: ServiceAccountCredentials = {
    projectId: readEnv(env, 'FIREBASE_PROJECT_ID'),
    clientEmail: readEnv(env, 'FIREBASE_CLIENT_EMAIL'),
    privateKey: normalizePrivateKey(readEnv(env, 'FIREBASE_PRIVATE_KEY')),
  };

  return credentials.projectId && credentials.clientEmail && credentials.privateKey
    ? credentials
    : null;
};

export const isFcmConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  readServiceAccountCredentials(env) !== null;

let cachedMessaging: Messaging | null = null;

/**
 * Lazily creates the Admin app. A missing or broken configuration throws here,
 * at first send, so importing the notification service (payments, exams, access)
 * never fails because push is unconfigured.
 */
export const getFcmMessaging = (): Messaging => {
  if (cachedMessaging) return cachedMessaging;

  const credentials = readServiceAccountCredentials();

  if (!credentials) {
    throw new Error(
      'Firebase Cloud Messaging is not configured: set FIREBASE_PROJECT_ID, ' +
        'FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY (or FIREBASE_SERVICE_ACCOUNT_JSON)'
    );
  }

  const existing: App | undefined = getApps().find((app) => app.name === APP_NAME);
  const app =
    existing ??
    initializeApp(
      { credential: cert(credentials), projectId: credentials.projectId },
      APP_NAME
    );

  cachedMessaging = getMessaging(app);
  return cachedMessaging;
};

/** Injected by tests so no message ever reaches Firebase. */
export type FcmSender = (message: MulticastMessage) => Promise<BatchResponse>;

export type FcmFailure = { code: string; message: string };

export type FcmBatchOutcome = {
  /** Tokens handed to FCM. */
  attempted: number;
  /** Tokens FCM accepted. Acceptance is not proof the device displayed it. */
  accepted: number;
  /** Tokens that failed for a reason other than being permanently invalid. */
  failed: number;
  /** Tokens FCM rejected as unregistered/invalid; the caller deactivates them. */
  invalidTokens: string[];
  messageIds: string[];
  failures: FcmFailure[];
  /** Set when a whole batch could not be delivered. */
  error: string | null;
};

export const emptyFcmOutcome = (): FcmBatchOutcome => ({
  attempted: 0,
  accepted: 0,
  failed: 0,
  invalidTokens: [],
  messageIds: [],
  failures: [],
  error: null,
});

/** Trims and de-duplicates tokens; the same token must never be sent twice. */
export const normalizePushTokens = (
  values: Array<string | null | undefined>
): string[] => {
  const seen = new Set<string>();

  for (const value of values) {
    const token = String(value ?? '').trim();
    if (token) seen.add(token);
  }

  return Array.from(seen);
};

export const chunkPushTokens = (
  tokens: string[],
  size = FCM_BATCH_LIMIT
): string[][] => {
  const chunkSize = Math.max(1, Math.floor(size));
  const chunks: string[][] = [];

  for (let index = 0; index < tokens.length; index += chunkSize) {
    chunks.push(tokens.slice(index, index + chunkSize));
  }

  return chunks;
};

const errorCode = (error: unknown): string => {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }

  return 'unknown';
};

/** Short, credential-free description for logs and the admin error column. */
const describeFcmError = (error: unknown): string => {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown };
    const code = String(candidate.code ?? '').trim();
    const message = String(candidate.message ?? '').trim();
    const detail = [code, message].filter(Boolean).join(': ');

    if (detail) return detail.slice(0, 300);
  }

  return 'unknown error';
};

const isRetryable = (code: string): boolean => RETRYABLE_CODES.has(code);

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const recordFailure = (failures: FcmFailure[], failure: FcmFailure): void => {
  const duplicate = failures.some((item) => item.code === failure.code);
  if (!duplicate && failures.length < 5) failures.push(failure);
};

/**
 * Sends one payload to many tokens.
 *
 * - chunks at FCM's 500-token limit
 * - retries only transient failures, with exponential backoff
 * - reports invalid tokens separately so the caller can prune them
 * - never treats a failed batch as an invalid token
 */
export const sendFcmMulticast = async (
  tokens: string[],
  message: Omit<MulticastMessage, 'tokens'>,
  options: { send?: FcmSender; sleep?: (ms: number) => Promise<void> } = {}
): Promise<FcmBatchOutcome> => {
  const outcome = emptyFcmOutcome();
  const targets = normalizePushTokens(tokens);

  if (targets.length === 0) return outcome;

  const send: FcmSender =
    options.send ?? ((payload) => getFcmMessaging().sendEachForMulticast(payload));
  const sleep = options.sleep ?? defaultSleep;

  for (const chunk of chunkPushTokens(targets)) {
    outcome.attempted += chunk.length;

    let response: BatchResponse | null = null;
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt += 1) {
      try {
        response = await send({ ...message, tokens: chunk });
        break;
      } catch (error) {
        lastError = describeFcmError(error);

        if (attempt === MAX_BATCH_ATTEMPTS || !isRetryable(errorCode(error))) break;

        await sleep(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
      }
    }

    if (!response) {
      // The request never produced a result, so no token can be blamed.
      outcome.failed += chunk.length;
      outcome.error = lastError ?? 'fcm_send_failed';
      continue;
    }

    response.responses.forEach((result, index) => {
      if (result.success) {
        outcome.accepted += 1;
        if (result.messageId) outcome.messageIds.push(result.messageId);
        return;
      }

      const code = errorCode(result.error);

      if (INVALID_TOKEN_CODES.has(code)) {
        outcome.invalidTokens.push(chunk[index]);
        return;
      }

      outcome.failed += 1;
      recordFailure(outcome.failures, {
        code,
        message: describeFcmError(result.error),
      });
    });
  }

  return outcome;
};
