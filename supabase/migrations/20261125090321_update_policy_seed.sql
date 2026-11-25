-- Seed the client update policy with the actually released build values.
--
-- Before this row existed, the admin Version Management page had nothing to
-- read: every field rendered as an input placeholder and the summary card said
-- "Unknown". The released APK is 1.0.5 (android/app/build.gradle versionName),
-- which matches package.json and the deployed /version.json. Nothing is
-- enforced here; an admin still has to switch enforcement on.
--
-- `latest_ota_version` stays empty on purpose: the signed OTA pointer is the
-- authoritative source and the admin page reads it from there.

insert into public.app_configs (key, value)
select
  'update_policy',
  jsonb_build_object(
    'schema', 1,
    'enforce_apk_update', false,
    'min_native_version', '1.0.0',
    'latest_native_version', '1.0.5',
    'apk_download_url', 'https://porokhbd.vercel.app/downloads/porokh.apk',
    'enforce_ota_update', false,
    'min_ota_version', '1.0.0',
    'latest_ota_version', '',
    'optional_update_enabled', false,
    'optional_update_title', '',
    'optional_update_description', '',
    'mandatory_update_title', '',
    'mandatory_update_description', '',
    'rollout_percentage', 100
  )
where not exists (
  select 1 from public.app_configs where key = 'update_policy'
);
