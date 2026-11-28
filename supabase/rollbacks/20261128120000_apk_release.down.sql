-- Roll back the APK distribution migration.
--
-- The bucket is only removed when it holds no objects, so a rollback can never
-- silently delete a published APK.

drop table if exists public.apk_release;

drop policy if exists "porokh-apk public read" on storage.objects;

delete from storage.buckets b
where b.id = 'porokh-apk'
  and not exists (
    select 1 from storage.objects o where o.bucket_id = 'porokh-apk'
  );
