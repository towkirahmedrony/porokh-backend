export interface HistorySubjectResponse {
  id: string;
  name_en: string | null;
  name_bn: string | null;
}

export interface ExamHistoryResponse {
  id: string;
  exam_id: string | null;
  score: number;
  total_marks: number;
  correct_count: number | null;
  wrong_count: number | null;
  skipped_count: number | null;
  question_count: number | null;
  exam_sequence: number | null;
  completion_status: string | null;
  exam_title: string | null;
  subject_name_en: string | null;
  subject_name_bn: string | null;
  subjects: HistorySubjectResponse[];
  created_at: string;
  submitted_at: string | null;
  status: string | null;
  practice_mode: string | null;
  source_history_id: string | null;
}

/** A mistake is a wrong OR skipped response, unless the user dismissed it. */
export type MistakeStatus = 'wrong' | 'skipped';

export interface MistakeResponse {
  id: string;
  detail_id: string | null;
  selected_option: string | null;
  question_id: string;
  status: MistakeStatus;
  occurred_at: string | null;
  questions: Record<string, unknown> | null;
}

export interface BookmarkResponse {
  id: string;
  note: string | null;
  question_id: string;
  created_at: string | null;
  questions: Record<string, unknown> | null;
}
