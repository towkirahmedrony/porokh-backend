-- Student answer-key read for the question bank.
--
-- The list RPCs intentionally omit answer keys. This sibling read returns the
-- correct option ids only for questions the caller is already allowed to read:
--   * the caller must be authenticated;
--   * premium rows stay hidden unless the caller has premium access;
--   * published/active/non-deleted rows only;
--   * questions used by a live (not yet ended) exam paper are excluded.
--
-- It is a separate function so the list RPC signature and response shape stay
-- unchanged, and so the frontend can request answers lazily after the list has
-- rendered.

create or replace function public.get_student_question_bank_answers(
  p_question_ids text[]
)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_access jsonb;
  v_has_premium boolean := false;
  v_question_ids text[] := array(
    select distinct btrim(candidate)
    from unnest(coalesce(p_question_ids, '{}'::text[])) as candidate
    where btrim(candidate) <> ''
  );
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if cardinality(v_question_ids) = 0 then
    return;
  end if;

  v_access := public.get_user_access(v_uid);
  v_has_premium := coalesce((v_access->>'premium')::boolean, false)
    or coalesce((v_access->>'unlimited_all')::boolean, false);

  return query
  select jsonb_build_object(
    'id', q.id,
    'correct_option_ids',
      case
        when jsonb_typeof(q.options) <> 'array' then '[]'::jsonb
        else coalesce(
          (
            select jsonb_agg(
              o.item -> 'id'
              order by o.ord
            )
            from jsonb_array_elements(q.options) with ordinality as o(item, ord)
            where (
              o.item @> '{"isCorrect": true}'::jsonb
              or o.item @> '{"is_correct": true}'::jsonb
            )
            and jsonb_typeof(o.item -> 'id') in ('string', 'number')
          ),
          '[]'::jsonb
        )
      end
  )
  from (
    select
      q.*,
      (
        (
          coalesce(s.is_premium, false)
          or coalesce(c.is_premium, false)
          or coalesce(t.is_premium, false)
        )
        and not v_has_premium
      ) as locked
    from public.questions q
    join public.subjects s on s.id = q.subject_id and s.is_active is true
    left join public.chapters c on c.id = q.chapter_id
    left join public.topics t on t.id = q.topic_id
    where q.id::text = any(v_question_ids)
      and q.status = 'published'
      and q.is_active is true
      and q.deleted_at is null
      and (q.chapter_id is null or c.is_active is true)
      and (q.topic_id is null or t.is_active is true)
      and not exists (
        select 1
        from public.exam_paper_questions epq
        join public.exam_papers ep on ep.id = epq.exam_id
        where epq.question_id = q.id
          and (ep.end_time is null or ep.end_time > now())
      )
  ) q
  where not q.locked;
end;
$$;

revoke all on function public.get_student_question_bank_answers(text[]) from public, anon;
grant execute on function public.get_student_question_bank_answers(text[]) to authenticated;

comment on function public.get_student_question_bank_answers(text[]) is
  'Returns correct option ids for explicitly requested question bank rows. Authenticated only; premium, removed and live-exam rows are omitted.';
