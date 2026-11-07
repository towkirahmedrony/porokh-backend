import { v2 as cloudinary } from 'cloudinary';
import { SupportAttachmentError, SupportValidationError } from './support.errors';
import { SupportAttachmentInput } from './support.validation';
import { SupportAttachment } from './support.types';

export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 6 * 1024 * 1024;

const DATA_URL_PATTERN = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export interface ParsedSupportAttachment {
  fileName: string;
  mimeType: string;
  base64: string;
  size: number;
}

let configured = false;

const configureCloudinary = (): void => {
  if (configured) return;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  configured = true;
};

const isCloudinaryConfigured = (): boolean =>
  Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  );

/**
 * Validates one image attachment before anything is written.
 *
 * Only JPEG, PNG and WebP are accepted. The declared MIME type must match the
 * data URL, and the decoded size is capped independently of the JSON body
 * limit so a padded payload cannot slip through.
 */
export const parseSupportAttachment = (
  input: SupportAttachmentInput
): ParsedSupportAttachment => {
  const match = DATA_URL_PATTERN.exec(input.data_url.trim());
  if (!match) {
    throw new SupportValidationError('Attachment must be a JPEG, PNG or WebP image');
  }

  const mimeType = match[1];
  const base64 = match[2];

  if (mimeType !== input.mime_type) {
    throw new SupportValidationError('Attachment type does not match the file');
  }

  const size = Buffer.from(base64, 'base64').length;
  if (size === 0) {
    throw new SupportValidationError('Attachment is empty');
  }
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new SupportValidationError('Each attachment must be 2 MB or smaller');
  }

  return {
    fileName: input.file_name,
    mimeType,
    base64,
    size,
  };
};

export const parseSupportAttachments = (
  inputs: SupportAttachmentInput[]
): ParsedSupportAttachment[] => {
  if (inputs.length > MAX_ATTACHMENTS) {
    throw new SupportValidationError(`At most ${MAX_ATTACHMENTS} attachments are allowed`);
  }

  const parsed = inputs.map(parseSupportAttachment);
  const total = parsed.reduce((sum, attachment) => sum + attachment.size, 0);

  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new SupportValidationError('Attachments must total 6 MB or less');
  }

  return parsed;
};

/**
 * Uploads validated images to the project Cloudinary account. Students never
 * receive an upload signature, and no client-supplied URL is stored.
 */
export const uploadSupportAttachments = async (
  attachments: ParsedSupportAttachment[],
  userId: string
): Promise<SupportAttachment[]> => {
  if (attachments.length === 0) return [];

  if (!isCloudinaryConfigured()) {
    throw new SupportAttachmentError('Attachment upload is not configured');
  }

  configureCloudinary();

  const uploaded: SupportAttachment[] = [];

  for (const attachment of attachments) {
    try {
      const result = await cloudinary.uploader.upload(
        `data:${attachment.mimeType};base64,${attachment.base64}`,
        {
          folder: `porokh_support/${userId}`,
          resource_type: 'image',
          allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
        }
      );

      uploaded.push({
        url: result.secure_url,
        name: attachment.fileName,
        mime_type: attachment.mimeType,
        size: attachment.size,
      });
    } catch {
      console.error('[support] attachment upload failed');
      throw new SupportAttachmentError('Attachment upload failed', 502);
    }
  }

  return uploaded;
};
