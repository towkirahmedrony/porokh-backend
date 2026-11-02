import { randomUUID } from 'crypto';
import { supabase } from '../../config/supabase';
import type { TablesInsert } from '../../types/database.type';
import { resolveExamReferenceLists } from './exam-references';
import {
  assignResolvedExamReferences,
  importPlanCounts,
  normalizeImportQuestions,
  planImportBatch,
  withContentHashes,
  type ImportPlanRow,
  type NormalizedImportQuestion,
} from './question.import';

/**
 * Import service for the standalone AI Question Importer.
 *
 * It reuses the shared question write policy (`question.policy`) and the shared
 * exam-reference resolution, so an imported question is byte-for-byte what the
 * admin panel would produce. Unlike `saveBulkQuestions`, duplicates are
 * reported instead of silently dropped, and each question's outcome is
 * returned so the importer can keep failures for retry.
 */

const HASH_LOOKUP_CHUNK = 200;
const INSERT_CHUNK = 500;
const HISTORY_ACTION = 'question.import.batch';

export type ImportRowStatus = 'imported' | 'duplicate' | 'failed' | 'invalid';

export interface ImportRowResult {
  index: number;
  status: ImportRowStatus;
  question_id?: string;
  existing_question_id?: string;
  errors: string[];
  warnings: string[];
}

export interface ImportCounts {
  total: number;
  imported: number;
  duplicate: number;
  failed: number;
  invalid: number;
}

export interface ImportBatchResult {
  batch_id: string | null;
  dry_run: boolean;
  counts: ImportCounts;
  results: ImportRowResult[];
}

export interface ImportQuestionsOptions {
  userId: string;
  role?: string | null;
  dryRun?: boolean;
  sourceLabel?: string | null;
  subjectLabels?: string[];
}

