import { createHash } from 'node:crypto';
import { supabaseAdmin } from '../../config/supabaseAdmin';
import {
  APK_BUCKET,
  APK_FILE_NAME,
  APK_MIME_TYPE,
  APK_OBJECT_PATH,
  publicApkUrl,
} from './releases.constants';

/**
 * APK release storage.
 *
 * The file lives at the canonical Storage path and the metadata row is the
 * single source of truth for "is an APK published". Publishing uploads first,
 * verifies what Storage actually holds, and only then writes the metadata, so a
 * failed upload leaves the previous release untouched and the public site still
 * pointing at a working file.
 */

export interface ApkReleaseRow {
  id: number;
  version_name: string;
  version_code: number;
  original_filename: string;
  file_size: number | string;
  sha256: string;
  released_at: string;
  updated_at: string;
  published_by: string | null;
}

export interface ApkReleaseView {
  available: true;
  versionName: string;
  versionCode: number;
  fileName: string;
  fileSize: number;
  releasedAt: string;
  updatedAt: string;
  sha256: string;
  storagePath: string;
  downloadUrl: string;
}

export class ReleaseUnavailableError extends Error {
  status = 503;
  exposeMessage = true;

  constructor(message = 'Release information is temporarily unavailable') {
    super(message);
    this.name = 'ReleaseUnavailableError';
  }
}

export class ReleaseStorageError extends Error {
  status = 502;
  exposeMessage = true;

  constructor(message: string) {
    super(message);
    this.name = 'ReleaseStorageError';
  }
}

export const toApkReleaseView = (row: ApkReleaseRow): ApkReleaseView => ({
  available: true,
  versionName: row.version_name,
  versionCode: row.version_code,
  fileName: row.original_filename,
  fileSize: Number(row.file_size),
  releasedAt: row.released_at,
  updatedAt: row.updated_at,
  sha256: row.sha256,
  storagePath: APK_OBJECT_PATH,
  downloadUrl: publicApkUrl(),
});

export const getCurrentRelease = async (): Promise<ApkReleaseView | null> => {
  const { data, error } = await supabaseAdmin
    .from('apk_release')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    // The error text may name internal columns; only the fact of the failure is
    // logged, and the client is told the dependency is unavailable.
    console.error('[releases] release metadata read failed');
    throw new ReleaseUnavailableError();
  }

  return data ? toApkReleaseView(data as ApkReleaseRow) : null;
};

export const sha256Of = (buffer: Buffer): string =>
  createHash('sha256').update(buffer).digest('hex');

/** Reads back the stored object so a publish can prove Storage has it. */
const verifyStoredObject = async (expectedBytes: number): Promise<void> => {
  const { data, error } = await supabaseAdmin.storage
    .from(APK_BUCKET)
    .list('releases/latest', { limit: 100, search: APK_FILE_NAME });

  if (error) {
    console.error('[releases] storage listing failed');
    throw new ReleaseStorageError('The uploaded APK could not be verified in storage');
  }

  const stored = (data ?? []).find((entry: { name?: string }) => entry.name === APK_FILE_NAME);
  const storedSize = Number(
    (stored as { metadata?: { size?: number } } | undefined)?.metadata?.size
  );

  if (!stored || !Number.isFinite(storedSize) || storedSize !== expectedBytes) {
    throw new ReleaseStorageError('The uploaded APK could not be verified in storage');
  }
};

export interface PublishApkInput {
  file: Buffer;
  versionName: string;
  versionCode: number;
  originalFilename: string;
  publishedBy: string | null;
}

export const publishApk = async (input: PublishApkInput): Promise<ApkReleaseView> => {
  const sha256 = sha256Of(input.file);

  // `upsert` replaces the canonical object atomically; the previous file stays
  // downloadable until this single request succeeds.
  const { error: uploadError } = await supabaseAdmin.storage
    .from(APK_BUCKET)
    .upload(APK_OBJECT_PATH, input.file, {
      contentType: APK_MIME_TYPE,
      upsert: true,
      // The canonical path is reused, so a long cache would serve the previous
      // build after a replacement.
      cacheControl: '0',
    });

  if (uploadError) {
    console.error('[releases] APK upload failed');
    throw new ReleaseStorageError('The APK could not be uploaded');
  }

  await verifyStoredObject(input.file.byteLength);

  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('apk_release')
    .upsert(
      {
        id: 1,
        version_name: input.versionName,
        version_code: input.versionCode,
        original_filename: input.originalFilename,
        file_size: input.file.byteLength,
        sha256,
        released_at: now,
        updated_at: now,
        published_by: input.publishedBy,
      },
      { onConflict: 'id' }
    )
    .select('*')
    .single();

  if (error || !data) {
    console.error('[releases] release metadata write failed');
    throw new ReleaseStorageError(
      'The APK was stored but its release metadata could not be saved. Retry the upload.'
    );
  }

  return toApkReleaseView(data as ApkReleaseRow);
};

/**
 * Removes the canonical object and then the metadata row.
 *
 * The object goes first: if Storage refuses, the release is still whole and the
 * caller receives an error. Once the object is gone, deleting the row makes the
 * public endpoint report no release, which is the state the website renders as
 * unavailable.
 */
export const deleteCurrentRelease = async (): Promise<boolean> => {
  const current = await getCurrentRelease();

  if (!current) return false;

  const { error: removeError } = await supabaseAdmin.storage
    .from(APK_BUCKET)
    .remove([APK_OBJECT_PATH]);

  if (removeError) {
    console.error('[releases] APK removal failed');
    throw new ReleaseStorageError('The stored APK could not be deleted');
  }

  const { error: dbError } = await supabaseAdmin
    .from('apk_release')
    .delete()
    .eq('id', 1);

  if (dbError) {
    console.error('[releases] release metadata delete failed');
    // The file is gone but the row remains. Report failure: the admin must see
    // that the release is not fully removed, and a retry clears the row.
    throw new ReleaseStorageError(
      'The APK file was removed but its release record could not be deleted. Retry the delete.'
    );
  }

  return true;
};
