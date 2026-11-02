import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_UPDATE_POLICY,
  UpdatePolicyValidationError,
  compareVersions,
  isNativeVersionBelowMinimum,
  parseUpdatePolicy,
  updatePolicySchema,
  validateUpdatePolicy,
} from './update-policy';

const base = {
  enforce_apk_update: true,
  min_native_version: '1.2.0',
  apk_download_url: 'https://porokhbd.vercel.app/porokh.apk',
};

test('defaults enforce nothing', () => {
  assert.equal(DEFAULT_UPDATE_POLICY.enforce_apk_update, false);
  assert.equal(DEFAULT_UPDATE_POLICY.enforce_ota_update, false);
  assert.equal(DEFAULT_UPDATE_POLICY.rollout_percentage, 100);
});

test('a stored policy round-trips through JSON', () => {
  const policy = validateUpdatePolicy({
    ...base,
    enforce_ota_update: true,
    min_ota_version: '1.2.0-ota.production-android.r000042.nv1.1.0.db2',
  });

  const parsed = parseUpdatePolicy(JSON.parse(JSON.stringify(policy)));

  assert.equal(parsed.min_native_version, '1.2.0');
  assert.equal(parsed.min_ota_version, '1.2.0-ota.production-android.r000042.nv1.1.0.db2');
  assert.equal(parsed.schema, 1);
});

test('an absent row means no enforcement rather than an error', () => {
  const parsed = parseUpdatePolicy(null);
  assert.equal(parsed.enforce_apk_update, false);
  assert.equal(parsed.min_native_version, '');
});

test('a malformed stored policy degrades to defaults', () => {
  const parsed = parseUpdatePolicy({ min_native_version: 'not-a-version', rollout_percentage: 500 });
  assert.deepEqual(parsed, DEFAULT_UPDATE_POLICY);
});

test('enforcing APK updates requires a version and an https download URL', () => {
  assert.throws(
    () => validateUpdatePolicy({ enforce_apk_update: true, min_native_version: '1.2.0' }),
    (error: unknown) =>
      error instanceof UpdatePolicyValidationError &&
      /apk_download_url/.test(error.message)
  );

  assert.throws(
    () => validateUpdatePolicy({ enforce_apk_update: true, apk_download_url: 'https://x.test/a.apk' }),
    /min_native_version/
  );
});

test('a non-https APK download URL is rejected', () => {
  assert.throws(
    () => validateUpdatePolicy({ ...base, apk_download_url: 'http://x.test/a.apk' }),
    /https URL/
  );
});

test('a malformed OTA version is rejected', () => {
  assert.throws(
    () => validateUpdatePolicy({ enforce_ota_update: true, min_ota_version: '1.2' }),
    /release version/
  );
});

test('unknown fields are rejected instead of silently stored', () => {
  const result = updatePolicySchema.safeParse({ ...base, secret_token: 'x' });
  assert.equal(result.success, false);
});

test('rollout percentage stays within 0-100', () => {
  assert.equal(validateUpdatePolicy({ rollout_percentage: 0 }).rollout_percentage, 0);
  assert.equal(validateUpdatePolicy({ rollout_percentage: 100 }).rollout_percentage, 100);
  assert.throws(() => validateUpdatePolicy({ rollout_percentage: 101 }));
  assert.throws(() => validateUpdatePolicy({ rollout_percentage: -1 }));
});

test('versions compare numerically, not lexically', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('0.9.0', '1.0.0'), -1);
});

test('the server blocks only a declared version below the minimum', () => {
  const enforced = validateUpdatePolicy(base);

  assert.equal(isNativeVersionBelowMinimum(enforced, '1.1.9'), true);
  assert.equal(isNativeVersionBelowMinimum(enforced, '1.2.0'), false);
  assert.equal(isNativeVersionBelowMinimum(enforced, '1.10.0'), false);
});

test('an unenforced or undeclared client is never blocked', () => {
  assert.equal(
    isNativeVersionBelowMinimum(validateUpdatePolicy({}), '0.0.1'),
    false
  );
  assert.equal(isNativeVersionBelowMinimum(validateUpdatePolicy(base), null), false);
  assert.equal(isNativeVersionBelowMinimum(validateUpdatePolicy(base), 'garbage'), false);
});
