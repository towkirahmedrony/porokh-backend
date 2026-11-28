# APK distribution

One Android APK, one canonical location, three surfaces:

```
GitHub Actions (signed release build)
        │  scripts/publish-apk.sh
        ▼
Supabase Storage   porokh-apk / releases/latest/Porokh.apk
        │  public read                 ▲ upload / replace / delete
        ▼                              │
Marketing website (public)      Admin panel → Backend admin API
GET /api/v1/releases/latest     /api/v1/admin/releases/apk
```

## Storage and database

- Bucket `porokh-apk`, public read only, 100 MiB limit, APK/octet-stream/zip
  MIME types. There is deliberately **no** insert/update/delete policy: the
  anon and authenticated roles can never write to it.
- Canonical object `releases/latest/Porokh.apk`. The path is a constant in
  `src/features/releases/releases.constants.ts` and in
  `porokh/scripts/publish-apk.sh`; clients never supply a path.
- Table `public.apk_release`: exactly one row (`id = 1`) describing the
  current file (`version_name`, `version_code`, `original_filename`,
  `file_size`, `sha256`, `released_at`, `published_by`). RLS is enabled with no
  policies, so only the service role can read or write it. No row means no APK
  is published.

Migration: `supabase/migrations/20261128120000_apk_release.sql`.
Rollback: `supabase/rollbacks/20261128120000_apk_release.down.sql`.

## API

Public (no auth):

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/api/v1/releases/latest` | `200` with release metadata and `downloadUrl`; `404` with `{ available: false }` when nothing is published |

Admin (`requireAuth` + `rbacGuard(['admin','super_admin'])` +
`settings.manage` permission):

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/api/v1/admin/releases/apk` | Current release, or `{ available: false }` |
| `POST` | `/api/v1/admin/releases/apk?version_name=&version_code=&filename=` | Raw APK body (`Content-Type: application/vnd.android.package-archive`); uploads, replaces, verifies, then writes metadata |
| `DELETE` | `/api/v1/admin/releases/apk` | Removes the stored object, then the release row |

Validation on upload: ZIP structure plus `AndroidManifest.xml` and
`classes.dex`, ≤ 100 MiB, `.apk` filename, `version_name` like `1.2.3`,
positive integer `version_code`. The browser-supplied MIME type and filename are
never trusted as the storage path.

Replacement safety: the object is uploaded with `upsert` in a single request
(the previous file keeps serving until it succeeds), then read back from Storage
by size before the metadata row is written. A failed upload leaves both the old
file and its metadata untouched.

Deletion order: object first, then the row. If Storage refuses, the release is
left whole and the caller gets `502`.

## Required configuration

### GitHub Actions — `towkirahmedrony/porokh` repository secrets

| Secret | Value |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key (server-side only) |

Without them the publish step fails with an explicit `::error::` naming the
missing secret; the APK build itself is unaffected. The key is used in the
workflow only and is never printed, written to `.env.local`, or uploaded as an
artifact.

### Render (backend)

No new variables. The feature reuses `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`, which the service already needs.

### Vercel (marketing website)

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | Backend origin, e.g. `https://porokhbd.onrender.com` (with or without `/api/v1`) |

The backend must allow the website origin in CORS. The built-in
`MARKETING_ORIGINS` entry covers `https://proshno-nu.vercel.app`; a custom domain
must be added to the backend's `CLIENT_URL` (comma separated).

### Admin panel

No new variables; it calls the backend through the existing `VITE_API_URL`.

## Publishing behaviour

`porokh/.github/workflows/build-apk.yml` publishes after the signed APK has been
verified and uploaded as a workflow artifact, and only for `main` pushes and
manual dispatches. `android.yml` (debug builds) never publishes.

`publish-apk.sh`:

1. validates the file is an APK and within the size limit;
2. reads `versionName` / `versionCode` from `android/app/build.gradle`
   (overridable by arguments);
3. uploads to the canonical object with `x-upsert: true`;
4. downloads the public URL and compares SHA-256;
5. upserts `apk_release` and reads it back to compare version, size and hash;
6. writes a summary to `$GITHUB_STEP_SUMMARY`.

Re-running the job is idempotent: the same object and the same row are
overwritten with identical values.
