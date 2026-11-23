import { timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import { runDispatchOnce } from './notifications.dispatcher';

/**
 * External cron entry point.
 *
 * Render sleeps on the free plan, so the in-process timer is only a backstop.
 * cron-job.org calls this route; the shared secret is compared in constant time
 * and is never logged.
 */

const secretMatches = (supplied: string | undefined, expected: string): boolean => {
  const left = Buffer.from(String(supplied ?? ''));
  const right = Buffer.from(expected);

  // timingSafeEqual throws on different lengths, which would itself leak the
  // length through an exception path.
  return left.length === right.length && timingSafeEqual(left, right);
};

export const dispatchController = catchAsync(async (req: Request, res: Response) => {
  // Same secret as the group tick job unless a dedicated one is set, so the
  // scheduler only needs one header.
  const expected = String(
    process.env.INTERNAL_CRON_SECRET ?? process.env.CRON_SECRET ?? ''
  ).trim();

  if (!expected) {
    sendResponse(res, {
      statusCode: 503,
      success: false,
      message: 'Notification dispatch is not configured',
    });
    return;
  }

  const supplied =
    req.header('x-internal-secret') ??
    req.header('x-cron-secret') ??
    (req.header('authorization')?.startsWith('Bearer ')
      ? req.header('authorization')?.slice('Bearer '.length)
      : '');

  if (!secretMatches(supplied, expected)) {
    sendResponse(res, { statusCode: 401, success: false, message: 'Unauthorized' });
    return;
  }

  const summary = await runDispatchOnce();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: summary ? 'Dispatch completed' : 'Dispatch already running',
    data: summary ?? { skipped: true },
  });
});
