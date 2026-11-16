# Backend performance & scalability pass

Scope: this document describes what was **actually implemented** in this branch, the
expected effect, what was deliberately not implemented, and how it was verified.
Expected numbers are labelled as expected; nothing here is a measured production result.

Branch: `feat/backend-perf-scalability`
Architecture unchanged: Render + Supabase/Postgres, no Redis, no new services.

---

## A. Implemented changes

### A1. Authentication and RBAC (fewer DB reads per request)

| File | Change |
|---|---|
| `src/middlewares/requireAuth.ts` | Publishes the already-verified account state on `req.authAccount` (`accountStatus`, `sessionsRevokedAt`). |
| `src/middlewares/rbacGuard.ts` | Reuses `req.authAccount` instead of re-reading `profiles`; reads the active role through a bounded cache. |
| `src/middlewares/roleCache.ts` | **New.** 30s TTL, max 5000 entries, per-user keys, invalidate-on-assignment, hit/miss counters. Errors and non-canonical roles are never cached. |
| `src/features/users/users.roles.service.ts` | Invalidates the target user's cached role after `assign_user_role`. |
| `src/types/express/index.d.ts` | Declares `req.authAccount`. |

What is **not** cached, by design: the bearer token, the admin session row, the session
revocation timestamp, and the account status. Revoking an admin session still takes effect
on the very next request.

Order of checks is unchanged: role looked up → canonical → route-allowed → account active
(staff). Admin sessions are still verified against `admin_auth_sessions` on every request.

### A2. Exam start (`POST /exams/user/attempts/start`)

`src/features/exams/exam.attempt.service.ts` — independent reads are now issued together
(`Promise.allSettled`), and the results are consumed in the original order so error priority
is identical (access error → premium 403 → attempt-read error; history 409 → question-set 400).

Operations keep their identity and count; only the number of serial waits drops.

### A3. Exam submit (`POST /exams/user/submit`)

`src/features/exams/exams.user.service.ts` — the exam metadata, per-question marks and question
content reads are issued together. Grading, XP, claim/finalize, duplicate handling and response
shape are untouched.

### A4. Attempt sweeper (background job)

`src/jobs/exam.sweeper.job.ts` — one bounded set-based `UPDATE ... WHERE id = ANY(...)
AND status = 'in_progress' AND deadline_at < cutoff` replaces one UPDATE per attempt. The batch
size is configurable with `EXAM_SWEEP_BATCH_SIZE` (default 500, hard cap 5000). The statement is
idempotent, so overlapping sweeps are harmless.

### A5. External resources

| File | Change |
|---|---|
| `src/lib/utils/semaphore.ts` | **New.** Small bounded semaphore with a wait budget. |
| `src/features/ai/ai.extract.service.ts` | Caps concurrent Gemini extraction calls (default 3, `EXTRACTION_MAX_CONCURRENCY`, cap 10). Queue wait 10s, then `503 EXTRACTION_BUSY` with `Retry-After: 15`. Permit released in `finally`. `429 EXTRACTION_RATE_LIMITED` now carries `Retry-After: 30`. |
| `src/features/ai/ai.controller.ts` | Emits `Retry-After` when a service error carries one. |
| `src/middlewares/rateLimit.ts` | Bucket map bounded at 10 000 keys with expired-first pruning; 429s counted and logged by key prefix only. Limits and windows unchanged. |

The request validation still runs before a permit is taken, so malformed uploads never occupy
extraction capacity, and the 90s provider timeout is unchanged.

### A6. Observability, health, process safety

| File | Change |
|---|---|
| `src/features/system/health.controller.ts` | **New.** `/health/live` (no dependency) and `/health/ready` (one cheap DB read, 2s timeout, fails closed with 503). |
| `src/middlewares/requestMetrics.ts` | **New.** Records request duration per **route template** and logs one structured line for slow requests (`SLOW_REQUEST_LOG_MS`, default 1500). Health probes excluded. No request bodies, ids or query strings are logged. |
| `src/app.ts` | Registers the probes and the timing middleware. `/health` is byte-for-byte unchanged. |
| `src/server.ts` | `SIGTERM`/`SIGINT` drain the HTTP server (idle sockets closed, 10s forced-exit fallback). `unhandledRejection` is logged and the process stays up; `uncaughtException` is logged and the process drains and exits 1. |

