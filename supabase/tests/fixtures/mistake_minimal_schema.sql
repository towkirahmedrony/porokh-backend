-- Minimal schema for the mistake definition tests.
--
-- Only the objects public.user_mistake_questions() and its wrappers touch are
-- created. The two helper functions at the bottom are stubs: the real
-- practiceable_question_ids() (publication/premium gating) and
-- get_history_question_set() (attempt question order) are unchanged by this
-- work and are exercised elsewhere.

-- Supabase provides this; the dismissals migration only needs it to compile.
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

create table public.profiles (
  id uuid primary key,
  settings jsonb not null default '{}'::jsonb
);

create table public.questions (
  id uuid primary key,
  subject_id uuid,
  chapter_id uuid,
  topic_id uuid,
  status text default 'published',
  is_active boolean default true,
  deleted_at timestamptz
);

create table public.exam_history (
  id uuid primary key,
  user_id uuid references public.profiles (id),
  exam_id text,
  status text,
  correct_count integer default 0,
  wrong_count integer default 0,
  skipped_count integer default 0,
  submitted_at timestamptz,
  created_at timestamptz default now()
);

create table public.exam_history_details (
  id uuid primary key,
  exam_history_id uuid references public.exam_history (id) on delete cascade,
  question_id uuid,
  selected_option text,
  is_correct boolean,
  marks_awarded numeric default 0,
  created_at timestamptz default now()
);

create table public.mistake_dismissals (
  user_id uuid not null references public.profiles (id) on delete cascade,
  question_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, question_id)
);

create function public.get_user_access(p_user_id uuid)
returns jsonb
language sql
stable
as $$ select jsonb_build_object('premium', true); $$;

-- Stub: every question is practiseable in the fixture.
create function public.practiceable_question_ids(p_ids uuid[], p_premium boolean)
returns table(id uuid)
language sql
stable
as $$ select q.id from public.questions q where q.id = any (p_ids); $$;

-- Stub: attempt question order follows the stored responses.
create function public.get_history_question_set(p_user_id uuid, p_history_id uuid)
returns table(pos integer, question_id uuid, available boolean)
language sql
stable
as $$
  select (row_number() over (order by d.created_at, d.id))::integer, d.question_id, true
  from public.exam_history_details d
  join public.exam_history eh on eh.id = d.exam_history_id
  where d.exam_history_id = p_history_id and eh.user_id = p_user_id;
$$;
