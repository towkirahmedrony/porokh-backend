-- Practice modes: retake, wrong-from-history and global mistake practice.
--
-- This migration mirrors the schema that is already live on the test project
-- (version 20261026042225). It is not applied automatically by the repository.
--
-- Rules enforced here are intentionally split between exam_progress (the
-- in-progress attempt) and exam_history (the submitted result):
--   * a practice attempt/result carries one of the three practice modes;
--   * practice attempts/results never point at an exam paper, so old exam
--     content can only be reached through the frozen question set;
--   * source_history_id is only valid for retake/wrong_from_history and points
--     at the result the practice set came from.

alter table public.exam_progress
  add column if not exists practice_mode text,
  add column if not exists source_history_id uuid;

alter table public.exam_history
  add column if not exists practice_mode text,
  add column if not exists source_history_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'exam_progress_practice_mode_check'
  ) then
    alter table public.exam_progress
      add constraint exam_progress_practice_mode_check
      check (
        practice_mode is null
        or practice_mode in ('retake', 'wrong_from_history', 'wrong_global')
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'exam_progress_practice_mode_shape'
  ) then
    alter table public.exam_progress
      add constraint exam_progress_practice_mode_shape
      check (practice_mode is null or (kind = 'practice' and exam_id is null));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'exam_progress_source_history_id_fkey'
  ) then
    alter table public.exam_progress
      add constraint exam_progress_source_history_id_fkey
      foreign key (source_history_id) references public.exam_history(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'exam_progress_source_requires_mode'
  ) then
    alter table public.exam_progress
      add constraint exam_progress_source_requires_mode
      check (
        source_history_id is null
        or practice_mode in ('retake', 'wrong_from_history')
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'exam_history_practice_mode_check'
  ) then
    alter table public.exam_history
      add constraint exam_history_practice_mode_check
      check (
        practice_mode is null
        or practice_mode in ('retake', 'wrong_from_history', 'wrong_global')
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'exam_history_practice_mode_shape'
  ) then
    alter table public.exam_history
      add constraint exam_history_practice_mode_shape
      check (practice_mode is null or exam_id is null);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'exam_history_source_history_id_fkey'
  ) then
    alter table public.exam_history
      add constraint exam_history_source_history_id_fkey
      foreign key (source_history_id) references public.exam_history(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'exam_history_source_requires_mode'
  ) then
    alter table public.exam_history
      add constraint exam_history_source_requires_mode
      check (
        source_history_id is null
        or practice_mode in ('retake', 'wrong_from_history')
      );
  end if;
end $$;

create index if not exists exam_progress_source_history_idx
  on public.exam_progress (source_history_id)
  where source_history_id is not null;

create index if not exists exam_history_source_history_idx
  on public.exam_history (source_history_id)
  where source_history_id is not null;

-- The quota row is what makes global mistake practice visible/editable in the
-- admin Free Limits tab. It ships disabled (unmetered) and is enabled by an
-- administrator when the product is ready to meter it.
insert into public.feature_quotas (feature, title_bn, title_en, free_daily_limit, is_enabled)
values (
  'mistake_practice',
  'ভুল প্রশ্নের অনুশীলন',
  'Mistake practice',
  5,
  false
)
on conflict (feature) do nothing;
