import { supabase } from '../../config/supabase';
import type { TablesInsert } from '../../types/database.type';
import {
  PREPARATION_TRACK_IDS,
  categoryFromTrackIds,
  trackIdsForCategory,
  type PreparationCategory,
} from './question.preparation';

/**
 * Database access for preparation placement.
 *
 * Only the HSC and Admission tracks are owned by this feature. Other tracks
 * (engineering, medical, varsity) are read for the return value but never
 * removed when a category changes.
 */

const ID_CHUNK = 200;
const READ_PAGE_SIZE = 1000;

const chunk = <T>(values: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
};

const uniqueIds = (ids: string[]): string[] => Array.from(new Set(ids.filter(Boolean)));

const loadTrackRows = async (
  questionIds: string[]
): Promise<Array<{ question_id: string; track_id: string }>> => {
  const rows: Array<{ question_id: string; track_id: string }> = [];

  for (const group of chunk(uniqueIds(questionIds), ID_CHUNK)) {
    const { data, error } = await supabase
      .from('question_preparation_tracks')
      .select('question_id, track_id')
      .in('question_id', group)
      .in('track_id', [...PREPARATION_TRACK_IDS]);

    if (error) throw new Error(error.message);
    rows.push(
      ...((data ?? []) as Array<{ question_id: string; track_id: string }>).filter(
        (row) => typeof row.question_id === 'string' && typeof row.track_id === 'string'
      )
    );
  }

  return rows;
};

const deleteTracks = async (questionIds: string[], trackIds: string[]): Promise<void> => {
  if (questionIds.length === 0 || trackIds.length === 0) return;

  for (const group of chunk(uniqueIds(questionIds), ID_CHUNK)) {
    const { error } = await supabase
      .from('question_preparation_tracks')
      .delete()
      .in('question_id', group)
      .in('track_id', trackIds);

    if (error) throw new Error(error.message);
  }
};

const insertTracks = async (
  questionIds: string[],
  trackIds: string[]
): Promise<void> => {
  if (questionIds.length === 0 || trackIds.length === 0) return;

  const rows: TablesInsert<'question_preparation_tracks'>[] = [];
  for (const trackId of trackIds) {
    for (const questionId of uniqueIds(questionIds)) {
      rows.push({ question_id: questionId, track_id: trackId });
    }
  }

  for (const group of chunk(rows, 500)) {
    const { error } = await supabase
      .from('question_preparation_tracks')
      .upsert(group, { onConflict: 'question_id,track_id', ignoreDuplicates: true });

    if (error) throw new Error(error.message);
  }
};

export interface PreparationCategoryAssignment {
  questionId: string;
  category: PreparationCategory | null;
}

/**
 * Replaces the HSC/Admission placement for each question.
 *
 * New rows are inserted before stale rows are deleted, so a failed insert
 * leaves the previous placement intact. Tracks outside this feature are not
 * touched.
 */
export const setPreparationCategories = async (
  assignments: PreparationCategoryAssignment[]
): Promise<void> => {
  if (assignments.length === 0) return;

  const targetIds: Record<'hsc' | 'admission', string[]> = { hsc: [], admission: [] };
  const prune: Record<'hsc' | 'admission', string[]> = { hsc: [], admission: [] };

  // The last assignment for a question wins; bulk imports can contain the same
  // content twice with different placements.
  const byQuestion = new Map<string, PreparationCategory | null>();
  for (const { questionId, category } of assignments) {
    if (questionId) byQuestion.set(questionId, category);
  }

  for (const [questionId, category] of byQuestion) {
    const target = trackIdsForCategory(category);

    if (target.includes('hsc')) targetIds.hsc.push(questionId);
    if (target.includes('admission')) targetIds.admission.push(questionId);

    if (!target.includes('hsc')) prune.hsc.push(questionId);
    if (!target.includes('admission')) prune.admission.push(questionId);
  }

  await insertTracks(targetIds.hsc, ['hsc']);
  await insertTracks(targetIds.admission, ['admission']);

  await deleteTracks(prune.hsc, ['hsc']);
  await deleteTracks(prune.admission, ['admission']);
};

/** Returns a category for every requested id, including ids with no tracks. */
export const loadPreparationCategories = async (
  questionIds: string[]
): Promise<Map<string, PreparationCategory | null>> => {
  const ids = uniqueIds(questionIds);
  const categories = new Map<string, PreparationCategory | null>();
  for (const id of ids) categories.set(id, null);

  const rows = await loadTrackRows(ids);
  const tracksByQuestion = new Map<string, string[]>();

  for (const row of rows) {
    const tracks = tracksByQuestion.get(row.question_id) ?? [];
    tracks.push(row.track_id);
    tracksByQuestion.set(row.question_id, tracks);
  }

  for (const [questionId, tracks] of tracksByQuestion) {
    categories.set(questionId, categoryFromTrackIds(tracks));
  }

  return categories;
};

/** Adds `preparation_category` to already-fetched question rows. */
export const attachPreparationCategories = async <T extends { id: unknown }>(
  rows: T[]
): Promise<Array<T & { preparation_category: PreparationCategory | null }>> => {
  const ids = rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string');

  const categories = await loadPreparationCategories(ids);

  return rows.map((row) => ({
    ...row,
    preparation_category:
      typeof row.id === 'string' ? categories.get(row.id) ?? null : null,
  }));
};

const loadQuestionIdsForTrack = async (trackId: string): Promise<string[]> => {
  const ids: string[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('question_preparation_tracks')
      .select('question_id')
      .eq('track_id', trackId)
      .order('question_id', { ascending: true })
      .range(offset, offset + READ_PAGE_SIZE - 1);

    if (error) throw new Error(error.message);

    const rows = (data ?? []) as Array<{ question_id?: unknown }>;
    for (const row of rows) {
      if (typeof row.question_id === 'string') ids.push(row.question_id);
    }

    if (rows.length < READ_PAGE_SIZE) break;
    offset += READ_PAGE_SIZE;
  }

  return ids;
};

/**
 * Question ids that belong to a preparation bank.
 *
 * `hsc` and `admission` include questions placed in `both`; `both` requires
 * both tracks. Null means the filter is not active.
 */
export const resolvePreparationQuestionIds = async (
  category?: string | null
): Promise<string[] | null> => {
  if (!category || category === 'all') return null;

  if (category === 'both') {
    const [hsc, admission] = await Promise.all([
      loadQuestionIdsForTrack('hsc'),
      loadQuestionIdsForTrack('admission'),
    ]);
    const admissionIds = new Set(admission);
    return hsc.filter((id) => admissionIds.has(id));
  }

  if (category === 'hsc' || category === 'admission') {
    return loadQuestionIdsForTrack(category);
  }

  return null;
};
