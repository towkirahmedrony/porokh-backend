-- Mirror of the already-applied exam_papers.track change.
-- Idempotent: safe to run on databases that already have the column/constraint/index.

alter table public.exam_papers add column if not exists track text;

alter table public.exam_papers drop constraint if exists exam_papers_track_check;
alter table public.exam_papers add constraint exam_papers_track_check
  check (track is null or track in ('hsc', 'medical', 'engineering', 'varsity'));

create index if not exists idx_exam_papers_listing
  on public.exam_papers (category, track, is_published);
