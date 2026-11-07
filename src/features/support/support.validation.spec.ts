import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCreateSupportTicket,
  parseSupportAdminListQuery,
  parseSupportAssignment,
  parseSupportListQuery,
  parseSupportReply,
  parseSupportStatusUpdate,
} from './support.validation';
import { SupportValidationError } from './support.errors';

const validCreate = {
  category: 'exam',
  subject: '  Question has no correct answer  ',
  description: '  Option B looks wrong for this question.  ',
};

test('create trims text and normalizes optional context', () => {
  const parsed = parseCreateSupportTicket({
    ...validCreate,
    context: { question_id: ' q-1 ', exam_id: '   ', screen: '/exam/arena' },
  });

  assert.equal(parsed.subject, 'Question has no correct answer');
  assert.equal(parsed.description, 'Option B looks wrong for this question.');
  assert.equal(parsed.contextQuestionId, 'q-1');
  assert.equal(parsed.contextExamId, null);
  assert.equal(parsed.contextScreen, '/exam/arena');
  assert.deepEqual(parsed.attachments, []);
});

test('create rejects an unknown category', () => {
  assert.throws(
    () => parseCreateSupportTicket({ ...validCreate, category: 'billing' }),
    SupportValidationError
  );
});

test('create rejects a subject that is too short', () => {
  assert.throws(
    () => parseCreateSupportTicket({ ...validCreate, subject: 'help' }),
    SupportValidationError
  );
});

test('create rejects more than three attachments', () => {
  const attachment = {
    file_name: 'proof.png',
    mime_type: 'image/png',
    data_url: `data:image/png;base64,${'A'.repeat(40)}`,
  };

  assert.throws(
    () =>
      parseCreateSupportTicket({
        ...validCreate,
        attachments: [attachment, attachment, attachment, attachment],
      }),
    SupportValidationError
  );
});

test('create rejects a non-image attachment type', () => {
  assert.throws(
    () =>
      parseCreateSupportTicket({
        ...validCreate,
        attachments: [
          {
            file_name: 'payload.pdf',
            mime_type: 'application/pdf',
            data_url: `data:application/pdf;base64,${'A'.repeat(40)}`,
          },
        ],
      }),
    SupportValidationError
  );
});

test('list applies defaults and accepts filters', () => {
  const defaults = parseSupportListQuery({});
  assert.equal(defaults.limit, 20);
  assert.equal(defaults.offset, 0);

  const filtered = parseSupportListQuery({
    limit: '10',
    offset: '20',
    status: 'awaiting_student',
    category: 'bug',
    search: 'PRK-0001',
  });

  assert.equal(filtered.limit, 10);
  assert.equal(filtered.offset, 20);
  assert.equal(filtered.status, 'awaiting_student');
  assert.equal(filtered.category, 'bug');
  assert.equal(filtered.search, 'PRK-0001');
});

test('list rejects search text that could inject a filter term', () => {
  assert.throws(
    () => parseSupportListQuery({ search: 'abc,status.eq.closed' }),
    SupportValidationError
  );
  assert.throws(
    () => parseSupportListQuery({ search: 'abc%' }),
    SupportValidationError
  );
});

test('admin list maps assigned=me to the viewer', () => {
  const parsed = parseSupportAdminListQuery(
    { assigned: 'me', sort: 'created', direction: 'asc' },
    '11111111-1111-4111-8111-111111111111'
  );

  assert.equal(parsed.assignedTo, '11111111-1111-4111-8111-111111111111');
  assert.equal(parsed.sort, 'created');
  assert.equal(parsed.direction, 'asc');
});

test('admin list keeps unassigned and rejects malformed dates', () => {
  assert.equal(parseSupportAdminListQuery({ assigned: 'unassigned' }, 'x').assignedTo, 'unassigned');
  assert.throws(
    () => parseSupportAdminListQuery({ date_from: '2026-13-01' }, 'x'),
    SupportValidationError
  );
});

test('reply is trimmed and must not be empty', () => {
  assert.equal(parseSupportReply({ body: '  Thanks  ' }), 'Thanks');
  assert.throws(() => parseSupportReply({ body: '   ' }), SupportValidationError);
});

test('status and assignment updates are validated', () => {
  assert.equal(parseSupportStatusUpdate({ status: 'resolved' }), 'resolved');
  assert.throws(() => parseSupportStatusUpdate({ status: 'done' }), SupportValidationError);

  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(parseSupportAssignment({ assigned_to: id }), id);
  assert.equal(parseSupportAssignment({ assigned_to: null }), null);
  assert.throws(() => parseSupportAssignment({ assigned_to: 'someone' }), SupportValidationError);
});
