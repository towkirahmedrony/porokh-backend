-- Rollback for 20261127120000_question_bank_levels.sql.
--
-- Drops only what the migration added and restores the two functions it
-- replaced. The backfill is undone by re-running the restored derivation over
-- every question at the end, which is deterministic: after it, the auto rows on
-- a question are exactly the ones the previous derive_question_track_ids()
-- produces. Manual rows are never touched, by this script or by the sync.
--
-- Order matters. The restored derivation must be in place before the final
-- reconcile, and the sync must run before the functions it replaced are dropped
-- (it is not dropped, only redefined, so only the reconcile order matters).

-- 1. Drop the new triggers and the trigger function.
drop trigger if exists trg_questions_sync_auto_tracks on public.questions;
drop function if exists public.trg_questions_sync_auto_tracks();

-- 2. Drop the new read surface.
drop function if exists public.get_question_level_report();
drop function if exists public.get_question_bank_facets(
  text, text, boolean, text, text, text, uuid, uuid, text, text, boolean, boolean, boolean
);
drop function if exists public.get_student_question_bank_v3(
  text, text, boolean, text, text, text, text, text, boolean, boolean, boolean,
  uuid, uuid, text, integer, integer
);
drop function if exists public._qb_base(
  uuid, text, text, text, boolean, text, text, text, uuid, uuid, text, text,
  boolean, boolean, boolean, boolean, text
);
drop view if exists public.v_question_levels;

-- 3. Restore the previous derivation.
create or replace function public.derive_question_track_ids(p_question_id uuid)
returns text[]
language sql
stable
set search_path = ''
as $function$
  select coalesce(array_agg(distinct s.t order by s.t), '{}'::text[])
  from (
    select 'hsc'::text as t
      from public.question_institution_references r
     where r.question_id = p_question_id
       and r.exam_type in ('board_exam','college_test')
    union
    select i.preparation_track_id
      from public.question_institution_references r
      join public.institutions i on i.id = r.institution_id
     where r.question_id = p_question_id
       and r.exam_type = 'admission'
       and i.preparation_track_id is not null
  ) s
  where s.t is not null;
$function$;

-- 4. Reconcile every question to the restored derivation. This removes the auto
--    rows the migration's derivation produced and restores the ones it did not.
do $$
declare
  v_question record;
begin
  for v_question in select id from public.questions loop
    perform public.sync_question_auto_tracks(v_question.id);
  end loop;
end;
$$;

-- 5. Restore the previous grants, so the pre-migration API surface is unchanged.
grant execute on function public.derive_question_track_ids(uuid) to authenticated;
grant execute on function public.sync_question_auto_tracks(uuid) to authenticated;