export interface ImportHistoryEntry {
  batch_id: string;
  imported_at: string;
  total: number;
  imported: number;
  duplicate: number;
  failed: number;
  invalid: number;
  status: 'completed' | 'partial' | 'failed' | 'duplicate';
  source_label: string | null;
  subject_labels: string[];
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asCount = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const buildCounts = (results: ImportRowResult[]): ImportCounts => ({
  total: results.length,
  imported: results.filter((row) => row.status === 'imported').length,
  duplicate: results.filter((row) => row.status === 'duplicate').length,
  failed: results.filter((row) => row.status === 'failed').length,
  invalid: results.filter((row) => row.status === 'invalid').length,
});

/** Existing `(subject_id, content_hash)` pairs for this batch, in one query per subject. */
const loadExistingHashes = async (
  items: NormalizedImportQuestion[]
): Promise<Map<string, Map<string, string>>> => {
  const hashesBySubject = new Map<string, string[]>();

  for (const item of items) {
    if (item.errors.length > 0 || !item.content_hash) continue;

    const subject = String(item.payload.subject_id ?? '');
    if (!subject) continue;

    const list = hashesBySubject.get(subject) ?? [];
    if (!list.includes(item.content_hash)) list.push(item.content_hash);
    hashesBySubject.set(subject, list);
  }

  const existing = new Map<string, Map<string, string>>();

  await Promise.all(
    Array.from(hashesBySubject.entries()).map(async ([subject, hashes]) => {
      for (let offset = 0; offset < hashes.length; offset += HASH_LOOKUP_CHUNK) {
        const chunk = hashes.slice(offset, offset + HASH_LOOKUP_CHUNK);
        const { data, error } = await supabase
          .from('questions')
          .select('id, content_hash')
          .eq('subject_id', subject)
          .in('content_hash', chunk);

        if (error) throw new Error(error.message);

        const subjectIndex = existing.get(subject) ?? new Map<string, string>();

        for (const row of data ?? []) {
          const hash = (row as { content_hash?: unknown }).content_hash;
          const id = (row as { id?: unknown }).id;
          if (typeof hash === 'string' && typeof id === 'string') subjectIndex.set(hash, id);
        }

        existing.set(subject, subjectIndex);
      }
    })
  );

  return existing;
};

/**
 * Resolves reference lists for the whole batch in one pass. If the batch
 * resolver rejects one reference, each question is resolved on its own so a
 * single bad reference fails only that question.
 */
const resolveReferences = async (
  items: NormalizedImportQuestion[]
): Promise<Array<unknown[] | null | undefined>> => {
  const valid = items.filter((item) => item.errors.length === 0);
  if (valid.length === 0) return items.map(() => undefined);

  const resolvedByIndex = new Map<number, unknown[] | null | undefined>();

  try {
    const lists = await resolveExamReferenceLists(
      valid.map((item) => item.payload.exam_references)
    );
    valid.forEach((item, position) => resolvedByIndex.set(item.index, lists[position]));
  } catch {
    await Promise.all(
      valid.map(async (item) => {
        try {
          const [resolved] = await resolveExamReferenceLists([item.payload.exam_references]);
          resolvedByIndex.set(item.index, resolved);
        } catch (error) {
          item.errors.push(
            error instanceof Error ? error.message : 'The exam reference could not be resolved.'
          );
        }
      })
    );
  }

  return items.map((item) => resolvedByIndex.get(item.index));
};

const recordImportBatch = async (
  batchId: string,
  options: ImportQuestionsOptions,
  counts: ImportCounts
): Promise<void> => {
  const { error } = await supabase.from('audit_logs').insert({
    user_id: options.userId,
    action: HISTORY_ACTION,
    target_table: 'questions',
    target_id: batchId,
    details: {
      batch_id: batchId,
      total: counts.total,
      imported: counts.imported,
      duplicate: counts.duplicate,
      failed: counts.failed,
      invalid: counts.invalid,
      source_label: options.sourceLabel ?? null,
      subject_labels: options.subjectLabels ?? [],
    },
  });

  // History is reporting, not the import itself: a failed audit write must not
  // turn a successful import into an error response.
  if (error) {
    console.error('[question-import] batch history could not be recorded');
  }
};

const insertOne = async (
  item: NormalizedImportQuestion,
  planRow: ImportPlanRow,
  options: ImportQuestionsOptions
): Promise<{ row: ImportRowResult; id?: string }> => {
  const record = {
    ...(item.payload as unknown as TablesInsert<'questions'>),
    content_hash: item.content_hash,
    created_by: options.userId,
    is_embedding_stale: true,
  } as TablesInsert<'questions'>;

  const { data, error } = await supabase.from('questions').insert(record).select('id').single();

  if (!error && data) {
    const id = (data as { id?: unknown }).id;
    return {
      row: {
        index: planRow.index,
        status: 'imported',
        question_id: typeof id === 'string' ? id : undefined,
        errors: [],
        warnings: planRow.warnings,
      },
      id: typeof id === 'string' ? id : undefined,
    };
  }

  if (error?.code === '23505') {
    return {
      row: {
        index: planRow.index,
        status: 'duplicate',
        errors: ['This question already exists in the question bank.'],
        warnings: planRow.warnings,
      },
    };
  }

  return {
    row: {
      index: planRow.index,
      status: 'failed',
      errors: [error?.message || 'The question could not be inserted.'],
      warnings: planRow.warnings,
    },
  };
};

/**
 * Imports a batch of questions.
 *
 * `dryRun` runs the same validation, reference resolution and duplicate
 * detection without writing, which is what the importer uses for its pre-import
 * duplicate report.
 */
export const importQuestions = async (
  input: unknown,
  options: ImportQuestionsOptions
): Promise<ImportBatchResult> => {
  const normalized = normalizeImportQuestions(input, options.role);
  const resolvedLists = await resolveReferences(normalized);
  const items = withContentHashes(assignResolvedExamReferences(normalized, resolvedLists));

  const existing = await loadExistingHashes(items);
  const plan = planImportBatch(items, existing);
  const itemsByIndex = new Map(items.map((item) => [item.index, item]));
  const planByIndex = new Map(plan.map((row) => [row.index, row]));

  const results: ImportRowResult[] = plan.map((row) => ({
    index: row.index,
    status: row.action === 'insert' ? 'failed' : row.action,
    ...(row.action === 'duplicate' && row.existing_id
      ? { existing_question_id: row.existing_id }
      : {}),
    errors: row.errors,
    warnings: row.warnings,
  }));

  const planCounts = importPlanCounts(plan);

  if (options.dryRun === true) {
    return {
      batch_id: null,
      dry_run: true,
      counts: {
        total: planCounts.total,
        imported: planCounts.insert,
        duplicate: planCounts.duplicate,
        failed: 0,
        invalid: planCounts.invalid,
      },
      results,
    };
  }

  const batchId = randomUUID();
  const insertRows = plan.filter((row) => row.action === 'insert');

  for (let offset = 0; offset < insertRows.length; offset += INSERT_CHUNK) {
    const chunk = insertRows.slice(offset, offset + INSERT_CHUNK);
    const chunkRecords = chunk.map((row) => {
      const item = itemsByIndex.get(row.index)!;
      return {
        ...(item.payload as unknown as TablesInsert<'questions'>),
        content_hash: item.content_hash,
        created_by: options.userId,
        is_embedding_stale: true,
      } as TablesInsert<'questions'>;
    });

    const { data, error } = await supabase
      .from('questions')
      .insert(chunkRecords)
      .select('id, content_hash');

    if (!error) {
      const idsByHash = new Map<string, string>();
      for (const row of data ?? []) {
        const hash = (row as { content_hash?: unknown }).content_hash;
        const id = (row as { id?: unknown }).id;
        if (typeof hash === 'string' && typeof id === 'string') idsByHash.set(hash, id);
      }

      for (const row of chunk) {
        const hash = itemsByIndex.get(row.index)?.content_hash ?? '';
        const resultIndex = results.findIndex((result) => result.index === row.index);
        if (resultIndex === -1) continue;
        results[resultIndex] = {
          index: row.index,
          status: 'imported',
          ...(idsByHash.get(hash) ? { question_id: idsByHash.get(hash)! } : {}),
          errors: [],
          warnings: row.warnings,
        };
      }
      continue;
    }

    // One row in the chunk was rejected: retry the chunk row by row so the
    // rest of the batch still imports and the failure is attributed exactly.
    for (const row of chunk) {
      const item = itemsByIndex.get(row.index)!;
      const planRow = planByIndex.get(row.index)!;
      const { row: singleResult } = await insertOne(item, planRow, options);
      const resultIndex = results.findIndex((result) => result.index === row.index);
      if (resultIndex !== -1) results[resultIndex] = singleResult;
    }
  }

  const counts = buildCounts(results);
  await recordImportBatch(batchId, options, counts);

  return { batch_id: batchId, dry_run: false, counts, results };
};

/** Import batches recorded for the calling user, newest first. */
export const getQuestionImportHistory = async (
  userId: string,
  limit = 50
): Promise<ImportHistoryEntry[]> => {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);

  const { data, error } = await supabase
    .from('audit_logs')
    .select('id, details, created_at')
    .eq('action', HISTORY_ACTION)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => {
    const record = row as Record<string, unknown>;
    const details = asRecord(record.details) ?? {};
    const imported = asCount(details.imported);
    const duplicate = asCount(details.duplicate);
    const failed = asCount(details.failed);
    const invalid = asCount(details.invalid);

    const status: ImportHistoryEntry['status'] =
      failed > 0
        ? imported > 0
          ? 'partial'
          : 'failed'
        : imported === 0 && duplicate > 0
          ? 'duplicate'
          : 'completed';

    return {
      batch_id:
        typeof details.batch_id === 'string'
          ? details.batch_id
          : String(record.id ?? ''),
      imported_at: String(record.created_at ?? ''),
      total: asCount(details.total),
      imported,
      duplicate,
      failed,
      invalid,
      status,
      source_label: typeof details.source_label === 'string' ? details.source_label : null,
      subject_labels: asStringList(details.subject_labels),
    };
  });
};
