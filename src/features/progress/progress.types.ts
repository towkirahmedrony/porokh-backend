import type {
  ProgressActivityDay,
  ProgressMentor,
  ProgressSubjectStat,
  ProgressTrendPoint,
  ProgressWeakTopic,
} from './progress.metrics';

export interface ProgressUser {
  name: string | null;
  avatar_url: string | null;
  class_label: string | null;
  total_xp: number;
}

export interface ProgressLevelSummary {
  id: number;
  name_bn: string;
  name_en: string;
  min_xp: number;
  max_xp: number | null;
  next_min_xp: number | null;
}

export interface ProgressSummary {
  accuracy_pct: number | null;
  average_score_pct: number | null;
  exams_taken: number;
  practice_sessions: number;
  streak_days: number;
  longest_streak_days: number;
  correct: number;
  wrong: number;
  skipped: number;
  responses: number;
}

export interface ProgressDashboardResponse {
  user: ProgressUser;
  level: ProgressLevelSummary | null;
  summary: ProgressSummary;
  activity: {
    window_days: number;
    days: ProgressActivityDay[];
  };
  performance: ProgressTrendPoint[];
  subjects: ProgressSubjectStat[];
  weaknesses: ProgressWeakTopic[];
  mentor: ProgressMentor;
  mistakes: {
    available: number;
  };
}
