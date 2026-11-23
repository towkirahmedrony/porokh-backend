# Notification System End-to-End — Implementation Plan

**Goal:** Make every notification event produce a correct in-app row and a policy-compliant push, with delivery that does not depend on a sleeping Render instance.

**Architecture:** Postgres owns the rules and the schedule. `pg_cron` calls SECURITY DEFINER planner functions that only INSERT pending rows (idempotent by `dedupe_key`); DB triggers create event notifications at the moment the row changes. `can_send_push()` is the single policy gate. The backend becomes a thin dispatcher: claim a row, ask the DB whether a push is allowed, send with FCM, write `notification_push_log`, release or retry.

**Tech stack:** Postgres 15 (Supabase), pg_cron, Express/TypeScript, firebase-admin, React + Capacitor.

**Spec:** user brief, 2026-11-23 (sections 3–7).

## Global constraints

- Money/security events never depend on user preferences.
- All day/window math uses `Asia/Dhaka`; `notifications.created_at` is UTC.
- Max 2 pushes per user per Dhaka day, min 3 hours apart.
- Quiet hours 23:00–07:00 Dhaka: row is created, push is deferred to 07:00 or dropped if `expires_at` is earlier.
- `dedupe_key` is the idempotency key; every event defines one.
- Never log FCM tokens, service-account JSON, or notification bodies.
- Do not push to `main`; migrations only through `apply_migration`.

## Task list

### Task 1 — Preferences, push log, device uniqueness
Files: `supabase/migrations/20261123120000_notification_preferences_push_log.sql`
- `notification_preferences` (PK user_id, seven toggles, quiet window, timezone, updated_at).
- Seed a row for every existing profile, importing `profiles.settings.notification_preferences` when present.
- RLS: select/update own row only; insert own row; service_role full. Security category has no column.
- `notification_push_log` + `(user_id, created_at desc)` and `(notification_id)` indexes.
- Unique `(user_id, device_id)` on `user_devices` (dedupe existing rows first).

### Task 2 — Policy engine and user RPCs
Files: `supabase/migrations/20261123123000_notification_policy_rpc.sql`
- `notification_local_now(user, at)` → Dhaka wall clock.
- `can_send_push(user, event, at)` → `(allowed, reason, retry_after, priority)`.
  Order: security bypass → category preference → push_enabled → quiet hours → daily cap (log-derived) → 3-hour gap.
- `create_notification(user, event, vars, dedupe_key, scheduled_at, expires_at, channel)` renders `notification_templates`, defaults channel by event, inserts `ON CONFLICT (dedupe_key) DO NOTHING`, status `sent`.
- `mark_notification_read`, `mark_notification_clicked`, `mark_all_read`, `get_my_notifications(limit, before, before_id)`.
- Execute only for `service_role` on create; `authenticated` on the user RPCs; `search_path = ''` everywhere.

### Task 3 — Counters and admin stats
Files: `supabase/migrations/20261123124500_notification_counters.sql`
- `notification_delivery_stats` view (`security_invoker`): reads, clicks, accepted, failed per notification.
- Backfill `notifications.total_clicks` / `total_sent` from reads and push log.
- `notification_admin_stats` recomputed from the view + `event_code`.
- `mark_notification_clicked` keeps `total_clicks` derived, not incremented.

### Task 4 — Template links
Files: `supabase/migrations/20261123125000_notification_template_links.sql`
- exam_live_1h → `/exams/model`, exam_live_10m → `/exams/model`, exam_result → `/history`,
  streak_warning → `/dashboard`, reward_earned/level_up → `/profile`,
  exam_challenge_invite → `/exams/board`, referral_bonus → `/profile`.
- Rewrite existing `notifications.action_link` for the same old routes.

### Task 5 — Schedulers (pg_cron)
Files: `supabase/migrations/20261123130000_notification_schedulers.sql`
- `notification_plan_exam_reminders()` — 1h and 10m, published, future start, dedupe per exam+user.
- `notification_plan_exam_results()` — `result_publish_time` in the last 30 minutes, attempted users.
- `notification_plan_streak_warnings()` — 20:30–21:00 Dhaka, active streak, no activity today.
- `notification_plan_premium_expiry()` — 3 days and 1 day before `user_subscriptions.end_date`.
- `notification_plan_inactivity()` — 3 days idle, then at most weekly, stop after 3 unanswered.
- cron: every minute for reminders/streak/inactivity, every 5 minutes for results/expiry.

### Task 6 — Event triggers
Files: `supabase/migrations/20261123133000_notification_event_triggers.sql`
- pvp challenge created / completed, squad join approved, group chat message, premium purchase,
  premium grant, referral coin, level change.
- Each trigger calls `create_notification` and swallows nothing: one failing event must not roll back
  the business transaction, so triggers use an exception block that only logs.

### Task 7 — Dispatcher
Files: `porokh-backend/src/features/notifications/notifications.dispatcher.ts` (+ spec)
- Claim due rows (`status=sent`, push channel, `push_sent_at is null`, attempts < 3, `next_attempt_at` due).
- Call `can_send_push`; on deny write `push_next_attempt_at` (defer) or mark skipped.
- Send via existing `sendPushToDevices`, write one `notification_push_log` row per device,
  update `push_sent_at`, `provider_accepted_at`, `fcm_message_id`, counts, `push_attempts`, `push_error`.
- Backoff 1m/5m/15m on transient failure; invalid tokens removed by the existing sender.
- Also drain admin campaigns (moved out of `node-cron`).

### Task 8 — Routes
Files: `notifications.routes.ts`, `notifications.user.controller.ts`, new `notifications.internal.routes.ts`
- `GET /notifications` (cursor), `POST /:id/read`, `POST /:id/click`, `POST /read-all`,
  `GET|PUT /preferences`, `POST /devices`, `DELETE /devices/:deviceId`.
- `POST /internal/notifications/dispatch` behind `x-internal-secret` (`INTERNAL_CRON_SECRET`), rate limited.
- `node-cron` only as a best-effort backstop.

### Task 9 — Frontend
Files: `src/features/notifications/**`, `src/features/auth/components/LoginForm.tsx`,
`android/app/src/main/java/net/porokh/app/MainActivity.java`
- One device-registration path (`/notifications/devices`), token included on login, resume, refresh.
- Channels `exam`, `security`, `general`, `social` created on start; backend sends those ids.
- First-login explanation before the Android permission dialog; denial leaves in-app working.
- Foreground toast, background and cold-start tap → router + `/click`.
- Bell badge, centre list (Today/Earlier, unread, mark-all, skeleton, pagination) — extend the existing page.
- Settings toggles on `notification_preferences`, security always-on note.

### Task 10 — Admin + docs + verification
- Event-code stats endpoint for the existing dashboard; every action audited.
- `NOTIFICATIONS.md` in each repo.
- `tsc --noEmit`, backend tests, frontend tests, `npm run build`, Supabase advisors.

## Review focus

- A push arriving at 23:00:01 Dhaka must not vibrate the phone.
- A retry after a Render cold start must not double-send (claim CAS).
- A user with two devices must consume one daily slot, not two.
- A denied permission must not hide the in-app row.
- A failing notification trigger must never roll back a payment or an exam submission.
