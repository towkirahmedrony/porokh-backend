import { supabase } from '../../config/supabase';

type AnyObject = Record<string, any>;

export type ExplorerSource = 'mistakes' | 'bookmarks';

export type ExplorerSort = 'recent' | 'most_wrong' | 'subject';

/**
 * Filters the student picked in the sheet. Every value is a text id from the
 * facet endpoint except has_note and the search text. The SQL side treats an
 * absent key as "no filter", so an empty object is the unfiltered pool.
 */
export interface ExplorerFilters {
  subject?: string;
  chapter?: string;
  topic?: string;
  institution?: string;
  exam_year?: string;
  status?: 'wrong' | 'skipped';
  has_note?: boolean;
  q?: string;
}

const MAX_FILTER_TEXT = 80;
const MAX_SEARCH_TEXT = 60;
export const EXPLORER_PAGE_SIZE = 20;
export const MAX_EXPLORER_PAGE_SIZE = 50;

const normalizeId = (value: unknown): string => String(value ?? '').trim();

const readText = (value: unknown, max = MAX_FILTER_TEXT): string => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
};

export const parseExplorerFilters = (raw: unknown): ExplorerFilters => {
  let candidate: unknown = raw;

  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return {};
    }
  }

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return {};
  }

  const record = candidate as AnyObject;
  const filters: ExplorerFilters = {};

  const subject = readText(record.subject);
  const chapter = readText(record.chapter);
  const topic = readText(record.topic);
  const institution = readText(record.institution);
  const examYear = readText(record.exam_year);
  const status = readText(record.status, 16);

  if (subject) filters.subject = subject;
  if (chapter) filters.chapter = chapter;
  if (topic) filters.topic = topic;
  if (institution) filters.institution = institution;
  if (examYear) filters.exam_year = examYear;
  if (status === 'wrong' || status === 'skipped') filters.status = status;

  if (record.has_note === true || record.has_note === 'true') filters.has_note = true;

  const search = readText(record.q, MAX_SEARCH_TEXT);
  if (search) filters.q = search;

  return filters;
};

export const parseExplorerSource = (raw: unknown): ExplorerSource => {
  const value = normalizeId(raw);
  return value === 'bookmarks' ? 'bookmarks' : 'mistakes';
};

export const parseExplorerSort = (raw: unknown): ExplorerSort => {
  const value = normalizeId(raw);
  if (value === 'most_wrong' || value === 'subject') return value;
  return 'recent';
};

const asArray = (value: unknown): AnyObject[] =>
  Array.isArray(value) ? (value as AnyObject[]) : [];

interface LabelRow {
  id: string;
  name_bn: string | null;
  name_en: string | null;
}

const loadLabels = async (
  table: 'subjects' | 'chapters' | 'topics',
  ids: string[]
): Promise<Map<string, LabelRow>> => {
  const map = new Map<string, LabelRow>();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return map;

  const { data, error } = await supabase
    .from(table)
    .select('id, name_bn, name_en')
    .in('id', unique);

  if (error) return map;

  for (const row of asArray(data)) {
    const id = normalizeId(row.id);
    if (!id) continue;
    map.set(id, {
      id,
      name_bn: row.name_bn ?? null,
      name_en: row.name_en ?? null,
    });
  }

  return map;
};

export interface ExplorerFacetOption {
  id: string;
  parent_id: string | null;
  label_bn: string | null;
  label_en: string | null;
  count: number;
}

export const getExplorerFacets = async (
  userId: string,
  source: ExplorerSource,
  filters: ExplorerFilters
): Promise<Record<string, ExplorerFacetOption[]>> => {
  const { data, error } = await supabase.rpc('get_mistake_bookmark_facets', {
    p_user_id: userId,
    p_source: source,
    p_filters: filters,
  });

  if (error) throw error;

  const facets: Record<string, ExplorerFacetOption[]> = {};

  for (const row of asArray(data)) {
    const facet = normalizeId(row.facet);
    const id = normalizeId(row.id);
    if (!facet || !id) continue;

    const list = facets[facet] ?? [];
    list.push({
      id,
      parent_id: row.parent_id === null || row.parent_id === undefined
        ? null
        : normalizeId(row.parent_id),
      label_bn: row.label_bn ?? null,
      label_en: row.label_en ?? null,
      count: Math.max(0, Number(row.cnt ?? 0)),
    });
    facets[facet] = list;
  }

  return facets;
};

export const countExplorerQuestions = async (
  userId: string,
  source: ExplorerSource,
  filters: ExplorerFilters
): Promise<{ available_count: number }> => {
  const { data, error } = await supabase.rpc('count_mistake_bookmark_questions', {
    p_user_id: userId,
    p_source: source,
    p_filters: filters,
  });

  if (error) throw error;

  const count = Number(data);
  return { available_count: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0 };
};

