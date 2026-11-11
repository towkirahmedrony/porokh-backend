-- Exam Management: indexes for the admin catalog, live monitor and moderation.
--
-- Additive only. No table, column or row is changed; every statement is
-- idempotent, so it is safe on an existing database and on a fresh one.
--
-- The admin catalog now pages and filters in Postgres instead of loading every
-- paper, and the live monitor reads in-progress attempts for one exam ordered
-- by the latest heartbeat. The moderation list reads one exam's results ordered
-- by score then time. Those three reads are what these indexes cover.

-- Admin catalog: newest-first listing and publication filtering.
CREATE INDEX IF NOT EXISTS idx_exam_papers_admin_listing
  ON public.exam_papers (is_published, created_at DESC);

-- Admin catalog: published papers narrowed by their schedule window.
CREATE INDEX IF NOT EXISTS idx_exam_papers_published_window
  ON public.exam_papers (is_published, start_time, end_time)
  WHERE is_published;

-- Live monitor: in-progress attempts of one exam, most recently active first.
CREATE INDEX IF NOT EXISTS idx_exam_progress_exam_status_heartbeat
  ON public.exam_progress (exam_id, last_updated_at DESC)
  WHERE status = 'in_progress';

-- Results and leaderboard moderation: one exam's results by rank order.
CREATE INDEX IF NOT EXISTS idx_exam_history_exam_score
  ON public.exam_history (exam_id, score DESC, time_taken ASC);
