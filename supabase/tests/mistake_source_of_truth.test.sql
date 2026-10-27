-- Behaviour tests for public.user_mistake_questions(), the single mistake
-- definition. Run with supabase/tests/run-mistake-tests.sh.
--
-- Covered: wrong only, skipped only, mixed, dismissed question, several
-- attempts of the same exam, another user's data, fraud-flagged attempts and
-- the exam card count matching the list.

\set ON_ERROR_STOP on

begin;

-- Test users.
insert into public.profiles (id, settings) values
  ('00000000-0000-0000-0000-0000000000a1', '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000000b2', '{}'::jsonb);

-- Difficulty: none. Questions are only referenced by id.
create function pg_temp.q(index integer) returns uuid
language sql immutable as $$
  select ('00000000-0000-0000-0000-' || lpad(index::text, 12, '0'))::uuid;
$$;

insert into public.questions (id)
select pg_temp.q(i) from generate_series(1, 40) as i;

create function pg_temp.check(p_label text, p_actual bigint, p_expected bigint)
returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL %: expected %, got %', p_label, p_expected, p_actual;
  end if;
  raise notice 'PASS %', p_label;
end $$;

create function pg_temp.check_text(p_label text, p_actual text, p_expected text)
returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL %: expected %, got %', p_label, p_expected, p_actual;
  end if;
  raise notice 'PASS %', p_label;
end $$;

-- ---------------------------------------------------------------- wrong only
insert into public.exam_history (id, user_id, exam_id, status, wrong_count, submitted_at, created_at)
values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1',
        'exam-1', 'completed', 1, '2026-10-18 10:00:00+00', '2026-10-18 10:00:00+00');
insert into public.exam_history_details (id, exam_history_id, question_id, selected_option, is_correct, created_at)
values ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
        pg_temp.q(1), 'a', false, '2026-10-18 10:00:00+00');

do $$
begin
  perform pg_temp.check(
    'wrong only -> one mistake',
    (select count(*) from public.user_mistake_questions('00000000-0000-0000-0000-0000000000a1')),
    1
  );
  perform pg_temp.check_text(
    'wrong only -> labelled wrong',
    (select status from public.user_mistake_questions('00000000-0000-0000-0000-0000000000a1')),
    'wrong'
  );
end $$;

-- --------------------------------------------------------------- skipped only
update public.exam_history_details
set is_correct = null, selected_option = null
where id = '20000000-0000-0000-0000-000000000001';

do $$
begin
  perform pg_temp.check(
    'skipped only -> one mistake',
    (select count(*) from public.user_mistake_questions('00000000-0000-0000-0000-0000000000a1')),
    1
  );
  perform pg_temp.check_text(
    'skipped only -> labelled skipped',
    (select status from public.user_mistake_questions('00000000-0000-0000-0000-0000000000a1')),
    'skipped'
  );
end $$;

-- --------------------------------------------------------- mixed, latest wins
insert into public.exam_history_details (id, exam_history_id, question_id, selected_option, is_correct, created_at)
values
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
   pg_temp.q(2), 'b', false, '2026-10-18 10:01:00+00'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001',
   pg_temp.q(3), 'a', true, '2026-10-18 10:02:00+00');

-- A later attempt of the same exam answers q1 correctly: it stops being a
-- mistake, so only the skipped q2 remains.
insert into public.exam_history (id, user_id, exam_id, status, wrong_count, submitted_at, created_at)
values ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1',
        'exam-1', 'completed', 0, '2026-10-19 10:00:00+00', '2026-10-19 10:00:00+00');
insert into public.exam_history_details (id, exam_history_id, question_id, selected_option, is_correct, created_at)
values ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002',
        pg_temp.q(1), 'b', true, '2026-10-19 10:00:00+00');