### A7. Database migration (not applied)

`supabase/migrations/20261116120000_exam_progress_sweeper_index.sql` — partial index
`exam_progress (deadline_at) WHERE status = 'in_progress'`, the only candidate index from the
audit that did not already exist. Rationale and the verified list of already-covered indexes are
in the file header.

---

## B. Expected effect

Operation counts are from reading the code, not from a profiler.

| Path | Before | After |
|---|---|---|
| Privileged staff request (auth + role) | 4 queries (auth, profiles, user_roles, profiles) | 3, then **2** while the role is cached (≤30s) |
| Admin request (auth + role + session) | 5 | 4, then **3** |
| Student request | 2 | 2 (unchanged) |
| Exam start, fresh attempt | 7 operations, **7 serial waits** | 7 operations, **5 serial waits** |
| Exam submit | ~11 operations, 3 of them serial | ~11 operations, **1** serial wait for those 3 |
| Sweeper, 500 expired attempts | 1 select + 500 updates | 1 select + **1** update |
| Extraction, burst of 20 importers | up to 20 concurrent 90s model calls | 3 concurrent, at most 10 queued, rest get 503 quickly |

Expected, not measured: roughly 25–35% fewer round-trip waits on exam start/submit and one
fewer query on every cached staff request. No claim is made about p95 improvements until the
load test is run against staging.

---

## C. Security verification

| Property | Status |
|---|---|
| Token verification | Unchanged (`auth.getUser`). |
| Account suspension | Checked on every request by `requireAuth`; reused by the guard, never skipped. |
| Session revocation | Checked on every request; never cached. |
| Admin session / 2FA session row | Checked on every request; never cached. |
| Role changes | Effective immediately on the assigning instance (explicit invalidation); ≤30s elsewhere. |
| Role read failure | Denies (403/500), never cached. |
| Non-canonical role | Denied, never cached. |
| Exam grading | Still server-side only; client marks are still ignored. |
| Quota consume/refund | Unchanged ordering and reference ids; P0409 / 23505 handling unchanged. |
| Submission idempotency | Unchanged: one result per attempt, duplicates return the stored result. |

Covered by tests: `src/middlewares/rbacGuard.spec.ts` (11 cases), plus the existing
`exam.attempt.spec.ts`, `exam.security.spec.ts`, `exam.quota.spec.ts` suites, which all pass.

---

## D. Deployment

1. **Migration order.** Apply `20261116120000_exam_progress_sweeper_index.sql` after the
   existing `20261111120000_exam_admin_operations.sql`. It is additive and idempotent
   (`CREATE INDEX IF NOT EXISTS`). On a large table run it as `CREATE INDEX CONCURRENTLY`
   outside a transaction.
2. **Environment variables.** None required. Optional new knobs:
   `EXAM_SWEEP_BATCH_SIZE`, `EXTRACTION_MAX_CONCURRENCY`, `SLOW_REQUEST_LOG_MS`.
3. **Render.** Point the readiness check (if any) at `/health/ready` and keep liveness at
   `/health/live` or the existing `/health`. The process now shuts down gracefully on SIGTERM,
   so deploys should no longer cut off in-flight submissions.
4. **Rollback.** Revert the deploy; drop the index with
   `DROP INDEX IF EXISTS public.exam_progress_in_progress_deadline_idx;`. No data backfill was
   performed and none is needed.
5. **Manual steps.** None.

---

## E. Known limitations / deliberately not done

1. **Cron coordination across instances.** Each scheduled job still runs in every process.
   The sweeper and the notification campaign claim are idempotent/compare-and-set, so duplicates
   are harmless there; the embedding worker and streak jobs are not protected. A durable job
   lease needs a new table and RPC, i.e. a schema decision, so it was left out rather than
   guessed at. Recommended next step: a `job_leases(name, locked_until, owner)` table with an
   `UPDATE ... RETURNING` claim.
