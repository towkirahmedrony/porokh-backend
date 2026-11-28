import { z } from 'zod';
import {
  APK_MAX_BYTES,
  REQUIRED_APK_ENTRIES,
} from './releases.constants';

/**
 * Upload validation for the Android APK.
 *
 * Nothing here trusts the browser: the extension, the declared version and the
 * bytes themselves are checked independently. The file is accepted only when it
 * is a real ZIP archive (an APK is one) that contains the entries Android needs,
 * so a renamed archive, an HTML error page or an empty upload is rejected.
 *
 * The original filename is never used as a storage path. It is only kept as
 * display metadata, which is why it is sanitised rather than rejected for
 * characters that a phone picker may legitimately produce.
 */

export class ApkValidationError extends Error {
  status: number;
  errorCode = 'VALIDATION_FAILED';
  exposeMessage = true;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ApkValidationError';
    this.status = status;
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const EOCD_MAX_COMMENT_BYTES = 0xffff;

/**
 * Reads the file names from a ZIP central directory.
 *
 * Returns null when the buffer is not a readable ZIP. Only names are returned;
 * entries are never extracted, so no path from the archive is ever written to
 * disk.
 */
export const readZipEntryNames = (buffer: Buffer): string[] | null => {
  if (!Buffer.isBuffer(buffer) || buffer.length < EOCD_MIN_BYTES) return null;

  // The end-of-central-directory record sits within the last 64 KiB because it
  // is followed by an archive comment of at most 65535 bytes.
  const minOffset = Math.max(0, buffer.length - (EOCD_MIN_BYTES + EOCD_MAX_COMMENT_BYTES));
  let eocdOffset = -1;

  for (let offset = buffer.length - EOCD_MIN_BYTES; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocdOffset = offset;
      break;
    }
  }

  if (eocdOffset < 0) return null;

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const directoryOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (directoryOffset >= buffer.length) return null;

  const names: string[] = [];
  let cursor = directoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length) return null;
    if (buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) return null;

    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;

    if (nameStart + nameLength > buffer.length) return null;

    names.push(buffer.toString('utf8', nameStart, nameStart + nameLength));
    cursor = nameStart + nameLength + extraLength + commentLength;
  }

  return names;
};

export const isZipArchive = (buffer: Buffer): boolean =>
  Buffer.isBuffer(buffer) &&
  buffer.length >= 4 &&
  buffer.readUInt32LE(0) === LOCAL_HEADER_SIGNATURE;

/**
 * Throws an ApkValidationError unless the buffer is an installable APK.
 */
export const assertValidApk = (
  file: unknown,
  maxBytes: number = APK_MAX_BYTES
): Buffer => {
  if (!Buffer.isBuffer(file) || file.length === 0) {
    throw new ApkValidationError('No APK file was uploaded');
  }

  if (file.length > maxBytes) {
    throw new ApkValidationError(
      `The APK is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`,
      413
    );
  }

  if (!isZipArchive(file)) {
    throw new ApkValidationError('The uploaded file is not an Android APK');
  }

  const names = readZipEntryNames(file);

  if (!names) {
    throw new ApkValidationError('The uploaded file is not a readable APK archive');
  }

  const missing = REQUIRED_APK_ENTRIES.filter((entry) => !names.includes(entry));

  if (missing.length > 0) {
    throw new ApkValidationError(
      `The uploaded file is not a valid Android APK (missing ${missing.join(', ')})`
    );
  }

  return file;
};

const VERSION_NAME = /^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/**
 * A phone picker may hand over a name with spaces or Bangla characters; those
 * are fine to display. Only path separators and control characters are dropped,
 * and the name is always re-derived on the server.
 */
export const sanitizeApkFileName = (value: string): string => {
  const base = value.split(/[\\/]/).pop() || '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.slice(0, 200);
};

export const apkUploadMetadataSchema = z
  .object({
    version_name: z
      .string()
      .trim()
      .min(1, 'version_name is required')
      .max(40)
      .regex(VERSION_NAME, 'version_name must look like 1.2.3'),
    version_code: z.coerce
      .number()
      .int('version_code must be an integer')
      .min(1, 'version_code must be positive')
      .max(2_100_000_000, 'version_code is out of range'),
    filename: z
      .string()
      .trim()
      .min(1, 'filename is required')
      .max(260)
      .refine((value) => /\.apk$/i.test(value), 'filename must end with .apk'),
  })
  .strict();

export type ApkUploadMetadata = {
  versionName: string;
  versionCode: number;
  originalFilename: string;
};

export const parseApkUploadMetadata = (input: unknown): ApkUploadMetadata => {
  const result = apkUploadMetadataSchema.safeParse(input);

  if (!result.success) {
    throw new ApkValidationError(
      result.error.issues[0]?.message || 'Invalid APK upload metadata'
    );
  }

  const originalFilename = sanitizeApkFileName(result.data.filename);

  if (!/\.apk$/i.test(originalFilename)) {
    throw new ApkValidationError('filename must end with .apk');
  }

  return {
    versionName: result.data.version_name,
    versionCode: result.data.version_code,
    originalFilename,
  };
};