do $$
begin
  perform pg_temp.check(
    'mixed -> wrong and skipped only, correct answer removed',
    (select count(*) from public.user_mistake_questions('00000000-0000-0000-0000-0000000000a1')),
    1
  );
  perform pg_temp.check(
    'mixed -> only the wrong q2 remains, q1 is corrected by the later attempt',
    (select count(*) from public.user_mistake_questions('00000000-0000-0000-0000-0000000000a1')
      where question_id = pg_temp.q(2) and status = 'wrong'),
    1
  );
  perform pg_temp.check(
    'mixed -> the corrected question is gone',
    (select count(*) from public.user_mistake_questions('00000000-0000-0000-0000-0000000000a1')
      where question_id = pg_temp.q(1)),
    0
  );
end $$;

-- ------------------------------------------------------ dismissed questions
-- q2 is dismissed after the response -> hidden. A newer wrong answer for q2
-- makes it visible again.
insert into public.mistake_dismissals (user_id, question_id, created_at)
values ('00000000-0000-0000-0000-0000000000a1', pg_temp.q(2), '2026-10-18 12:00:00+00');

do $$
begin
  perform pg_temp.check(
    'dismissed question is hidden',
    (select count(*) from public.user_mistake_questions('00000000-0000-0000-0000-0000000000a1')),
    0
  );
end $$;

insert into public.exam_history_details (id, exam_history_id, question_id, selected_option, is_correct, created_at)
values ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000002',
        pg_temp.q(2), 'a', false, '2026-10-19 10:05:00+00');

do $$
begin
  perform pg_temp.check(
    'a newer wrong answer reopens the dismissed question',
    (select count(*) from public.user_mistake_questions('00000000-0000-0000-0000-0000000000a1')),
    1
  );
  perform pg_temp.check(
    'reopened question is attributed to the newest attempt',
    (select count(*) from public.get_user_mistake_counts('00000000-0000-0000-0000-0000000000a1')
      where exam_history_id = '10000000-0000-0000-0000-000000000002'),
    1
  );
end $$;

-- ------------------------------------------------- several attempts, one exam
do $$
begin
  perform pg_temp.check(
    'several attempts -> counts are grouped by the latest response only',
    (select count(*) from public.get_user_mistake_counts('00000000-0000-0000-0000-0000000000a1')),
    1
  );
end $$;

-- ------------------------------------------------------- another user's data
insert into public.exam_history (id, user_id, exam_id, status, wrong_count, submitted_at, created_at)
values ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000b2',
        'exam-1', 'completed', 2, '2026-10-20 10:00:00+00', '2026-10-20 10:00:00+00');
insert into public.exam_history_details (id, exam_history_id, question_id, selected_option, is_correct, created_at)
values
  ('20000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000003',
   pg_temp.q(5), 'a', false, '2026-10-20 10:00:00+00'),
  ('20000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000003',
   pg_temp.q(6), null, null, '2026-10-20 10:00:00+00');

do $$
begin
  perform pg_temp.check(
    'another user sees their own mistakes only',
    (select count(*) from public.user_mistake_questions('00000000-0000-0000-0000-0000000000b2')),
    2
  );
  perform pg_temp.check(
    'the first user is not affected by another user data',
    (select count(*) from public.user_mistake_questions('00000000-0000-0000-0000-0000000000a1')),
    1
  );
  perform pg_temp.check(
    'counts never leak between users',
    (select count(*) from public.get_user_mistake_counts('00000000-0000-0000-0000-0000000000a1')
      where exam_history_id = '10000000-0000-0000-0000-000000000003'),
    0
  );
end $$;

-- --------------------------------------------------------- fraud-flagged rows
insert into public.exam_history (id, user_id, exam_id, status, wrong_count, submitted_at, created_at)
values ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000a1',
        'exam-1', 'fraud_detected', 1, '2026-10-21 10:00:00+00', '2026-10-21 10:00:00+00');
insert into public.exam_history_details (id, exam_history_id, question_id, selected_option, is_correct, created_at)
values ('20000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000004',
        pg_temp.q(7), 'a', false, '2026-10-21 10:00:00+00');

