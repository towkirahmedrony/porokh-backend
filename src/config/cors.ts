import type { CorsOptions } from 'cors';

/**
 * Capacitor's Android WebView loads the bundled app from these origins. They
 * are fixed by the Capacitor runtime, not by an operator, so they are always
 * allowed. Without them every request from the packaged APK is rejected at
 * preflight even though the same browser build works.
 */
export const CAPACITOR_ORIGINS = ['https://localhost', 'capacitor://localhost'] as const;

/**
 * Deployed browser origins come from the two Firebase Hosting projects in the
 * client repositories: the user app (.firebaserc project `parapothexam`) and
 * the admin panel (hosting target `admin` -> site `parapoth-studio`). Firebase
 * serves every site on both `<site>.web.app` and `<project>.firebaseapp.com`.
 * Any additional deployment (Vercel preview, custom domain) belongs in
 * CLIENT_URL instead of this list.
 */
export const FIREBASE_HOSTING_ORIGINS = [
  'https://parapothexam.web.app',
  'https://parapothexam.firebaseapp.com',
  'https://parapoth-studio.web.app',
] as const;

/** Local tooling only: these must never widen the production allowlist. */
export const LOCAL_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
] as const;

/**
 * Browsers serialise `Origin` without a path or trailing slash. Operators,
 * however, routinely paste `https://example.com/` into CLIENT_URL. Comparing
 * the two raw strings rejected the production origin and turned every
 * preflight into a 500, so both sides are normalised before comparison.
 */
export const normalizeOrigin = (value: string): string =>
  value.trim().replace(/\/+$/, '').toLowerCase();

/** Parse the comma-separated CLIENT_URL variable into normalised origins. */
export const parseClientUrls = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);

export interface AllowedOriginOptions {
  clientUrl?: string;
  nodeEnv?: string;
}

/**
 * Build the complete CORS allowlist. Order is stable and duplicates are
 * removed so tests and operators can reason about the exact set.
 */
export const buildAllowedOrigins = ({
  clientUrl,
  nodeEnv = process.env.NODE_ENV,
}: AllowedOriginOptions = {}): string[] => {
  const origins = [
    ...CAPACITOR_ORIGINS,
    ...FIREBASE_HOSTING_ORIGINS,
    ...parseClientUrls(clientUrl),
  ];

  if (nodeEnv !== 'production') {
    origins.push(...LOCAL_DEV_ORIGINS);
  }

  return [...new Set(origins.map(normalizeOrigin).filter((origin) => Boolean(origin) && origin !== '*'))];
};

/** Requests without an Origin header (curl, server-to-server) stay allowed. */
export const isOriginAllowed = (
  origin: string | undefined,
  allowedOrigins: readonly string[]
): boolean => !origin || allowedOrigins.includes(normalizeOrigin(origin));

interface CorsError extends Error {
  status?: number;
}

/**
 * CORS middleware options shared by the Express app. `credentials: true` is
 * required for the Supabase bearer token flow and is only meaningful because
 * the allowed origin is echoed instead of wildcarded.
 */
export const createCorsOptions = (
  options: AllowedOriginOptions = {}
): CorsOptions => {
  const allowedOrigins = buildAllowedOrigins(options);

  return {
    origin: function (origin, callback) {
      if (isOriginAllowed(origin, allowedOrigins)) {
        callback(null, true);
      } else {
        // A rejected origin is a client error, not an internal failure.
        // Returning 403 keeps monitoring meaningful and makes it greppable.
        const error = new Error('Origin not allowed by CORS') as CorsError;
        error.status = 403;
        callback(error);
      }
    },
    credentials: true,
  };
};
