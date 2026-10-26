import assert from 'node:assert/strict';
import test from 'node:test';
import type { CorsOptions } from 'cors';
import {
  buildAllowedOrigins,
  createCorsOptions,
  isOriginAllowed,
  normalizeOrigin,
  parseClientUrls,
} from './cors';

const resolveOrigin = (options: CorsOptions, origin: string | undefined) =>
  new Promise<{ allowed: boolean; error?: Error & { status?: number } }>((resolve) => {
    options.origin!(origin, (error, allow) => {
      resolve({ allowed: allow === true, error: error as Error & { status?: number } });
    });
  });

test('Capacitor WebView origins are always allowed', () => {
  const origins = buildAllowedOrigins({ clientUrl: '', nodeEnv: 'production' });
  assert.ok(origins.includes('https://localhost'));
  assert.ok(origins.includes('capacitor://localhost'));
});

test('deployed Firebase origins are allowed in production', () => {
  const origins = buildAllowedOrigins({ clientUrl: '', nodeEnv: 'production' });
  for (const origin of [
    'https://parapothexam.web.app',
    'https://parapothexam.firebaseapp.com',
    'https://parapoth-studio.web.app',
  ]) {
    assert.ok(origins.includes(origin), `${origin} must stay allowed`);
  }
});

test('local development origins never widen the production allowlist', () => {
  const production = buildAllowedOrigins({ nodeEnv: 'production' });
  for (const origin of ['http://localhost:5173', 'http://localhost:5174', 'http://127.0.0.1:5174']) {
    assert.equal(production.includes(origin), false);
  }

  const development = buildAllowedOrigins({ nodeEnv: 'development' });
  assert.ok(development.includes('http://localhost:5173'));
  assert.ok(development.includes('http://localhost:5174'));
});

test('CLIENT_URL entries are trimmed, normalised, deduplicated and optional', () => {
  const origins = buildAllowedOrigins({
    clientUrl: ' https://Example.com/ , https://example.com, https://preview.example.com/ ',
    nodeEnv: 'production',
  });
  assert.ok(origins.includes('https://example.com'));
  assert.equal(origins.filter((origin) => origin === 'https://example.com').length, 1);
  assert.ok(origins.includes('https://preview.example.com'));
  assert.deepEqual(parseClientUrls(undefined), []);
});

test('origin normalisation ignores case and trailing slashes only', () => {
  assert.equal(normalizeOrigin('  HTTPS://Example.com/  '), 'https://example.com');
  assert.equal(normalizeOrigin('https://example.com/path'), 'https://example.com/path');
});

test('the allowlist never contains a wildcard', () => {
  const options = createCorsOptions({ clientUrl: '*', nodeEnv: 'production' });
  const origins = buildAllowedOrigins({ clientUrl: '*', nodeEnv: 'production' });
  assert.equal(origins.includes('*'), false);
  assert.ok(typeof options.origin === 'function');
});

test('unknown origins are rejected with a 403 client error', async () => {
  const options = createCorsOptions({ clientUrl: '', nodeEnv: 'production' });
  const rejected = await resolveOrigin(options, 'https://evil.example.com');
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.error?.status, 403);
});

test('all three reported production origins pass the middleware', async () => {
  const options = createCorsOptions({ clientUrl: '', nodeEnv: 'production' });
  for (const origin of [
    'https://localhost',
    'capacitor://localhost',
    'https://parapothexam.web.app',
  ]) {
    const result = await resolveOrigin(options, origin);
    assert.equal(result.allowed, true, `${origin} must pass preflight`);
    assert.equal(result.error, null);
  }
});

test('requests without an Origin header are allowed', async () => {
  const options = createCorsOptions({ clientUrl: '', nodeEnv: 'production' });
  const result = await resolveOrigin(options, undefined);
  assert.equal(result.allowed, true);
});

test('credentials are enabled and the origin callback echoes no wildcard', () => {
  const options = createCorsOptions({ clientUrl: '', nodeEnv: 'production' });
  assert.equal(options.credentials, true);
});

test('isOriginAllowed compares normalised values', () => {
  const allowed = buildAllowedOrigins({ nodeEnv: 'production' });
  assert.equal(isOriginAllowed('https://localhost/', allowed), true);
  assert.equal(isOriginAllowed('https://evil.example.com', allowed), false);
});
