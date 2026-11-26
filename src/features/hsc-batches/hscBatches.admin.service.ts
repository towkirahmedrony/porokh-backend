import { supabaseAdmin } from '../../config/supabaseAdmin';
import { recordAdminAudit } from '../../lib/utils/adminAudit';
import { dhakaDayKey } from '../../lib/utils/time';
import { isExamEnded } from '../../lib/utils/stage';
import {
  HscBatchesError,
  type BatchRow,
  type CreateBatchInput,
  type UpdateBatchInput,
} from './hscBatches.types';

const BATCH_COLUMNS = 'batch_year, exam_end_date, notes, updated_at, updated_by';

interface BatchRecord {
  batch_year: string;
  exam_end_date: string | null;
  notes: string | null;
  updated_at: string;
  updated_by: string | null;
}

interface ProfileGoalRow {
  hsc_batch: string | null;
  study_goal: string | null;
  goal_confirmed_at: string | null;
}

// Re-exported so the spec and the routes keep one import for the rule; the
// implementation lives in lib/utils/stage.ts and is shared with the admin read
// models rather than copied.
export { isExamEnded };

/** A goal counts as settled only when it is a real admission goal and confirmed. */
const needsGoal = (row: ProfileGoalRow): boolean =>
  row.study_goal === null ||
  row.study_goal === 'hsc' ||
  row.goal_confirmed_at === null;

const countByBatch = (rows: ProfileGoalRow[]) => {
  const counts = new Map<string, { students: number; pending: number }>();

  for (const row of rows) {
    if (!row.hsc_batch) continue;

    const entry = counts.get(row.hsc_batch) ?? { students: 0, pending: 0 };
    entry.students += 1;
    if (needsGoal(row)) entry.pending += 1;
    counts.set(row.hsc_batch, entry);
  }

  return counts;
};

const toBatchRow = (
  record: BatchRecord,
  counts: ReturnType<typeof countByBatch>,
  today: string
): BatchRow => {
  const entry = counts.get(record.batch_year);

  return {
    batch_year: record.batch_year,
    exam_end_date: record.exam_end_date,
    notes: record.notes,
    updated_at: record.updated_at,
    updated_by: record.updated_by,
    student_count: entry?.students ?? 0,
    pending_goal_count: entry?.pending ?? 0,
    exam_ended: isExamEnded(record.exam_end_date, today),
  };
};

const readBatch = async (year: string): Promise<BatchRecord> => {
  const { data, error } = await supabaseAdmin
    .from('hsc_batches')
    .select(BATCH_COLUMNS)
    .eq('batch_year', year)
    .maybeSingle();

  if (error) throw new HscBatchesError('Batches are temporarily unavailable', 503);
  if (!data) throw new HscBatchesError(`Batch ${year} does not exist`, 404);

  return data as BatchRecord;
};

const readGoalRows = async (): Promise<ProfileGoalRow[]> => {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('hsc_batch, study_goal, goal_confirmed_at')
    .not('hsc_batch', 'is', null);

  if (error) throw new HscBatchesError('Student counts are temporarily unavailable', 503);

  return (data ?? []) as ProfileGoalRow[];
};

export const listBatches = async (): Promise<BatchRow[]> => {
  const today = dhakaDayKey(new Date());
  const [{ data, error }, goalRows] = await Promise.all([
    supabaseAdmin.from('hsc_batches').select(BATCH_COLUMNS).order('batch_year', { ascending: false }),
    readGoalRows(),
  ]);

  if (error) throw new HscBatchesError('Batches are temporarily unavailable', 503);

  const counts = countByBatch(goalRows);
  return ((data ?? []) as BatchRecord[]).map((record) => toBatchRow(record, counts, today));
};

const withCounts = async (year: string): Promise<BatchRow> => {
  const today = dhakaDayKey(new Date());
  const [record, goalRows] = await Promise.all([readBatch(year), readGoalRows()]);

  return toBatchRow(record, countByBatch(goalRows), today);
};

export const createBatch = async (actorId: string, input: CreateBatchInput): Promise<BatchRow> => {
  const { error } = await supabaseAdmin.from('hsc_batches').insert({
    batch_year: input.batch_year,
    exam_end_date: input.exam_end_date,
    notes: input.notes,
    updated_by: actorId,
  });

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new HscBatchesError(`Batch ${input.batch_year} already exists`, 409);
    }
    throw new HscBatchesError('Batch could not be created', 503);
  }

  await recordAdminAudit(actorId, 'hsc_batch.create', 'hsc_batches', input.batch_year, {
    exam_end_date: input.exam_end_date,
  });

  return withCounts(input.batch_year);
};

export interface UpdateBatchResult extends BatchRow {
  affected_students: number;
}

/**
 * `affected_students` answers the admin's question before they confirm: how
 * many students in this batch would move from studying to the goal gate if the
 * date change takes effect. It only counts on the transition into "ended",
 * because that is the only direction that changes a stage.
 */
export const updateBatch = async (
  actorId: string,
  year: string,
  patch: UpdateBatchInput
): Promise<UpdateBatchResult> => {
  const current = await readBatch(year);
  const today = dhakaDayKey(new Date());

  const nextDate =
    patch.exam_end_date === undefined ? current.exam_end_date : patch.exam_end_date;
  const nextNotes = patch.notes === undefined ? current.notes : patch.notes;
  const crossesIntoEnded =
    !isExamEnded(current.exam_end_date, today) && isExamEnded(nextDate, today);

  const { error } = await supabaseAdmin
    .from('hsc_batches')
    .update({ exam_end_date: nextDate, notes: nextNotes, updated_by: actorId })
    .eq('batch_year', year);

  if (error) throw new HscBatchesError('Batch could not be updated', 503);

  await recordAdminAudit(actorId, 'hsc_batch.update', 'hsc_batches', year, {
    before: { exam_end_date: current.exam_end_date, notes: current.notes },
    after: { exam_end_date: nextDate, notes: nextNotes },
  });

  const row = await withCounts(year);

  return {
    ...row,
    affected_students: crossesIntoEnded ? row.pending_goal_count : 0,
  };
};
