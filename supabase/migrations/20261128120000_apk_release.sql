-- APK distribution: one canonical object in Supabase Storage plus one row of
-- release metadata.
--
-- Why Storage and not another provider: the project already runs Supabase, and
-- the APK is a single public file that only trusted servers may replace. The
-- bucket is public for reads (anyone may download the app) and has deliberately
-- no INSERT/UPDATE/DELETE policy, so the anon and authenticated roles can never
-- write to it. Uploads come from two server-side callers only, both holding the
-- service-role key: the backend admin API and the signed-APK GitHub workflow.
--
-- Why a single row and not a history table: the feature needs one "current"
-- release. A history of superseded APKs would also keep old, still-installable
-- builds downloadable forever, which is the opposite of replacing them. The row
-- is pinned to id = 1 so publishing is an idempotent upsert instead of a
-- delete-then-insert that could leave the public site without metadata.
--
-- The canonical object path (releases/latest/Porokh.apk) is a constant in the
-- backend and the workflow, not a column: neither caller may choose a path.

-- ---------------------------------------------------------------------------
-- 1. Storage bucket
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'porokh-apk',
  'porokh-apk',
  true,
  104857600, -- 100 MiB, the backend enforces the same ceiling
  array[
    'application/vnd.android.package-archive',
    'application/octet-stream',
    'application/zip'
  ]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Public read. There is intentionally no insert/update/delete policy: writes
-- are service-role only.
drop policy if exists "porokh-apk public read" on storage.objects;
create policy "porokh-apk public read"
  on storage.objects
  for select
  to public
  using (bucket_id = 'porokh-apk');

-- ---------------------------------------------------------------------------
-- 2. Release metadata
-- ---------------------------------------------------------------------------
create table if not exists public.apk_release (
  id smallint primary key default 1 check (id = 1),
  version_name text not null,
  version_code integer not null check (version_code between 1 and 2100000000),
  original_filename text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 104857600),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  released_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_by uuid references auth.users (id) on delete set null
);

comment on table public.apk_release is
  'The single currently published Android APK. The file itself lives at porokh-apk/releases/latest/Porokh.apk; no row means no APK is available.';

-- RLS with no policy means the anon and authenticated roles cannot read or
-- write this table at all. The public website reads release metadata through
-- the backend's public endpoint, which is the only thing allowed to see it.
alter table public.apk_release enable row level security;
revoke all on public.apk_release from anon, authenticated;

-- The backend and the GitHub workflow both write as service_role.
grant select, insert, update, delete on public.apk_release to service_role;
