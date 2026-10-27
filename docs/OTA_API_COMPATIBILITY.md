# OTA and API compatibility

Porokh's Android app receives its frontend through Capgo OTA bundles. This
service has **no OTA role**: it does not host bundles, manifests or signing keys,
and it must not grow that infrastructure. Publishing is done by
`.github/workflows/ota-release.yml` in the `porokh` repository against Capgo
Cloud.

What this service does control is whether a released bundle can keep working for
devices that have not updated yet.

## The compatibility problem

At any moment N frontend versions are live at once:

- the builtin frontend inside older APKs,
- the last confirmed OTA bundle,
- the newly staged bundle,
- (briefly) a bundle being rolled back.

OTA cannot force an update: a device may be offline, may be inside an exam, or
may have rejected the bundle. So **the previous frontend generation must keep
working against the current API.**

## Rules for backend changes

1. **Additive first.** Add a field, endpoint or optional parameter; deploy it;
   ship the frontend that uses it in a later bundle. Never remove or rename
   something the deployed frontend still sends or reads in the same change.
2. **Never repurpose a field.** Changing the meaning or type of
   `score`, `total_marks`, `status`, `practice_mode` or a submission response
   silently corrupts results on devices running an older bundle.
3. **Accept unknown inputs.** Additional JSON keys from a newer bundle must not
   be rejected (`zod` schemas should be non-strict for request bodies that may
   grow, strict only where security depends on it).
4. **Keep response shapes backward compatible for at least one OTA generation**
   — realistically two, because a bundle can be rejected and cooled down for
   24 hours before the device retries.
5. **Idempotency is a hard requirement.** Offline submissions retry with the
   same `attempt_id`; the attempt claim must return the existing result rather
   than grading twice. This already holds for
   `POST /exams/user/attempts/:id/submit`; keep it that way.
6. **Auth changes ship with a client that understands them.** A new required
   header or a changed token lifetime breaks every un-updated device at once.

## Database migrations

Migrations run here (Supabase, `supabase/migrations/`), not from a bundle.

- **Additive** (new table, nullable column, new index, new function): safe,
  deploy before the bundle that needs it.
- **Destructive** (drop column, rename, tighten a constraint): only after every
  supported frontend generation has stopped using the old shape, which in
  practice means after the next APK floor has been raised.
- **Backfills** must tolerate rows written by older clients.

If a change cannot be made backward compatible, it is a breaking change: ship
it behind a new endpoint or a version prefix and keep the old one until the
minimum supported APK version (see `porokh/ota.config.json`
`minNativeVersion`) guarantees nobody calls it.

## What a bundle cannot change

A bundle can ship routes, components, client-side logic and API-client changes.
It cannot ship native plugins, permissions, Android SDK changes, or a different
offline storage schema — the IndexedDB version is compiled into the bundle, and
raising it invalidates the data that older bundles and APKs can read. Those
changes require an APK, and the split is documented in
`porokh/docs/android-ota.md`.

## Checklist before a frontend release reaches users

- [ ] Every endpoint the new bundle calls already exists in production.
- [ ] No endpoint the currently deployed bundle calls has been removed or
      changed shape.
- [ ] New required fields are optional on the server, at least for one release.
- [ ] Migrations are additive, or the old code path is still served.
- [ ] Offline submission idempotency still returns the original result.
- [ ] `minNativeVersion` in `porokh/ota.config.json` still matches the oldest
      APK you intend to support.
