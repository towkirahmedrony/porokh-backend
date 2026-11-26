import type { StudyStage } from '../../features/profile/profile.types';

/**
 * The exam is over from the day after its last day, in Asia/Dhaka. `today` is
 * always a server-side Dhaka day key (YYYY-MM-DD), never a client clock.
 */
export const isExamEnded = (examEndDate: string | null, today: string): boolean =>
  examEndDate !== null && today > examEndDate;

export interface StageInput {
  study_goal: string | null;
  goal_confirmed_at: string | null;
  exam_end_date: string | null;
}

/**
 * Mirror of the branch order in `get_my_stage()`, for the admin read models
 * that cannot call an auth.uid()-scoped RPC. The RPC stays the authority for a
 * student's own stage; this is only what the admin sees about someone else.
 */
export const computeStage = (input: StageInput, today: string): StudyStage => {
  if (!isExamEnded(input.exam_end_date, today)) return 'studying';

  if (
    input.study_goal === null ||
    input.study_goal === 'hsc' ||
    input.goal_confirmed_at === null
  ) {
    return 'post_hsc';
  }

  return 'admission_prep';
};
