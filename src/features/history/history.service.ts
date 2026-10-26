import { supabase } from '../../config/supabase';

const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;

        if (index >= items.length) return;

        results[index] = await task(items[index]);
      }
    })
  );

  return results;
};

const loadAvailableCount = async (
  rpcName: 'get_history_question_set' | 'get_history_wrong_questions',
  userId: string,
  historyId: string
): Promise<number> => {
  try {
    const { data, error } = await supabase.rpc(rpcName, {
      p_user_id: userId,
      p_history_id: historyId,
    });

    if (error) return 0;

    return (Array.isArray(data) ? data : []).filter(
      (row: any) => row?.available === true
    ).length;
  } catch {
    // Availability flags enrich the list; they must never make the whole
    // history page unavailable. A start request still re-checks the source.
    return 0;
  }
};

export const getUserExamHistory = async (userId: string) => {
  // The history list only needs attempt summaries. details_json is intentionally
  // omitted: it can contain answer-key snapshots that must go through the
  // owner-scoped, publish-time-gated result review endpoint instead.
  const { data, error } = await supabase
    .from('exam_history')
    .select(
      'id, exam_id, score, total_marks, correct_count, wrong_count, skipped_count, time_taken, submitted_at, created_at, status, practice_mode, source_history_id'
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;

  const rows = data ?? [];

  // The existing database functions are the single source of truth for what can
  // be practised. Running them per history row (bounded concurrency) keeps the
  // response honest without introducing another schema object.
  return mapWithConcurrency(rows, 4, async (row: any) => {
    const historyId = String(row.id ?? '');

    const [retakeAvailable, wrongAvailable] = await Promise.all([
      loadAvailableCount('get_history_question_set', userId, historyId),
      loadAvailableCount('get_history_wrong_questions', userId, historyId),
    ]);

    return {
      ...row,
      retake_available_count: retakeAvailable,
      wrong_available_count: wrongAvailable,
    };
  });
};

const sanitizeQuestionOptions = (options: unknown): unknown[] => {
  if (!Array.isArray(options)) return [];

  return options.map((option: any) => ({
    id: option?.id,
    text_bn: option?.text_bn,
    text_en: option?.text_en,
    image_url: option?.image_url ?? null,
  }));
};

export const getUserMistakes = async (userId: string) => {
  // Never expose explanations or correctness flags from this secondary list;
  // authorised answer review happens through /exams/user/result/:id.
  const { data, error } = await supabase
    .from('wrong_answers')
    .select('id, selected_option, question_id, questions ( id, body, options )')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;

  return (data || []).map((row: any) => {
    const question = Array.isArray(row.questions) ? row.questions[0] : row.questions;

    return {
      id: row.id,
      selected_option: row.selected_option,
      question_id: row.question_id,
      questions: question
        ? {
            id: question.id,
            body: question.body,
            options: sanitizeQuestionOptions(question.options),
          }
        : null,
    };
  });
};

export const getUserBookmarks = async (userId: string) => {
  const { data, error } = await supabase
    .from('bookmarks')
    .select('id, note, questions ( id, body )')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
};

export const deleteMistakeRecord = async (mistakeId: string, userId: string) => {
  const { error } = await supabase
    .from('wrong_answers')
    .delete()
    .eq('id', mistakeId)
    .eq('user_id', userId); // Ensure the user owns the record

  if (error) throw error;
  return true;
};

export const deleteBookmarkRecord = async (bookmarkId: string, userId: string) => {
  const { error } = await supabase
    .from('bookmarks')
    .delete()
    .eq('id', bookmarkId)
    .eq('user_id', userId); // Ensure the user owns the record

  if (error) throw error;
  return true;
};
