import { z } from 'zod';

/**
 * Central update policy for the Porokh clients.
 *
 * Stored as the `value` of the `app_configs` row whose key is
 * `UPDATE_POLICY_KEY`. `app_configs.value` is already `jsonb`, so the policy
 * needs no column and no migration; the existing admin-guarded
 * `PUT /system/configs` route writes it and the existing audit log records who
 * changed it.
 *
 * Three version identities are deliberately kept apart, because they move
 * independently:
 *
 *  - website  — what Vercel serves. The app reloads to pick it up.
 *  - native   — the installed APK. Only a new APK can change it.
 *  - ota      — the JS bundle the APK is running. A GitHub-Releases OTA bundle
 *               changes it, within the native floor the APK allows.
 *
 * Treating them as one number is what made the old `min_app_version` check
 * compare the web bundle version against an APK requirement.
 */
export const UPDATE_POLICY_KEY = 'update_policy';
export const UPDATE_POLICY_SCHEMA = 1;

export class UpdatePolicyValidationError extends Error {
  status = 400;
  errorCode = 'VALIDATION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'UpdatePolicyValidationError';
  }
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * A release version: plain semver, or the full OTA bundle version produced by
 * `buildReleaseVersion` in the student app
 * (`1.0.2-ota.production-android.r000123.nv1.0.1.db2`).
 */
const OTA_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-ota\.[a-z0-9][a-z0-9-]*\.(?:r\d{6}\.)?nv\d+(?:\.\d+){0,2}\.db\d+)?$/;

/**
 * Compare two dotted version strings numerically (`1.10.0` > `1.9.9`).
 * Missing segments count as zero, so `1.2` equals `1.2.0`.
 */
export const compareVersions = (left: string, right: string): number => {
  const a = left.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
};

/** Whether an installed native version is below the enforced minimum. */
export const isNativeVersionBelowMinimum = (
  policy: Pick<UpdatePolicy, 'enforce_apk_update' | 'min_native_version'>,
  installedVersion: string | null | undefined
): boolean => {
  if (!policy.enforce_apk_update || policy.min_native_version === '') return false;
  if (!installedVersion || !SEMVER_PATTERN.test(installedVersion.trim())) return false;
  return compareVersions(installedVersion, policy.min_native_version) < 0;
};

const text = (max: number) => z.string().trim().max(max);

const semverOrEmpty = text(20).refine(
  (value) => value === '' || SEMVER_PATTERN.test(value),
  'Expected a semver version like 1.2.3, or an empty string'
);

const otaVersionOrEmpty = text(160).refine(
  (value) => value === '' || OTA_VERSION_PATTERN.test(value),
  'Expected a release version like 1.2.3 or 1.2.3-ota.<channel>.r000001.nv1.2.0.db2'
);

const httpsUrlOrEmpty = text(500).refine((value) => {
  if (value === '') return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}, 'Expected an https URL, or an empty string');

export const updatePolicySchema = z
  .object({
    schema: z.literal(UPDATE_POLICY_SCHEMA).default(UPDATE_POLICY_SCHEMA),

    /** Mandatory APK update: the installed native version must reach this. */
    enforce_apk_update: z.boolean().default(false),
    min_native_version: semverOrEmpty.default(''),
    latest_native_version: semverOrEmpty.default(''),
    apk_download_url: httpsUrlOrEmpty.default(''),

    /** Mandatory OTA update: the running bundle must reach this version. */
    enforce_ota_update: z.boolean().default(false),
    min_ota_version: otaVersionOrEmpty.default(''),
    latest_ota_version: otaVersionOrEmpty.default(''),

    /** Non-blocking "an update is ready" prompt. */
    optional_update_enabled: z.boolean().default(false),
    optional_update_title: text(120).default(''),
    optional_update_description: text(400).default(''),

    /** Copy for the blocking screens. Empty means "use the bundled copy". */
    mandatory_update_title: text(120).default(''),
    mandatory_update_description: text(400).default(''),

    /**
     * Share of devices shown the *optional* prompt. Mandatory policies always
     * apply to everyone; a rollout percentage never hides a required update.
     */
    rollout_percentage: z.number().int().min(0).max(100).default(100),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.enforce_apk_update) {
      if (policy.min_native_version === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['min_native_version'],
          message: 'A minimum native version is required when APK updates are enforced',
        });
      }
      if (policy.apk_download_url === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['apk_download_url'],
          message: 'An APK download URL is required when APK updates are enforced',
        });
      }
    }

    if (policy.enforce_ota_update && policy.min_ota_version === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['min_ota_version'],
        message: 'A minimum OTA version is required when OTA updates are enforced',
      });
    }
  });

export type UpdatePolicy = z.infer<typeof updatePolicySchema>;

export const DEFAULT_UPDATE_POLICY: UpdatePolicy = updatePolicySchema.parse({});

/**
 * Normalise a stored policy.
 *
 * A missing row, or one written by an older schema, must never take the app
 * offline: it falls back to the defaults (nothing enforced) rather than
 * throwing on a read path.
 */
export const parseUpdatePolicy = (raw: unknown): UpdatePolicy => {
  const result = updatePolicySchema.safeParse(raw ?? {});
  if (!result.success) return { ...DEFAULT_UPDATE_POLICY };
  return result.data;
};

/** Strict parse for a write. Throws `UpdatePolicyValidationError`. */
export const validateUpdatePolicy = (raw: unknown): UpdatePolicy => {
  const result = updatePolicySchema.safeParse(raw ?? {});
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'policy'}: ${issue.message}`)
      .join('; ');
    throw new UpdatePolicyValidationError(detail);
  }
  return result.data;
};
