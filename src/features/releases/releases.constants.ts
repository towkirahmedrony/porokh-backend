/**
 * Canonical APK distribution constants.
 *
 * The object path is fixed: the backend, the GitHub Actions publisher and the
 * public URL all resolve the same key, so "latest" can never mean two files.
 * Clients never supply a path.
 */
export const APK_BUCKET = 'porokh-apk';
export const APK_OBJECT_PATH = 'releases/latest/Porokh.apk';
export const APK_FILE_NAME = 'Porokh.apk';
export const APK_MIME_TYPE = 'application/vnd.android.package-archive';
export const APK_MAX_BYTES = 100 * 1024 * 1024;

/** Entries every installable APK carries. */
export const REQUIRED_APK_ENTRIES = ['AndroidManifest.xml', 'classes.dex'] as const;

/** Public, anonymous-readable URL of the canonical object. */
export const publicApkUrl = (supabaseUrl = process.env.SUPABASE_URL): string => {
  const base = (supabaseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return `${base}/storage/v1/object/public/${APK_BUCKET}/${APK_OBJECT_PATH}`;
};
