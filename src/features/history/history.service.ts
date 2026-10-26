import { supabase } from '../../config/supabase';

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

  // Row counters are enough to decide whether the action is worth offering.
  // Exact availability is checked when the student starts the mode, so the
  // history list no longer runs two RPCs per row.
  return rows.map((row: any) => {
    const correct = Math.max(0, Number(row.correct_count ?? 0));
    const wrong = Math.max(0, Number(row.wrong_count ?? 0));
    const skipped = Math.max(0, Number(row.skipped_count ?? 0));

    return {
      ...row,
      retake_available_count: correct + wrong + skipped,
      wrong_available_count: wrong + skipped,
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
