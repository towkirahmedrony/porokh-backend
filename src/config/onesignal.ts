import axios from 'axios';

/**
 * OneSignal REST client.
 *
 * OneSignal is the only push transport. A message is addressed to External IDs
 * (Supabase user UUIDs) and OneSignal fans it out to every subscription of those
 * users, so a second device needs no extra bookkeeping here.
 *
 * The REST key is server-only. It must never be exposed through a VITE_
 * variable, the admin panel, the APK or a client-side request.
 */

export const ONESIGNAL_MESSAGE_URL = 'https://api.onesignal.com/notifications';

/** Documented maximum number of `external_id` aliases per create-message call. */
export const ONESIGNAL_ALIAS_LIMIT = 20_000;

const REQUEST_TIMEOUT_MS = 15_000;

const readEnv = (name: string): string => String(process.env[name] ?? '').trim();

export const getOneSignalAppId = (): string => readEnv('ONESIGNAL_APP_ID');

export const isOneSignalConfigured = (): boolean =>
  Boolean(getOneSignalAppId() && readEnv('ONESIGNAL_REST_API_KEY'));

export type OneSignalMessage = Record<string, unknown>;

export type OneSignalSendResult = {
  /** OneSignal message id, kept for support and log correlation. */
  id: string | null;
  /** Devices (subscriptions) OneSignal accepted the message for. */
  recipients: number;
};

const describeError = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status ?? 'network';
    const body = error.response?.data;
    const detail =
      body === undefined ? error.message : JSON.stringify(body).slice(0, 300);
    return `${status} ${detail}`;
  }

  return error instanceof Error ? error.message : 'unknown error';
};

/**
 * Reads the provider's own count for a sent message.
 *
 * Acceptance (the create-message response) is not delivery, so the dashboard
 * only shows a delivery rate after this report has been fetched at least once.
 */
export type OneSignalMessageReport = {
  /** Devices the provider reports as delivered, or null when it reports none. */
  delivered: number | null;
  failed: number | null;
};

export const fetchOneSignalMessageReport = async (
  messageId: string
): Promise<OneSignalMessageReport> => {
  const id = String(messageId ?? '').trim();
  if (!id) throw new Error('OneSignal message id is required');

  const appId = getOneSignalAppId();
  const restKey = readEnv('ONESIGNAL_REST_API_KEY');

  if (!appId || !restKey) {
    throw new Error(
      'OneSignal is not configured (ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY)'
    );
  }

  try {
    const response = await axios.get(
      `${ONESIGNAL_MESSAGE_URL}/${encodeURIComponent(id)}`,
      {
        params: { app_id: appId },
        headers: { Authorization: `Key ${restKey}` },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

    const body = response.data as
      | { successful?: unknown; failed?: unknown; errored?: unknown }
      | null;

    const delivered =
      body?.successful === undefined ? null : Number(body.successful) || 0;
    const failed = (Number(body?.failed) || 0) + (Number(body?.errored) || 0);

    return { delivered, failed };
  } catch (error) {
    throw new Error(
      `OneSignal report failed: ${describeError(error)}`.slice(0, 500)
    );
  }
};

/**
 * Sends one create-message request. Never logs or rethrows the Authorization
 * header, so a failure cannot leak the REST key into Render's log stream.
 */
export const sendOneSignalMessage = async (
  message: OneSignalMessage
): Promise<OneSignalSendResult> => {
  const appId = getOneSignalAppId();
  const restKey = readEnv('ONESIGNAL_REST_API_KEY');

  if (!appId || !restKey) {
    throw new Error(
      'OneSignal is not configured (ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY)'
    );
  }

  try {
    const response = await axios.post(
      ONESIGNAL_MESSAGE_URL,
      { app_id: appId, ...message },
      {
        headers: {
          Authorization: `Key ${restKey}`,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

    const body = response.data as { id?: unknown; recipients?: unknown } | null;

    return {
      id: typeof body?.id === 'string' ? body.id : null,
      recipients: Number(body?.recipients ?? 0) || 0,
    };
  } catch (error) {
    throw new Error(
      `OneSignal request failed: ${describeError(error)}`.slice(0, 500)
    );
  }
};
