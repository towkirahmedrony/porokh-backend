import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import { TextParseValidationError } from './question.textparse';
import { TextImportValidationError } from './question.textimport';
import { importQuestionText } from './question.textimport.service';

interface AuthReq extends Request {
  user?: { id: string };
  userRole?: string;
}

/**
 * Imports the final approved Structured Plain Text.
 *
 * Nothing has been written when parsing fails; individual invalid blocks are
 * reported in `parse.errors` while the valid blocks still import.
 */
export const importQuestionTextHandler = catchAsync(async (req: AuthReq, res: Response) => {
  if (!req.user?.id) {
    return sendResponse(res, { statusCode: 401, success: false, message: 'Unauthorized' });
  }

  try {
    const result = await importQuestionText(req.body, {
      userId: req.user.id,
      role: req.userRole,
    });

    return sendResponse(res, {
      statusCode: result.dry_run ? 200 : 201,
      success: true,
      message: result.dry_run
        ? 'Import pre-check completed'
        : `${result.counts.imported} of ${result.counts.total} questions imported`,
      data: result,
    });
  } catch (error) {
    if (error instanceof TextImportValidationError || error instanceof TextParseValidationError) {
      return sendResponse(res, {
        statusCode: error.status,
        success: false,
        message: error.message,
      });
    }

    throw error;
  }
});
