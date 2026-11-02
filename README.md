# ParaPoth Backend

Express + TypeScript API for the ParaPoth exam platform. Deployed on Render.

## Scripts

```bash
npm run dev      # tsx watch src/server.ts
npm run build    # tsc
npm start        # node dist/server.js
npm test         # node:test specs (tsx)
```

## Configuration

All configuration is supplied through environment variables. A complete
template lives in [`.env.example`](.env.example); copy it to `.env` for local
development and never commit the result.

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase project credentials. The service role key is server-only. |
| `CLIENT_URL` | Extra allowed browser origins, comma separated. Firebase Hosting origins are always allowed in production. |
| `EXAM_SUBMIT_GRACE_MS` | Submission grace window in milliseconds (default `30000`, max `600000`). |
| `PORT`, `NODE_ENV` | Runtime port and mode. |
| `FIREBASE_*` | Firebase Admin credentials for push notifications. |
| `CLOUDINARY_*` | Media uploads. |
| `SMTP_EMAIL`, `SMTP_PASSWORD` | Outbound email. |
| `GEMINI_API_KEY` | Student AI Assistant (tutor chat and explanations). |
| `GEMINI_EMBEDDING_API_KEY` | Question embeddings. |
| `EXTRACTION_GEMINI_API_KEY` | AI Question Importer extraction, from its own Google Cloud project. |
| `EXTRACTION_GEMINI_MODEL` | Optional extraction model override (default `gemini-3.8-flash`). |

### AI provider isolation

Two Gemini credentials exist and they are never interchangeable:

- `GEMINI_API_KEY` serves the student AI Assistant and is read only by
  `features/ai/ai.service.ts`.
- `EXTRACTION_GEMINI_API_KEY` serves question extraction and is read only by
  `features/ai/ai.extract.provider.ts`. It must come from a second Google Cloud
  project so importer traffic cannot exhaust the assistant's quota.

When the extraction key is missing the endpoint answers `503` with
`EXTRACTION_NOT_CONFIGURED`; it never borrows the assistant key. Extraction runs
on `EXTRACTION_GEMINI_MODEL` (default `gemini-3.8-flash`, a free-tier vision
model) with its own prompt, JSON output mode, validation and per-user rate
limit.

### `EXAM_SUBMIT_GRACE_MS`

A student's browser submits automatically when the countdown reaches zero. That
request can reach the API slightly after `deadline_at`, so claiming an attempt
for **submission** accepts a short grace window. Invalid values fall back to the
default instead of failing the request.

The grace applies only to submission claiming. Draft autosave, resume and
starting a new attempt remain strictly bounded by the authoritative deadline.

## Exam attempt lifecycle

- Attempts live in `exam_progress` and are server-owned: the browser has no
  table privileges, only the backend service role reads or writes them.
- A student may take a specific exam only once. The API returns
  `409` with `code: "ALREADY_ATTEMPTED"` and `details.exam_history_id`; a
  database trigger (`P0409`) enforces the same rule under concurrency.
- A background sweeper runs every five minutes and marks attempts past
  `deadline_at + EXAM_SUBMIT_GRACE_MS` as expired.
- `exam_history.status` accepts `passed`, `failed`, `pending` and
  `fraud_detected`.

## Migrations

`supabase/migrations/` is a history mirror of the live project. Files are
committed for provenance and are **not** applied automatically.
