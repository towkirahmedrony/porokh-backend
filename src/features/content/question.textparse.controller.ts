import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import { parseQuestionText, TextParseValidationError } from './question.textparse';
import { checkParsedReferences } from './question.refcheck.service';
import { stripUnitGroups, type ReferenceCheck } from './question.refcheck';

/**
 * Preview-only: turns pasted plain text into question objects, links each
 * institution/unit to the database, and reports what needs fixing. Nothing is
 * written to the database.
 */
export const parseQuestionTextHandler = catchAsync(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  try {
    const result = parseQuestionText(body.text);
    const warnings = [...result.warnings];
    let referenceChecks: ReferenceCheck[] = [];

    try {
      referenceChecks = await checkParsedReferences(result.questions);
    } catch {
      // The parse itself is still valid; the import re-checks references anyway.
      stripUnitGroups(result.questions);
      warnings.push({
        question: 0,
        line: 0,
        messages: ['The institution check is unavailable right now; names were left as typed.'],
      });
    }

    return sendResponse(res, {
      statusCode: 200,
      success: true,
      message: `${result.counts.valid} of ${result.counts.total} questions parsed`,
      data: { ...result, warnings, reference_checks: referenceChecks },
    });
  } catch (error) {
    if (error instanceof TextParseValidationError) {
      return sendResponse(res, {
        statusCode: error.status,
        success: false,
        message: error.message,
      });
    }

    throw error;
  }
});
