# Notifications

Postgres owns the rules and the schedule. This service is the delivery loop.

```
DB event / pg_cron ──► notifications row (status=sent, push_sent_at=null)
                              │
                    dispatcher (30s or /internal/...)
                              │
                     can_send_push() ──► deny → defer / drop / skip
                              │ allow
                        FCM multicast ──► notification_push_log
```

## Why it is built this way

Render's free instance sleeps, so `node-cron` cannot be the schedule. pg_cron
planners insert idempotent rows (unique `dedupe_key`); the dispatcher only
delivers. A sleeping backend delays a push; it never loses an event.

## Event catalog

| event_code | source | channel | dedupe_key |
|---|---|---|---|
| exam_live_1h | pg_cron (`*/1`) | both | `exam_live_1h:{exam}:{user}` |
| exam_live_10m | pg_cron (`*/1`) | both | `exam_live_10m:{exam}:{user}` |
| exam_result | pg_cron (`*/5`) | both | `exam_result:{exam}:{user}` |
| streak_warning | pg_cron (`*/1`, 20:30–21:00 Dhaka) | both | `streak_warning:{user}:{date}` |
| premium_expiring | pg_cron (`*/5`) | both | `premium_expiring:{sub}:{days}` |
| inactivity_reminder | pg_cron (`*/5`) | both | `inactivity:{user}:{last_active}:{n}` |
| pvp_challenge | trigger `pvp_challenges` insert | both | `pvp_challenge:{id}:{user}` |
| pvp_result | trigger `pvp_challenges` status | in_app | `pvp_result:{id}:{user}` |
| squad_invite | trigger `group_members` insert invited | both | `squad_invite:{group}:{user}` |
| squad_join_approved | trigger `group_members` → active | in_app | `squad_joined:{group}:{user}` |
| community_reply | trigger `group_chats` insert | in_app | `community_reply:{group}:{user}:{hour}` |
| premium_purchased | trigger `user_subscriptions` insert | both | `premium_purchased:{sub}` |
| premium_granted | trigger `access_grants` insert | both | `premium_granted:{grant}` |
| referral_bonus | trigger `coin_transactions` (referral) | in_app | `referral_bonus:{txn}` |
| level_up | trigger `profiles.total_xp` | in_app | `level_up:{user}:{level}` |
| new_device_login | `saveUserDeviceToken` → `notify` | both | `new_device:{user}:{device}` |
| reward_earned | exam submit → `notifyXpAndProgression` | in_app | `reward:{...}` |
| leaderboard_top10 | `notifyXpAndProgression` | in_app | — |
| league_promotion / league_demotion | `notifyXpAndProgression` | in_app | `league:{user}:{level}` |
| quota_exhausted | access service when a quota rejects | in_app | `quota:{user}:{feature}:{date}` |
| exam_challenge_invite | no source table yet | — | not fired |

`exam_challenge_invite` has no backing table in the current schema, so it is
inactive. Nothing fires it; do not wire it to a guess.

## Policy (single implementation: `can_send_push`)

1. Security (`new_device_login`) bypasses quiet hours, the cap, the gap and all
   preferences.
2. `premium_granted` / `premium_purchased` bypass the cap and the gap.
3. Category toggles (`notification_preferences`) and `push_enabled` deny a push;
   the in-app row already exists.
4. Quiet hours are no longer a product rule. `can_send_push` still returns a
   `quiet_hours` denial and the `quiet_start` / `quiet_end` columns remain, but
   the dispatcher ignores that reason and always sends. Do not defer on it
   again unless the UI offers the window.
5. At most 2 accepted pushes per Asia/Dhaka day, counted from
   `notification_push_log` (distinct notifications, not devices).
6. At least 3 hours between two pushes.

All timestamps are stored with a timezone; `notifications.scheduled_at` and
`expires_at` are legacy `timestamp` columns interpreted as UTC.

## Dispatcher

`dispatchNotifications()` claims a row with a compare-and-set on `push_attempts`,
asks `can_send_push`, sends, then writes one `notification_push_log` row per
device. Retry schedule: 1m, 5m, 15m (max 3 attempts). `UNREGISTERED` /
`INVALID_ARGUMENT` tokens are nulled by the sender.

Entry points:
- in-process backstop every 30s (`src/jobs/notification.job.ts`)
- `POST /internal/notifications/dispatch` with header
  `x-internal-secret: $INTERNAL_CRON_SECRET` (or `x-cron-secret: $CRON_SECRET`),
  called by cron-job.org

Admin campaigns (`status=scheduled`, `target_user_id` null) are drained by the
same function, after per-user rows.

## Adding an event code

1. Insert a row into `notification_templates` (both languages, `action_link`).
2. Add the event to `notification_event_meta()` with its category, priority and
   default channel.
3. Create the notification:
   - DB event → trigger calling `public.create_notification(...)`, wrapped in an
     exception block so it can never roll back the business transaction.
   - time-based → a planner function + `cron.schedule`.
4. Add a preference category mapping in `can_send_push` if it is a new category.
5. Add the event to the table above and to the manual test script.

## Environment

| variable | purpose |
|---|---|
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | FCM service account (preferred) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | alternative single-JSON form |
| `INTERNAL_CRON_SECRET` | shared secret for the dispatch route; falls back to `CRON_SECRET` |

Never log tokens, the service account or notification bodies.

## Testing

- Policy: `psql "$DATABASE_URL" -f supabase/tests/notification_policy_test.sql`
  (runs in a transaction and rolls back).
- Manual in-app pass: `supabase/tests/notification_manual_test.sql`.
- Payload rules: `npm test` (the `notifications.*` specs).
- Delivery: curl the internal route with the header and inspect
  `notification_push_log` and `notifications.push_error`.

## Applied migrations (project pbswsbfcmztmbcqnuqny)

| version | name |
|---|---|
| 20261123170142 | notification_preferences_push_log |
| 20261123170259 | notification_policy_engine_rpc |
| 20261123170357 | notification_counters_from_reads |
| 20261123170429 | notification_template_links_and_inactivity |
| 20261123170650 | notification_schedulers_pg_cron |
| 20261123170758 | notification_event_triggers |
| 20261123171959 | notification_cap_counts_all_log_rows |
| 20261123172053 | notification_function_grants_hardening |
| 20261123174201 | notification_click_rpc_definer |

They were applied through the Supabase tooling, not from files in this repo.
Run `supabase db pull notification_system` once to snapshot them into
`supabase/migrations/` so a fresh environment can be rebuilt from the repo.

## Known limitations

- FCM does not report per-device delivery; `delivered_count` mirrors provider
  acceptance, not confirmed display.
- `community_reply` collapses per group per hour to avoid chat noise.
- The inactivity sequence stops after three unread reminders.
