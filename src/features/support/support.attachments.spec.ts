import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ATTACHMENTS,
  parseSupportAttachment,
  parseSupportAttachments,
  uploadSupportAttachments,
} from './support.attachments';
import { SupportValidationError } from './support.errors';
import { SupportAttachmentInput } from './support.validation';

// 1x1 transparent PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const png = (name = 'proof.png'): SupportAttachmentInput => ({
  file_name: name,
  mime_type: 'image/png',
  data_url: `data:image/png;base64,${PNG_BASE64}`,
});

test('accepts a valid image and reports its decoded size', () => {
  const parsed = parseSupportAttachment(png());

  assert.equal(parsed.mimeType, 'image/png');
  assert.equal(parsed.fileName, 'proof.png');
  assert.equal(parsed.size, Buffer.from(PNG_BASE64, 'base64').length);
});

test('rejects a data URL whose type does not match the declared type', () => {
  assert.throws(
    () =>
      parseSupportAttachment({
        ...png(),
        mime_type: 'image/jpeg',
      }),
    SupportValidationError
  );
});

test('rejects non-image data URLs', () => {
  assert.throws(
    () =>
      parseSupportAttachment({
        file_name: 'payload.svg',
        mime_type: 'image/png',
        data_url: 'data:image/svg+xml;base64,PHN2Zy8+',
      }),
    SupportValidationError
  );
});

test('rejects an empty payload', () => {
  assert.throws(
    () =>
      parseSupportAttachment({
        file_name: 'empty.png',
        mime_type: 'image/png',
        data_url: 'data:image/png;base64,',
      }),
    SupportValidationError
  );
});

test('rejects an image larger than the per-file cap', () => {
  const oversized = Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64');

  assert.throws(
    () =>
      parseSupportAttachment({
        file_name: 'large.png',
        mime_type: 'image/png',
        data_url: `data:image/png;base64,${oversized}`,
      }),
    SupportValidationError
  );
});

test('enforces the attachment count', () => {
  const files = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => png(`${index}.png`));
  assert.throws(() => parseSupportAttachments(files), SupportValidationError);
});

test('accepts up to the limit and returns nothing for an empty list', () => {
  const files = Array.from({ length: MAX_ATTACHMENTS }, (_, index) => png(`${index}.png`));
  assert.equal(parseSupportAttachments(files).length, MAX_ATTACHMENTS);
  assert.deepEqual(parseSupportAttachments([]), []);
});

test('uploading nothing never touches Cloudinary', async () => {
  assert.deepEqual(await uploadSupportAttachments([], 'user-1'), []);
});
