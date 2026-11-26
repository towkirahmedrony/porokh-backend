import { supabase } from '../../config/supabase';
import {
  buildProgressSnapshot,
  type ProgressChapterLabel,
  type ProgressDetailRow,
  type ProgressHistoryRow,
  type ProgressLevelRow,
  type ProgressSubjectLabel,
  type ProgressTopicLabel,
} from './progress.metrics';
import type { ProgressDashboardResponse } from './progress.types';

type AnyObject = Record<string, any>;

/** PostgREST puts every id in the URL, so keep each batch well under any limit. */
const IN_BATCH_SIZE = 100;
/** Page size for reads; PostgREST would otherwise stop silently at its row cap. */
const PAGE_SIZE = 500;

const asArray = (value: unknown): AnyObject[] =>
  Array.isArray(value) ? (value as AnyObject[]) : [];

const asRecord = (value: unknown): AnyObject | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyObject)
    : null;

/**
 * Reads every page of a query. Silent truncation at the server row cap would
 * undercount a student's history, so paging continues until a short page.
 */
const fetchAllPages = async (
  scope: string,
  run: (
    from: number,
    to: number
  ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>
): Promise<AnyObject[]> => {
  const rows: AnyObject[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await run(from, from + PAGE_SIZE - 1);
    if (error) fail(scope, error);

    const page = asArray(data);
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

const fail = (scope: string, error: { message?: string } | null): never => {
  throw new Error(`Progress dashboard ${scope} failed: ${error?.message ?? 'unknown error'}`);
};

const loadHistory = async (userId: string): Promise<ProgressHistoryRow[]> => {
  const data = await fetchAllPages('history', (from, to) =>
    supabase
      .from('exam_history')
      .select(
        'id, exam_id, score, total_marks, submitted_at, created_at, status, practice_mode'
      )
      .eq('user_id', userId)
      .order('submitted_at', { ascending: true, nullsFirst: true })
      .order('id', { ascending: true })
      .range(from, to)
  );

  return data.map((row) => ({
    id: String(row.id),
    exam_id: row.exam_id ?? null,
    score: row.score === null ? null : toNumber(row.score),
    total_marks: row.total_marks === null ? null : toNumber(row.total_marks),
    submitted_at: row.submitted_at ?? null,
    created_at: row.created_at ?? null,
    status: row.status ?? null,
    practice_mode: row.practice_mode ?? null,
  }));
};

/**
 * Question-level rows for the user's own attempts. The user scope comes from
 * `historyIds`, which were already filtered by `user_id`.
 */
const loadDetails = async (historyIds: string[]): Promise<ProgressDetailRow[]> => {
  const rows: ProgressDetailRow[] = [];

  for (const batch of chunk(historyIds, IN_BATCH_SIZE)) {
    const data = await fetchAllPages('details', (from, to) =>
      supabase
        .from('exam_history_details')
        .select(
          'exam_history_id, question_id, is_correct, questions ( subject_id, chapter_id, topic_id )'
        )
        .in('exam_history_id', batch)
        .order('exam_history_id', { ascending: true })
        .order('question_id', { ascending: true })
        .range(from, to)
    );

    for (const row of data) {
      const question = Array.isArray(row.questions) ? row.questions[0] : row.questions;

      rows.push({
        exam_history_id: String(row.exam_history_id),
        question_id: String(row.question_id),
        is_correct: typeof row.is_correct === 'boolean' ? row.is_correct : null,
        subject_id: question?.subject_id ?? null,
        chapter_id: question?.chapter_id ?? null,
        topic_id: question?.topic_id ?? null,
      });
    }
  }

  return rows;
};

const loadCatalog = async (details: ProgressDetailRow[]) => {
  const subjectIds = [
    ...new Set(details.map((row) => row.subject_id).filter((id): id is string => Boolean(id))),
  ];
  const chapterIds = [
    ...new Set(details.map((row) => row.chapter_id).filter((id): id is string => Boolean(id))),
  ];
  const topicIds = [
    ...new Set(details.map((row) => row.topic_id).filter((id): id is string => Boolean(id))),
  ];

  const [subjects, chapters, topics] = await Promise.all([
    (async (): Promise<ProgressSubjectLabel[]> => {
      if (subjectIds.length === 0) return [];
      const { data, error } = await supabase
        .from('subjects')
        .select('id, name_bn, name_en')
        .in('id', subjectIds);
      if (error) fail('subjects', error);
      return asArray(data).map((row) => ({
        id: String(row.id),
        name_bn: toText(row.name_bn) ?? String(row.id),
        name_en: row.name_en ?? null,
      }));
    })(),
    (async (): Promise<ProgressChapterLabel[]> => {
      if (chapterIds.length === 0) return [];
      const { data, error } = await supabase
        .from('chapters')
        .select('id, subject_id, name_bn, name_en')
        .in('id', chapterIds);
      if (error) fail('chapters', error);
      return asArray(data).map((row) => ({
        id: String(row.id),
        subject_id: row.subject_id ?? null,
        name_bn: toText(row.name_bn) ?? String(row.id),
        name_en: row.name_en ?? null,
      }));
    })(),
    (async (): Promise<ProgressTopicLabel[]> => {
      if (topicIds.length === 0) return [];
      const { data, error } = await supabase
        .from('topics')
        .select('id, chapter_id, name_bn, name_en')
        .in('id', topicIds);
      if (error) fail('topics', error);
      return asArray(data).map((row) => ({
        id: String(row.id),
        chapter_id: row.chapter_id ?? null,
        name_bn: toText(row.name_bn) ?? String(row.id),
        name_en: row.name_en ?? null,
      }));
    })(),
  ]);

  return { subjects, chapters, topics };
};

const loadLevels = async (): Promise<ProgressLevelRow[]> => {
  const { data, error } = await supabase
    .from('levels_master')
    .select('id, name_bn, name_en, min_xp, max_xp')
    .order('min_xp', { ascending: true });

  if (error) fail('levels', error);

  return asArray(data).map((row) => ({
    id: Math.trunc(toNumber(row.id)),
    name_bn: toText(row.name_bn) ?? '',
    name_en: toText(row.name_en) ?? '',
    min_xp: Math.trunc(toNumber(row.min_xp)),
    max_xp: row.max_xp === null ? null : Math.trunc(toNumber(row.max_xp)),
  }));
};

export const getProgressDashboardData = async (
  userId: string
): Promise<ProgressDashboardResponse> => {
  const [profileResult, history] = await Promise.all([
    supabase
      .from('profiles')
      .select('full_name, username, avatar_url, hsc_batch, study_goal, total_xp')
      .eq('id', userId)
      .maybeSingle(),
    loadHistory(userId),
  ]);

  if (profileResult.error) fail('profile', profileResult.error);

  const profile = profileResult.data;
  const historyIds = history.map((row) => row.id);

  const [details, streakResult, longestStreakResult, mistakePoolResult] =
    await Promise.all([
      historyIds.length > 0 ? loadDetails(historyIds) : Promise.resolve([]),
      supabase.rpc('get_current_streak', { p_user_id: userId }),
      supabase.rpc('get_longest_streak', { p_user_id: userId }),
      supabase.rpc('get_mistake_pool', { p_user_id: userId }),
    ]);

  if (streakResult.error) fail('streak', streakResult.error);
  if (longestStreakResult.error) fail('longest streak', longestStreakResult.error);
  if (mistakePoolResult.error) fail('mistake pool', mistakePoolResult.error);

  const { subjects, chapters, topics } = await loadCatalog(details);
  const levels = await loadLevels();

  const snapshot = buildProgressSnapshot({
    history,
    details,
    subjects,
    chapters,
    topics,
    levels,
    totalXp: toNumber(profile?.total_xp),
    streakDays: toNumber(streakResult.data),
    longestStreakDays: toNumber(longestStreakResult.data?.[0]?.longest_streak_days),
    now: Date.now(),
  });

  // `class_label` keeps its name for every client already reading it, but the
  // value is the canonical batch year and nothing else.
  const classLabel = toText(profile?.hsc_batch);

  return {
    user: {
      name: toText(profile?.full_name) ?? toText(profile?.username),
      avatar_url: toText(profile?.avatar_url),
      class_label: classLabel,
      total_xp: toNumber(profile?.total_xp),
    },
    level: snapshot.level,
    summary: snapshot.summary,
    activity: snapshot.activity,
    performance: snapshot.performance,
    subjects: snapshot.subjects,
    weaknesses: snapshot.weaknesses,
    mentor: snapshot.mentor,
    mistakes: {
      available: asArray(mistakePoolResult.data).length,
    },
  };
};
