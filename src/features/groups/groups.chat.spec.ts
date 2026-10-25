import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyMeta, containsBlockedContact } from './groups.chat';

test('links and phone numbers are blocked', () => {
  assert.equal(containsBlockedContact('visit example.com'), true);
  assert.equal(containsBlockedContact('https://x.test'), true);
  assert.equal(containsBlockedContact('call 01712345678'), true);
  assert.equal(containsBlockedContact('আজ পড়া শেষ'), false);
});

test('reply metadata is compact and safe', () => {
  const meta = buildReplyMeta({
    id: '00000000-0000-4000-8000-000000000001',
    senderName: '  Rahim  ',
    content: 'line one\nline two ' + 'x'.repeat(200),
  });

  assert.equal(meta.sender_name, 'Rahim');
  assert.equal(meta.snippet.startsWith('line one line two'), true);
  assert.equal(meta.snippet.length, 90);
  assert.equal(meta.id, '00000000-0000-4000-8000-000000000001');
});
