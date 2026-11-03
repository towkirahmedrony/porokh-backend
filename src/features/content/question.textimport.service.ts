import { parseQuestionText, type ParseIssue, type TextParseResult } from './question.textparse';
import { checkParsedReferences } from './question.refcheck.service';
import type { ReferenceCheck } from './question.refcheck';
import * as questionImportService from './question.import.service';
import type { ImportBatchResult } from './question.import.service';
import { applyTextImportTaxonomy, readTextImportRequest } from './question.textimport';

/**
 * Plain-text import for the AI Question Importer.
 *
 * Receives only the final Structured Plain Text, parses it with the same
 * parser the preview uses, links institution/unit names, adds the selected
 * curriculum ids and then reuses the existing import service (validation,
 * duplicate detection, reference resolution, Supabase insert and history).
 * No file, image or AI provider is involved here.
 */

export interface TextImportOptions {
  userId: string;
  role?: string | null;
}

export interface TextImportParseSummary {
  counts: TextParseResult['counts'];
  errors: ParseIssue[];
  warnings: ParseIssue[];
  reference_checks: ReferenceCheck[];
}

export interface TextImportResult extends ImportBatchResult {
  parse: TextImportParseSummary;
}

export const importQuestionText = async (
  body: unknown,
  options: TextImportOptions
): Promise<TextImportResult> => {
  const { text, taxonomy } = readTextImportRequest(body);
  const record = (body ?? {}) as Record<string, unknown>;

  const parsed = parseQuestionText(text);
  const warnings = [...parsed.warnings];

  // References are best-effort: the import service resolves them again, and a
  // database hiccup here must not block an otherwise valid text import.
  let referenceChecks: ReferenceCheck[] = [];
  try {
    referenceChecks = await checkParsedReferences(parsed.questions);
  } catch {
    warnings.push({
      question: 0,
      line: 0,
      messages: ['The institution check is unavailable right now; names were left as typed.'],
    });
  }

  const result = await questionImportService.importQuestions(
    applyTextImportTaxonomy(parsed.questions, taxonomy),
    {
      userId: options.userId,
      role: options.role,
      dryRun: record.dry_run === true,
      sourceLabel: typeof record.source_label === 'string' ? record.source_label : null,
      subjectLabels: Array.isArray(record.subject_labels)
        ? record.subject_labels.filter((label): label is string => typeof label === 'string')
        : [],
    }
  );

  return {
    ...result,
    parse: {
      counts: parsed.counts,
      errors: parsed.errors,
      warnings,
      reference_checks: referenceChecks,
    },
  };
};
