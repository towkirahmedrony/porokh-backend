# Staging load test plan

Reproducible k6 plan for the paths this performance pass touched. **Never run this against
production** and never point it at the production Supabase project.

k6 is not installed in the repository and this script has **not been executed**; it is the
procedure that produces the before/after numbers, not a recorded result.

## 1. Prerequisites

- A staging deployment of this API on Render (or locally with `npm run dev`) backed by the
  **test** Supabase project.
- 2–3 student accounts on staging (the tests sign in with Supabase, so they need real users).
- k6 v0.50+ (`brew install k6`, `apt install k6`, or the Docker image).
- Exam fixtures: at least one published exam with ≥20 questions, one practice question set, and
  free-tier quota headroom for the number of iterations you plan.

## 2. Environment

```bash
export API_URL="https://<staging-host>/api/v1"
export SUPABASE_URL="https://<test-project>.supabase.co"
export SUPABASE_ANON_KEY="<test anon key>"      # never the service-role key
export STUDENT_EMAIL_1="student1@example.test"
export STUDENT_PASSWORD_1="..."
export EXAM_ID="<published exam id>"
```

The token is obtained with the anon key, exactly like the real client, so `requireAuth` runs for
real. No service-role key and no database access are used by the test.

## 3. What each scenario measures

| Scenario | Weight | What it stresses |
|---|---|---|
| `auth` | light | `auth.getUser` + profile + role path |
| `exam_start` | heavy | the attempt-creation path (quota RPC, unique index, refund) |
| `questions` | medium | attempt question fetch |
| `autosave` | heavy | draft PATCH (blind writes) |
| `submit` | heavy | grading + history/detail writes + XP |
| `deadline_burst` | burst | many submissions in a 60s window |
| `extraction` | tiny | bounded Gemini concurrency (expect 503s above the cap) |

Every run should record: `http_req_duration` p50/p95/p99 per scenario, `http_reqs` rate,
`http_req_failed`, plus the backend's own evidence:
`[api:slow]` lines, `[exam-submission-timing]` lines (they carry per-phase ms and the
Supabase operation list), and Supabase's query stats.

## 4. Run order

1. **Baseline** on the current `main` deployment: 10 VUs for 5 minutes, mixed workload.
2. **Candidate** on this branch with the same VUs, durations and fixtures.
3. **Deadline burst**: 200 VUs submitting within one minute.
4. **Extraction burst**: 20 concurrent importers with a small source.

Compare like with like: same exam, same question count, same quota state, same region.

## 5. Reading the result

- `exam_start`/`submit` p95 should improve by roughly the reduced round-trip count, not by an
  arbitrary factor. If it does not, check the `supabase_operations` list in the submission timing
  log before concluding anything.
- A 429 rate is expected under burst beyond the configured per-user limits; record it, do not
  hide it.
- Watch for connection errors after a deploy: they indicate the graceful-shutdown drain is not
  working, not a performance problem.

See `exam-flow.js` for the script.
