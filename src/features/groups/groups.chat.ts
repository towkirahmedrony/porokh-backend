const URL_PATTERN =
  /(https?:\/\/|www\.|t\.me\/|wa\.me\/|\b[a-z0-9-]+\.(?:com|net|org|bd|xyz|link|site|online|app)\b)/i;
const PHONE_PATTERN = /(?:\+?88)?0?1[3-9]\d{8}/;

export const containsBlockedContact = (content: string): boolean =>
  URL_PATTERN.test(content) || PHONE_PATTERN.test(content);

export const REPLY_SNIPPET_LENGTH = 90;

export const buildReplyMeta = (input: {
  id: string;
  senderName?: string | null;
  content: string;
}): { id: string; sender_name: string; snippet: string } => ({
  id: input.id,
  sender_name: String(input.senderName ?? '').trim().slice(0, 80) || 'Student',
  snippet: String(input.content ?? '').replace(/\s+/g, ' ').trim().slice(0, REPLY_SNIPPET_LENGTH),
});
