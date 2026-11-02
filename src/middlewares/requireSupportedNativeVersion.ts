import { NextFunction, Request, Response } from 'express';
import { getUpdatePolicy } from '../features/system/system.service';
import {
  isNativeVersionBelowMinimum,
  type UpdatePolicy,
} from '../features/system/update-policy';

/**
 * Server-side half of the mandatory APK update policy.
 *
 * The client shows the blocking screen; this guard makes sure an outdated APK
 * cannot keep calling student APIs by skipping it. It is deliberately narrow:
 *
 *  - only clients that declare an installed version are checked. The website,
 *    the admin panel and any older APK send no header, so nothing changes for
 *    them and the guard can be rolled out without breaking existing builds;
 *  - it never runs on `/auth` or `/system`, so an outdated app can still sign
 *    in and read the policy that tells it to update;
 *  - it fails open when the policy cannot be read. Losing a database round-trip
 *    must not take the API down for everyone.
 */
const POLICY_CACHE_MS = 30_000;

let policyCache: { at: number; policy: UpdatePolicy } | null = null;

const loadPolicy = async (): Promise<UpdatePolicy | null> => {
  if (policyCache && Date.now() - policyCache.at < POLICY_CACHE_MS) {
    return policyCache.policy;
  }
  try {
    const policy = await getUpdatePolicy();
    policyCache = { at: Date.now(), policy };
    return policy;
  } catch {
    return null;
  }
};

export const requireSupportedNativeVersion = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const installed = req.header('x-native-version')?.trim();
  if (!installed) return next();

  const policy = await loadPolicy();
  if (!policy) return next();

  if (!isNativeVersionBelowMinimum(policy, installed)) return next();

  // `sendResponse` drops custom fields, so the code is written directly.
  return res.status(426).json({
    success: false,
    message: 'This app version is no longer supported. Install the latest APK to continue.',
    errorCode: 'NATIVE_UPDATE_REQUIRED',
    data: {
      minVersion: policy.min_native_version,
      downloadUrl: policy.apk_download_url || null,
    },
  });
};
