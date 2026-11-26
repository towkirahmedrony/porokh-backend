export interface BatchRow {
  batch_year: string;
  exam_end_date: string | null;
  notes: string | null;
  updated_at: string;
  updated_by: string | null;
  student_count: number;
  pending_goal_count: number;
  exam_ended: boolean;
}

export interface BatchListResponse {
  batches: BatchRow[];
}

export interface CreateBatchInput {
  batch_year: string;
  exam_end_date: string | null;
  notes: string | null;
}

export interface UpdateBatchInput {
  exam_end_date?: string | null;
  notes?: string | null;
}

export class HscBatchesError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'HscBatchesError';
    this.status = status;
  }
}
