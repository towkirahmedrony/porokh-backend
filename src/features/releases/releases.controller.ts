import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import * as ReleaseService from './releases.service';
import { assertValidApk, parseApkUploadMetadata } from './releases.validation';

/**
 * Public: the currently published APK and where to download it.
 *
 * 404 (not an empty 200) when nothing is published, so a caller cannot mistake
 * "no release" for "a release with no fields".
 */
export const getLatestRelease = catchAsync(async (_req: Request, res: Response) => {
  const release = await ReleaseService.getCurrentRelease();

  if (!release) {
    return sendResponse(res, {
      statusCode: 404,
      success: false,
      message: 'No Android APK is currently available',
      data: { available: false },
    });
  }

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Latest Android APK fetched successfully',
    data: release,
  });
});

/** Admin: same payload, but an unpublished release is a normal state, not 404. */
export const getAdminRelease = catchAsync(async (_req: Request, res: Response) => {
  const release = await ReleaseService.getCurrentRelease();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: release ? 'Current Android APK fetched successfully' : 'No Android APK is published',
    data: release ?? { available: false },
  });
});

/**
 * Admin: upload or replace the APK.
 *
 * The body is the raw APK (registered as express.raw for this path), and the
 * version metadata arrives as query parameters.
 */
export const uploadRelease = catchAsync(async (req: Request, res: Response) => {
  const metadata = parseApkUploadMetadata(req.query);
  const file = assertValidApk(req.body);

  const release = await ReleaseService.publishApk({
    file,
    versionName: metadata.versionName,
    versionCode: metadata.versionCode,
    originalFilename: metadata.originalFilename,
    publishedBy: req.user?.id ?? null,
  });

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Android APK published',
    data: release,
  });
});

/** Admin: delete the current APK (and stop advertising it). */
export const deleteRelease = catchAsync(async (_req: Request, res: Response) => {
  const deleted = await ReleaseService.deleteCurrentRelease();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: deleted
      ? 'Android APK deleted'
      : 'No Android APK was published',
    data: { available: false, deleted },
  });
});