2. **No transactional `start_exam_attempt` / `submit_exam_attempt` RPC.** Grading and XP must
   stay in Node, and the existing design already obtains atomicity from the partial unique
   indexes (`exam_progress_active_exam_attempt_uidx`, `exam_history_attempt_id_uidx`,
   `unique_user_exam_submit`) plus the atomic claim. A plpgsql rewrite would duplicate quota and
   grading semantics and could not be verified without a staging database; the risk outweighed
   the two round trips it would save.
3. **Notification fan-out.** `activeProfileIds()` still loads every active profile id into memory
   for live-exam and streak reminders. Changing it changes delivery batching, so it needs a
   product decision (and keyset pagination through the `notify` batching path).
4. **Redundant indexes** exist (verified in the catalog) and were left alone because dropping
   them is a destructive DDL change needing explicit approval:
   `user_devices`: `idx_user_devices_user_id`, `idx_user_devices_fcm_token_not_null`,
   `idx_user_devices_user_token`, and the duplicate unique pair `user_devices_user_device_key` /
   `user_devices_user_id_device_id_unique`; `questions`: duplicate GIN indexes
   `idx_questions_search` / `idx_questions_search_vector` and `idx_questions_exam_refs` /
   `idx_questions_exam_referenced_gin`.
5. **Rate limiting is still per-process.** With more than one Render instance the effective
   limit multiplies. A shared limiter needs Redis or the platform edge; neither is in scope.
6. **No `EXPLAIN ANALYZE` evidence.** The index rationale comes from `pg_indexes` plus the query
   shapes in the code. Query-plan validation remains pending until it can be run on staging.
7. **`gemini` and other external calls** keep their existing timeouts. No circuit breaker was
   added: the provider client already normalises failures, and a half-working breaker is worse
   than none.

---

## F. Verification performed

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`, full project) | **Pass**, exit 0. |
| Test suite (all 67 spec files) | **653 tests, 648 pass, 5 fail** — see below. |
| New unit tests | 32 tests, all pass. |
| Migration validation | Not applied, not executed. Reviewed only. |
| Live endpoints (`/health`, `/health/ready`) | **Not exercised.** Starting the server activates the cron jobs against whichever Supabase project the local `.env` points at, so it was not run unprompted. |

Harness note: in this sandbox `node_modules/.bin/*` shims are malformed and the bundled
`esbuild` binary cannot load (`cannot locate symbol "dlsym"` under Android/Termux), so
`npm test` (`tsx --test`) cannot run at all. The suite was run by compiling the project with the
repo's own TypeScript compiler to a temporary directory and executing the emitted CommonJS with
`node --test`; the temporary build was deleted afterwards. `npm run build` failed the same way
(`tsc: not found`), so the build was executed as
`node node_modules/typescript/bin/tsc` — the same compiler and tsconfig the script uses.

The 5 failures, all environmental or pre-existing:

1–3. `access.http.spec.js`, `admissions.http.spec.js`, `users.admin.http.spec.js` — abort at
import with `Error: supabaseUrl is required.` from `phone-verify.routes`, because the sandbox has
no Supabase environment. Not related to this change.
4. `notifications.admin.rules.spec.js` — imports `./notifications.admin.rules.ts` with an
explicit `.ts` extension, which only resolves under `tsx`, not from compiled output.
5. `finance.payment.spec.js` → "an active subscription is extended by the plan duration" — the
fixture's subscription ends `2026-11-01` and the test expects a 2026-12-01 extension, but the
current date is 2026-11-16, so the service correctly treats it as expired. A pre-existing
date-dependent test, unrelated to this change.

The exam lifecycle suites that matter most here — `exam.attempt`, `exam.service`, `exam.security`,
`exam.quota`, `exam.practice`, `exam.hardening` — all pass, including concurrent start, concurrent
duplicate submission, grace window, one-result-per-attempt and quota-refund cases.

See `docs/load-test/README.md` for the staging load test that produces the numbers this document
deliberately does not claim.
