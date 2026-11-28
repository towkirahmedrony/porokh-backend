import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApkValidationError,
  assertValidApk,
  parseApkUploadMetadata,
  readZipEntryNames,
  sanitizeApkFileName,
} from './releases.validation';
import { APK_MAX_BYTES } from './releases.constants';

/**
 * Unit tests for the upload validator.
 *
 * The fixtures are real (minimal) ZIP archives: local headers, a central
 * directory and an end-of-central-directory record. That is what makes these
 * tests meaningful — the validator is exercised against the same structure an
 * APK has, not a stand-in string.
 */

interface ZipEntry {
  name: string;
  data?: Buffer;
}

const buildZip = (entries: ZipEntry[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data ?? Buffer.from('x');

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 14); // crc (not checked by the validator)
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);

    locals.push(local, data);
    centrals.push(central);
    localOffset += local.length + data.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...locals, directory, eocd]);
};

const validApk = () =>
  buildZip([
    { name: 'AndroidManifest.xml', data: Buffer.from('binary-xml') },
    { name: 'classes.dex', data: Buffer.from('dex\n035') },
    { name: 'resources.arsc', data: Buffer.from('arsc') },
  ]);

test('reads the entry names of a ZIP archive', () => {
  const names = readZipEntryNames(validApk());
  assert.deepEqual(names, ['AndroidManifest.xml', 'classes.dex', 'resources.arsc']);
});

test('accepts an APK containing the manifest and dex', () => {
  const file = validApk();
  assert.equal(assertValidApk(file), file);
});

test('rejects a ZIP that is not an Android package', () => {
  const zip = buildZip([{ name: 'notes.txt' }, { name: 'android/AndroidManifest.xml' }]);
  assert.throws(() => assertValidApk(zip), (error: unknown) => {
    assert.ok(error instanceof ApkValidationError);
    assert.equal(error.status, 400);
    assert.match(error.message, /not a valid Android APK/);
    return true;
  });
});

test('rejects a file that is not a ZIP at all', () => {
  assert.throws(
    () => assertValidApk(Buffer.from('<!doctype html><title>Not found</title>')),
    /not an Android APK/
  );
});

test('rejects an empty upload', () => {
  assert.throws(() => assertValidApk(Buffer.alloc(0)), /No APK file was uploaded/);
  assert.throws(() => assertValidApk(undefined), /No APK file was uploaded/);
});

test('rejects an APK above the size limit', () => {
  const file = validApk();
  assert.throws(
    () => assertValidApk(file, file.length - 1),
    (error: unknown) => {
      assert.ok(error instanceof ApkValidationError);
      assert.equal(error.status, 413);
      return true;
    }
  );
  // The production ceiling itself is 100 MiB.
  assert.equal(APK_MAX_BYTES, 100 * 1024 * 1024);
});

test('parses valid upload metadata from query strings', () => {
  const parsed = parseApkUploadMetadata({
    version_name: '1.0.5',
    version_code: '10005',
    filename: 'Porokh-release.apk',
  });

  assert.deepEqual(parsed, {
    versionName: '1.0.5',
    versionCode: 10005,
    originalFilename: 'Porokh-release.apk',
  });
});

test('rejects metadata with a bad version name, code or extension', () => {
  assert.throws(
    () =>
      parseApkUploadMetadata({
        version_name: 'latest',
        version_code: '1',
        filename: 'Porokh.apk',
      }),
    /version_name must look like/
  );

  assert.throws(
    () =>
      parseApkUploadMetadata({
        version_name: '1.0.5',
        version_code: '0',
        filename: 'Porokh.apk',
      }),
    /version_code must be positive/
  );

  assert.throws(
    () =>
      parseApkUploadMetadata({
        version_name: '1.0.5',
        version_code: '1',
        filename: 'Porokh.zip',
      }),
    /must end with \.apk/
  );
});

test('rejects unknown metadata fields instead of ignoring them', () => {
  assert.throws(
    () =>
      parseApkUploadMetadata({
        version_name: '1.0.5',
        version_code: '1',
        filename: 'Porokh.apk',
        storage_path: 'releases/evil.apk',
      }),
    ApkValidationError
  );
});

test('strips path separators from the display filename', () => {
  assert.equal(sanitizeApkFileName('../../etc/Porokh.apk'), 'Porokh.apk');
  assert.equal(sanitizeApkFileName('C:\\builds\\Porokh 1.0.5.apk'), 'Porokh 1.0.5.apk');
  assert.equal(parseApkUploadMetadata({
    version_name: '1.0.5',
    version_code: '1',
    filename: '../Porokh.apk',
  }).originalFilename, 'Porokh.apk');
});