export interface ExplorerPage {
  items: AnyObject[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export const getExplorerPage = async (params: {
  userId: string;
  source: ExplorerSource;
  filters: ExplorerFilters;
  sort: ExplorerSort;
  limit: number;
  offset: number;
  loadQuestions: (questionIds: string[]) => Promise<Map<string, AnyObject>>;
}): Promise<ExplorerPage> => {
  const { userId, source, filters, sort, limit, offset, loadQuestions } = params;

  const safeLimit = Math.min(
    Math.max(Math.trunc(limit) || EXPLORER_PAGE_SIZE, 1),
    MAX_EXPLORER_PAGE_SIZE
  );
  const safeOffset = Math.max(Math.trunc(offset) || 0, 0);

  const [{ data, error }, totalRow] = await Promise.all([
    supabase.rpc('get_mistake_bookmark_questions', {
      p_user_id: userId,
      p_source: source,
      p_filters: filters,
      p_sort: sort,
      p_limit: safeLimit,
      p_offset: safeOffset,
    }),
    supabase.rpc('count_mistake_bookmark_questions', {
      p_user_id: userId,
      p_source: source,
      p_filters: filters,
    }),
  ]);

  if (error) throw error;

  const rows = asArray(data);
  const total = Math.max(0, Number(totalRow.data ?? 0) || 0);

  const questionIds = rows
    .map((row) => normalizeId(row.question_id))
    .filter(Boolean);

  // Bodies are fetched for this page only, in one batched query.
  const [questions, subjects, chapters, topics] = await Promise.all([
    loadQuestions(questionIds),
    loadLabels(
      'subjects',
      rows.map((row) => normalizeId(row.subject_id))
    ),
    loadLabels(
      'chapters',
      rows.map((row) => normalizeId(row.chapter_id))
    ),
    loadLabels(
      'topics',
      rows.map((row) => normalizeId(row.topic_id))
    ),
  ]);

  const items = rows
    .map((row) => {
      const questionId = normalizeId(row.question_id);
      if (!questionId) return null;

      const subjectId = normalizeId(row.subject_id);
      const chapterId = normalizeId(row.chapter_id);
      const topicId = normalizeId(row.topic_id);
      const institutionId = normalizeId(row.institution_id);

      const subject = subjects.get(subjectId) ?? null;
      const chapter = chapters.get(chapterId) ?? null;
      const topic = topics.get(topicId) ?? null;

      return {
        id: source === 'bookmarks' ? normalizeId(row.item_id) || questionId : questionId,
        item_id: row.item_id ? normalizeId(row.item_id) : null,
        question_id: questionId,
        status: row.status ?? null,
        selected_option: row.selected_option ?? null,
        occurred_at: row.occurred_at ?? null,
        note: row.note ?? null,
        wrong_times: Math.max(0, Number(row.wrong_times ?? 0)),
        last_wrong_at: row.last_wrong_at ?? null,
        subject,
        chapter,
        topic,
        source: institutionId || row.exam_year
          ? {
              institution_id: institutionId || null,
              institution_name_bn: row.institution_name_bn ?? null,
              institution_name_en: row.institution_name_en ?? null,
              institution_short_name: row.institution_short_name ?? null,
              exam_name: row.exam_name ?? null,
              exam_year: row.exam_year ?? null,
            }
          : null,
        questions: questions.get(questionId) ?? null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  return {
    items,
    total,
    limit: safeLimit,
    offset: safeOffset,
    has_more: safeOffset + items.length < total,
  };
};

export const pickExplorerQuestions = async (
  userId: string,
  source: ExplorerSource,
  filters: ExplorerFilters,
  count: number
): Promise<string[]> => {
  const { data, error } = await supabase.rpc('pick_mistake_bookmark_questions', {
    p_user_id: userId,
    p_source: source,
    p_filters: filters,
    p_count: count,
  });

  if (error) throw error;

  return Array.from(
    new Set(asArray(data).map((row) => normalizeId(row.question_id)).filter(Boolean))
  );
};

export const getDismissedMistakes = async (userId: string) => {
  const { data, error } = await supabase.rpc('get_dismissed_mistakes', {
    p_user_id: userId,
  });

  if (error) throw error;

  return asArray(data).map((row) => ({
    question_id: normalizeId(row.question_id),
    dismissed_at: row.dismissed_at ?? null,
    subject_id: row.subject_id ?? null,
    subject_name_bn: row.subject_name_bn ?? null,
    subject_name_en: row.subject_name_en ?? null,
    body: row.body ?? null,
  }));
};

export const restoreDismissedMistakes = async (
  userId: string,
  questionIds: string[]
): Promise<number> => {
  const ids = Array.from(
    new Set(questionIds.map((id) => normalizeId(id)).filter(Boolean))
  );
  if (ids.length === 0) return 0;

  const { data, error } = await supabase
    .from('mistake_dismissals')
    .delete()
    .eq('user_id', userId)
    .in('question_id', ids)
    .select('question_id');

  if (error) throw error;

  return asArray(data).length;
};

export const updateBookmarkNote = async (
  userId: string,
  bookmarkId: string,
  note: unknown
): Promise<{ id: string; note: string | null }> => {
  const id = normalizeId(bookmarkId);
  if (!id) throw new Error('bookmark_id_required');

  const text =
    typeof note === 'string' ? note.trim().slice(0, 500) : '';

  const { data, error } = await supabase
    .from('bookmarks')
    .update({ note: text || null })
    .eq('id', id)
    .eq('user_id', userId)
    .select('id, note')
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('bookmark_not_found');

  return { id: normalizeId(data.id), note: data.note ?? null };
};

export const recreateBookmark = async (
  userId: string,
  questionId: string,
  note: unknown
): Promise<{ id: string; question_id: string; note: string | null }> => {
  const qid = normalizeId(questionId);
  if (!qid) throw new Error('question_id_required');

  const text = typeof note === 'string' ? note.trim().slice(0, 500) : '';

  const { data, error } = await supabase
    .from('bookmarks')
    .upsert(
      { user_id: userId, question_id: qid, note: text || null },
      { onConflict: 'user_id,question_id' }
    )
    .select('id, question_id, note')
    .single();

  if (error) throw error;

  return {
    id: normalizeId(data.id),
    question_id: normalizeId(data.question_id),
    note: data.note ?? null,
  };
};
