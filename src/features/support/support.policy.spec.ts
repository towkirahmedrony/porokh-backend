import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adminReplyStatus,
  canStudentReopen,
  canStudentReply,
  canTransitionStatus,
  studentReplyStatus,
} from './support.policy';

test('staff can move an open ticket to any working state', () => {
  for (const next of ['in_progress', 'awaiting_student', 'resolved', 'closed'] as const) {
    assert.equal(canTransitionStatus('open', next), true);
  }
});

test('an open ticket cannot move to itself', () => {
  assert.equal(canTransitionStatus('open', 'open'), false);
});

test('a closed ticket can only be reopened', () => {
  assert.equal(canTransitionStatus('closed', 'open'), true);
  assert.equal(canTransitionStatus('closed', 'in_progress'), false);
  assert.equal(canTransitionStatus('closed', 'resolved'), false);
  assert.equal(canTransitionStatus('closed', 'awaiting_student'), false);
});

test('a resolved ticket can be reopened or closed but not left awaiting', () => {
  assert.equal(canTransitionStatus('resolved', 'open'), true);
  assert.equal(canTransitionStatus('resolved', 'closed'), true);
  assert.equal(canTransitionStatus('resolved', 'in_progress'), false);
  assert.equal(canTransitionStatus('resolved', 'awaiting_student'), false);
});

test('students may reply to every status except closed', () => {
  assert.equal(canStudentReply('open'), true);
  assert.equal(canStudentReply('in_progress'), true);
  assert.equal(canStudentReply('awaiting_student'), true);
  assert.equal(canStudentReply('resolved'), true);
  assert.equal(canStudentReply('closed'), false);
});

test('only resolved tickets can be reopened explicitly', () => {
  assert.equal(canStudentReopen('resolved'), true);
  assert.equal(canStudentReopen('open'), false);
  assert.equal(canStudentReopen('closed'), false);
});

test('a student reply returns the ticket to the staff queue', () => {
  assert.equal(studentReplyStatus('open'), 'open');
  assert.equal(studentReplyStatus('in_progress'), 'in_progress');
  assert.equal(studentReplyStatus('awaiting_student'), 'open');
  assert.equal(studentReplyStatus('resolved'), 'open');
});

test('a staff reply always waits for the student', () => {
  assert.equal(adminReplyStatus('open'), 'awaiting_student');
  assert.equal(adminReplyStatus('in_progress'), 'awaiting_student');
  assert.equal(adminReplyStatus('awaiting_student'), 'awaiting_student');
});

test('a staff reply on a resolved or closed ticket resumes work', () => {
  assert.equal(adminReplyStatus('resolved'), 'in_progress');
  assert.equal(adminReplyStatus('closed'), 'in_progress');
});
