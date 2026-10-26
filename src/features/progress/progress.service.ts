import { supabase } from '../../config/supabase';
import { ProgressDashboardResponse } from './progress.types';

export const getProgressDashboardData = async (userId: string): Promise<ProgressDashboardResponse> => {
  // Every section is independent, so fetch them concurrently instead of
  // paying six serial database round trips.
  const [profileResult, historyResult, subjectStatsResult, heatmapResult, weaknessResult] =
    await Promise.all([
      supabase
        .from('profiles')
        .select('full_name, batch_year, current_streak, total_xp')
        .eq('id', userId)
        .single(),
      supabase
        .from('exam_history')
        .select('created_at, score, total_marks')
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
      supabase.rpc('get_student_subject_analytics', { p_user_id: userId }),
      supabase
        .from('user_daily_activities')
        .select('activity_date, exams_taken')
        .eq('user_id', userId)
        .order('activity_date', { ascending: false })
        .limit(30),
      supabase.rpc('get_student_weaknesses', { p_user_id: userId }).limit(3),
    ]);

  const profile = profileResult.data;

  if (profileResult.error) {
    console.error('Profile Fetch Error:', profileResult.error);
  }

  const history = historyResult.data ?? [];
  const totalExams = history.length;
  const avgScore =
    totalExams > 0
      ? history.reduce((acc, curr) => acc + (curr.score / curr.total_marks) * 100, 0) /
        totalExams
      : 0;

  const performanceChart = history
    .slice(0, 7)
    .reverse()
    .map((exam) => ({
      name: new Date(exam.created_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      }),
      score: Math.round((exam.score / exam.total_marks) * 100),
    }));

  const subjectStats = subjectStatsResult.data;
  const skillMapping = [];
  const subjectReport = [];

  if (subjectStats) {
    for (const stat of subjectStats) {
      skillMapping.push({
        subject: stat.subject_name,
        A: stat.mastery_percentage,
        fullMark: 100,
      });

      subjectReport.push({
        subject: stat.subject_name,
        score: stat.average_score,
        correct: stat.total_correct,
        wrong: stat.total_wrong,
        skipped: stat.total_skipped,
      });
    }
  }

  const activityHeatmap =
    heatmapResult.data?.map((h) => ({
      cal_date: h.activity_date,
      exams_taken: h.exams_taken,
    })) || [];

  const weaknesses =
    weaknessResult.data?.map((w: any) => ({
      topic: w.topic_name,
      subject: w.subject_name,
      errorRate: `${Math.round(w.error_rate)}%`,
    })) || [];

  return {
    user: {
      name: profile?.full_name || 'Student',
      batch: profile?.batch_year || 'HSC'
    },
    metrics: {
      averageScore: Number(avgScore.toFixed(1)),
      totalExams,
      streak: profile?.current_streak || 0,
      globalRank: 'Top 15%' 
    },
    performanceChart,
    skillMapping,
    activityHeatmap,
    weaknesses,
    focusTopic: weaknesses.length > 0 ? weaknesses[0].topic : 'General Revision',
    subjectReport
  };
};