do $$
begin
  perform pg_temp.check(
    'fraud-flagged attempts never create mistakes',
    (select count(*) from public.user_mistake_questions('00000000-0000-0000-0000-0000000000a1')
      where question_id = pg_temp.q(7)),
    0
  );
end $$;

-- --------------------------------------------- exam #2: 3 wrong + 26 skipped
delete from public.mistake_dismissals;
delete from public.exam_history_details;
delete from public.exam_history;

insert into public.exam_history (id, user_id, exam_id, status, correct_count, wrong_count, skipped_count, submitted_at, created_at)
values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1',
   'exam-bangla-1', 'completed', 30, 0, 0, '2026-10-17 10:00:00+00', '2026-10-17 10:00:00+00'),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1',
   'exam-bangla-1', 'completed', 1, 3, 26, '2026-10-18 10:00:00+00', '2026-10-18 10:00:00+00');

-- Attempt #2: q1..q3 wrong, q4..q29 skipped, q30 correct.
insert into public.exam_history_details (id, exam_history_id, question_id, selected_option, is_correct, created_at)
select gen_random_uuid(), '30000000-0000-0000-0000-000000000002', pg_temp.q(i),
       case when i <= 3 then 'a' when i = 30 then 'b' else null end,
       case when i <= 3 then false when i = 30 then true else null end,
       '2026-10-18 10:00:00+00'
from generate_series(1, 30) as i;

do $$
begin
  perform pg_temp.check(
    'exam #2 -> 3 wrong + 26 skipped = 29 mistakes',
    (select count(*) from public.user_mistake_questions('00000000-0000-0000-0000-0000000000a1')),
    29
  );
  perform pg_temp.check(
    'exam #2 card count equals the mistakes list',
    (select mistake_count from public.get_user_mistake_counts('00000000-0000-0000-0000-0000000000a1')
      where exam_history_id = '30000000-0000-0000-0000-000000000002'),
    29
  );
  perform pg_temp.check(
    'exam #2 practice set equals the card count',
    (select count(*) from public.get_history_wrong_questions('00000000-0000-0000-0000-0000000000a1',
      '30000000-0000-0000-0000-000000000002')),
    29
  );
  perform pg_temp.check(
    'cross-exam practice pool equals the mistakes list',
    (select public.count_mistake_pool('00000000-0000-0000-0000-0000000000a1')),
    29
  );
end $$;

-- Dismissing one skipped question hides it everywhere at once.
insert into public.mistake_dismissals (user_id, question_id, created_at)
values ('00000000-0000-0000-0000-0000000000a1', pg_temp.q(10), '2026-10-18 11:00:00+00');

do $$
begin
  perform pg_temp.check(
    'after 1 dismissal -> 28 mistakes',
    (select count(*) from public.user_mistake_questions('00000000-0000-0000-0000-0000000000a1')),
    28
  );
  perform pg_temp.check(
    'after 1 dismissal -> card count 28',
    (select mistake_count from public.get_user_mistake_counts('00000000-0000-0000-0000-0000000000a1')
      where exam_history_id = '30000000-0000-0000-0000-000000000002'),
    28
  );
  perform pg_temp.check(
    'after 1 dismissal -> practice set 28',
    (select count(*) from public.get_history_wrong_questions('00000000-0000-0000-0000-0000000000a1',
      '30000000-0000-0000-0000-000000000002')),
    28
  );
  perform pg_temp.check(
    'after 1 dismissal -> pool 28',
    (select public.count_mistake_pool('00000000-0000-0000-0000-0000000000a1')),
    28
  );
  perform pg_temp.check(
    'a dismissed skipped question is still reported as skipped when reopened',
    (select count(*) from public.user_mistake_questions('00000000-0000-0000-0000-0000000000a1')
      where status = 'skipped'),
    25
  );
end $$;

rollback;
