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

  // Resolve presentation metadata in one backend query. The mobile client used
  // to issue two extra Supabase requests (exam papers, then subjects) after
  // every history load.
  const examIds = [
    ...new Set(
      rows
        .map((row: any) => (row.exam_id ? String(row.exam_id) : null))
        .filter((id): id is string => Boolean(id))
    ),
  ];

  const examMetadata = new Map<
    string,
    { title: string | null; subjectNameEn: string | null; subjectNameBn: string | null }
  >();

  if (examIds.length > 0) {
    const { data: exams, error: examsError } = await supabase
      .from('exam_papers')
      .select('id, title, subject_id, subjects ( name_en, name_bn )')
      .in('id', examIds);

    if (!examsError) {
      for (const exam of (exams ?? []) as any[]) {
        const subject = Array.isArray(exam.subjects) ? exam.subjects[0] : exam.subjects;

        examMetadata.set(String(exam.id), {
          title: exam.title ?? null,
          subjectNameEn: subject?.name_en ?? null,
          subjectNameBn: subject?.name_bn ?? null,
        });
      }
    }
  }

  // Row counters are enough to decide whether the action is worth offering.
  // Exact availability is checked when the student starts the mode, so the
  // history list no longer runs two RPCs per row.
  return rows.map((row: any) => {
    const correct = Math.max(0, Number(row.correct_count ?? 0));
    const wrong = Math.max(0, Number(row.wrong_count ?? 0));
    const skipped = Math.max(0, Number(row.skipped_count ?? 0));
    const metadata = row.exam_id ? examMetadata.get(String(row.exam_id)) : undefined;

    return {
      ...row,
      exam_title: metadata?.title ?? null,
      subject_name_en: metadata?.subjectNameEn ?? null,
      subject_name_bn: metadata?.subjectNameBn ?? null,
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
