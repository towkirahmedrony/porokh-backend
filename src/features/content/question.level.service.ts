import { supabase } from '../../config/supabase';
import {
  ATTENTION_BUCKETS,
  PREPARATION_TRACK_IDS,
  type AttentionBucket,
  type PreparationTrackId,
  type ResolvedLevelFilter,
} from './question.level';

/**
 * Admin access to a question's level and tracks.
 *
 * Reads go through get_question_level_report(), which reads the same view the
 * student bank uses, so an "untracked" count in the admin panel cannot disagree
 * with what a student sees. Writes are plain rows in
 * question_preparation_tracks with source 'manual', which is the only way to
 * override the automatic derivation.
 */

const ID_CHUNK = 200;

const chunk = <T>(values: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
};

const uniqueIds = (ids: readonly unknown[]): string[] =>
  Array.from(
    new Set(
      ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    )
  );

export interface LevelReportRow {
  bucket: AttentionBucket;
  question_id: string;
  subject_id: string | null;
  track_ids: string[];
  has_university_reference: boolean;
}

export interface LevelReport {
  counts: Record<AttentionBucket, number>;
  total: number;
  rows: LevelReportRow[];
}

const emptyCounts = (): Record<AttentionBucket, number> => ({
  untracked: 0,
  manual_admission_without_reference: 0,
  university_reference_without_admission_track: 0,
  blank_institution_reference: 0,
});

const isBucket = (value: unknown): value is AttentionBucket =>
  typeof value === 'string' && (ATTENTION_BUCKETS as readonly string[]).includes(value);

export const getLevelReport = async (): Promise<LevelReport> => {
  const { data, error } = await supabase.rpc('get_question_level_report');
  if (error) throw new Error(error.message);

  const counts = emptyCounts();
  const rows: LevelReportRow[] = [];

  for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
    const bucket = raw.bucket;
    if (!isBucket(bucket)) continue;

    counts[bucket] += 1;
    rows.push({
      bucket,
      question_id: String(raw.question_id),
      subject_id: typeof raw.subject_id === 'string' ? raw.subject_id : null,
      track_ids: Array.isArray(raw.track_ids)
        ? raw.track_ids.filter((track): track is string => typeof track === 'string')
        : [],
      has_university_reference: raw.has_university_reference === true,
    });
  }

  return { counts, total: rows.length, rows };
};

export interface QuestionTracks {
  questionId: string;
  tracks: Array<{ trackId: string; source: string }>;
}

/** Tracks for a set of questions, split by the source that wrote them. */
export const getQuestionTracks = async (
  questionIds: readonly string[]
): Promise<QuestionTracks[]> => {
  const ids = uniqueIds(questionIds);
  if (ids.length === 0) return [];

  const byQuestion = new Map<string, Array<{ trackId: string; source: string }>>();
  for (const id of ids) byQuestion.set(id, []);

  for (const group of chunk(ids, ID_CHUNK)) {
    const { data, error } = await supabase
      .from('question_preparation_tracks')
      .select('question_id, track_id, source')
      .in('question_id', group);

    if (error) throw new Error(error.message);

    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      if (typeof row.question_id !== 'string' || typeof row.track_id !== 'string') continue;
      byQuestion.get(row.question_id)?.push({
        trackId: row.track_id,
        source: typeof row.source === 'string' ? row.source : 'manual',
      });
    }
  }

  return ids.map((questionId) => ({
    questionId,
    tracks: (byQuestion.get(questionId) ?? []).sort((a, b) =>
      a.trackId.localeCompare(b.trackId)
    ),
  }));
};

export interface TrackWriteResult {
  questionIds: string[];
  added: string[];
  removed: string[];
}

const assertTracks = (tracks: readonly unknown[]): PreparationTrackId[] => {
  const resolved: PreparationTrackId[] = [];

  for (const value of tracks) {
    if (typeof value !== 'string') continue;
    const track = value.trim().toLowerCase();
    if (!(PREPARATION_TRACK_IDS as readonly string[]).includes(track)) {
      throw new Error(`unknown track: ${value}`);
    }
    resolved.push(track as PreparationTrackId);
  }

  return Array.from(new Set(resolved));
};

/**
 * Adds and removes manual tracks for a set of questions.
 *
 * Removal never touches an automatic row: the sync owns those, and deleting an
 * auto row here would only have it reappear on the next reference change. A
 * manual removal is therefore recorded by deleting a manual row if one exists.
 */
export const setQuestionTracksBulk = async (
  questionIds: readonly string[],
  add: readonly unknown[],
  remove: readonly unknown[]
): Promise<TrackWriteResult> => {
  const ids = uniqueIds(questionIds);
  const added = assertTracks(add);
  const removed = assertTracks(remove);

  if (ids.length === 0) return { questionIds: [], added: [], removed: [] };

  const rows = ids.flatMap((questionId) =>
    added.map((trackId) => ({ question_id: questionId, track_id: trackId, source: 'manual' }))
  );

  for (const group of chunk(rows, 500)) {
    const { error } = await supabase
      .from('question_preparation_tracks')
      .upsert(group, { onConflict: 'question_id,track_id', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  }

  if (removed.length > 0) {
    for (const group of chunk(ids, ID_CHUNK)) {
      const { error } = await supabase
        .from('question_preparation_tracks')
        .delete()
        .in('question_id', group)
        .in('track_id', removed)
        .eq('source', 'manual');
      if (error) throw new Error(error.message);
    }
  }

  return { questionIds: ids, added, removed };
};

/** Ids that sit in the requested attention buckets. Small lists only. */
export const resolveAttentionQuestionIds = async (
  filter: ResolvedLevelFilter
): Promise<string[] | null> => {
  if (filter.buckets.length === 0) return null;

  const report = await getLevelReport();
  const wanted = new Set<string>(filter.buckets);

  return Array.from(
    new Set(
      report.rows.filter((row) => wanted.has(row.bucket)).map((row) => row.question_id)
    )
  );
};

export const recordLevelAudit = async (
  actorId: string | undefined,
  action: string,
  targetId: string | null,
  details: Record<string, unknown>
): Promise<void> => {
  const { error } = await supabase.from('audit_logs').insert({
    user_id: actorId ?? null,
    action,
    target_table: 'question_preparation_tracks',
    target_id: targetId,
    details,
  });

  // An audit failure must not undo a write that already happened, but it must be
  // visible in the log rather than swallowed.
  if (error) console.error('[security-audit] level event could not be recorded');
};
