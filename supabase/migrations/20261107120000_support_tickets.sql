-- Support & report system (additive).
--
-- A ticket is a student's private support thread. The opening report and every
-- later reply are rows in support_ticket_messages, so the description is never
-- duplicated between the ticket and its conversation.
--
-- Status lifecycle (enforced in the API, mirrored by the check constraint):
--   open -> in_progress | awaiting_student | resolved | closed
--   in_progress -> open | awaiting_student | resolved | closed
--   awaiting_student -> open | in_progress | resolved | closed
--   resolved -> open | closed
--   closed -> open
--
-- All reads and writes go through the API with the service role. RLS below is
-- defence in depth: a student session may only read its own tickets and thread.

-- 1. Human-readable reference ------------------------------------------------
create sequence if not exists public.support_ticket_ref_seq;

-- 2. Tickets -----------------------------------------------------------------
create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_ref text not null unique
    default ('PRK-' || lpad(nextval('public.support_ticket_ref_seq')::text, 6, '0')),
  user_id uuid not null references public.profiles(id) on delete cascade,
  category text not null,
  subject text not null,
  status text not null default 'open',
  priority text not null default 'normal',
  assigned_to uuid references public.profiles(id) on delete set null,
  context_question_id text,
  context_exam_id text,
  context_screen text,
  last_message_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint support_tickets_category_check check (
    category in ('general', 'bug', 'question', 'exam', 'account', 'payment', 'feature', 'other')
  ),
  constraint support_tickets_status_check check (
    status in ('open', 'in_progress', 'awaiting_student', 'resolved', 'closed')
  ),
  constraint support_tickets_priority_check check (
    priority in ('low', 'normal', 'high', 'urgent')
  ),
  constraint support_tickets_subject_length check (
    char_length(btrim(subject)) between 5 and 140
  ),
  constraint support_tickets_context_length check (
    (context_question_id is null or char_length(context_question_id) <= 128)
    and (context_exam_id is null or char_length(context_exam_id) <= 128)
    and (context_screen is null or char_length(context_screen) <= 128)
  )
);

comment on table public.support_tickets is
  'Student support/report tickets. Conversations live in support_ticket_messages.';
comment on column public.support_tickets.ticket_ref is
  'Student-facing reference such as PRK-000123; generated from support_ticket_ref_seq.';
comment on column public.support_tickets.context_question_id is
  'Question the report was opened from, if any. Text because question ids are not always uuid.';
comment on column public.support_tickets.context_exam_id is
  'Exam/attempt the report was opened from, if any.';
comment on column public.support_tickets.resolved_by is
  'Staff member who moved the ticket to resolved.';
comment on column public.support_tickets.last_message_at is
  'Ordering key for student and admin ticket lists.';

create index if not exists idx_support_tickets_user_last_message
  on public.support_tickets (user_id, last_message_at desc);
create index if not exists idx_support_tickets_queue
  on public.support_tickets (status, last_message_at desc);
create index if not exists idx_support_tickets_assigned
  on public.support_tickets (assigned_to)
  where assigned_to is not null;
create index if not exists idx_support_tickets_created
  on public.support_tickets (created_at desc);

drop trigger if exists trg_support_tickets_updated_at on public.support_tickets;
create trigger trg_support_tickets_updated_at
  before update on public.support_tickets
  for each row execute function public.set_updated_at();

-- 3. Conversation messages ---------------------------------------------------
create table if not exists public.support_ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  author_role text not null,
  body text not null,
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint support_ticket_messages_role_check check (
    author_role in ('student', 'staff')
  ),
  constraint support_ticket_messages_body_length check (
    char_length(btrim(body)) between 1 and 5000
  ),
  constraint support_ticket_messages_attachments_array check (
    jsonb_typeof(attachments) = 'array'
  )
);

comment on table public.support_ticket_messages is
  'Ordered conversation for a support ticket, including the opening report.';
comment on column public.support_ticket_messages.attachments is
  'Array of {url, name, mime_type, size} objects uploaded through the API to Cloudinary.';

create index if not exists idx_support_ticket_messages_thread
  on public.support_ticket_messages (ticket_id, created_at);
create index if not exists idx_support_ticket_messages_author
  on public.support_ticket_messages (author_id);

-- 4. RLS ---------------------------------------------------------------------
alter table public.support_tickets enable row level security;
alter table public.support_ticket_messages enable row level security;

drop policy if exists support_tickets_select_own on public.support_tickets;
create policy support_tickets_select_own
  on public.support_tickets
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists support_tickets_admin_all on public.support_tickets;
create policy support_tickets_admin_all
  on public.support_tickets
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists support_ticket_messages_select_thread on public.support_ticket_messages;
create policy support_ticket_messages_select_thread
  on public.support_ticket_messages
  for select
  to authenticated
  using (
    public.is_admin()
    or exists (
      select 1
        from public.support_tickets t
       where t.id = support_ticket_messages.ticket_id
         and t.user_id = auth.uid()
    )
  );

drop policy if exists support_ticket_messages_admin_all on public.support_ticket_messages;
create policy support_ticket_messages_admin_all
  on public.support_ticket_messages
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 5. Grants ------------------------------------------------------------------
-- Writes are service-role only; a browser session can only read its own rows
-- through the policies above.
revoke all on table public.support_tickets from anon;
revoke all on table public.support_ticket_messages from anon;
revoke insert, update, delete on table public.support_tickets from authenticated;
revoke insert, update, delete on table public.support_ticket_messages from authenticated;
grant select on table public.support_tickets to authenticated;
grant select on table public.support_ticket_messages to authenticated;
grant select, insert, update, delete on table public.support_tickets to service_role;
grant select, insert, update, delete on table public.support_ticket_messages to service_role;
grant usage, select on sequence public.support_ticket_ref_seq to service_role;
