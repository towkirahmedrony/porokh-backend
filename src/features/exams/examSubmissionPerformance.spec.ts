import assert from 'node:assert/strict';
import test from 'node:test';
import {
  measureSubmissionPhase,
  measureSupabaseOperation,
  resolveSubmissionRequestId,
  type SubmissionPerformanceTrace,
} from './examSubmissionPerformance';

const trace = (requestId: string): SubmissionPerformanceTrace => ({
  requestId,
  startedAt: 0,
  phases: {},
  supabaseOperations: [],
});

test('submission request IDs preserve safe incoming IDs and replace unsafe values', () => {
  const id = '9a0d5f4e-1111-4222-8333-444455556666';
  assert.equal(resolveSubmissionRequestId(id), id);
  assert.match(resolveSubmissionRequestId('bad\nforged'), /^[0-9a-f-]{36}$/i);
  assert.match(resolveSubmissionRequestId(undefined), /^[0-9a-f-]{36}$/i);
});

test('concurrent submission timings stay isolated by request-scoped trace', async () => {
  const first = trace('request-first-0001');
  const second = trace('request-second-0002');

  await Promise.all([
    measureSubmissionPhase(first, 'authentication', async () => {
      await new Promise((resolve) => setTimeout(resolve, 12));
      await measureSupabaseOperation(first, 'auth.get_user', async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return 'not retained';
      });
    }),
    measureSubmissionPhase(second, 'question_evaluation', async () => {
      await new Promise((resolve) => setTimeout(resolve, 6));
      await measureSupabaseOperation(second, 'questions.read', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return 'not retained';
      });
    }),
  ]);

  assert.ok(first.phases.authentication >= 10);
  assert.equal('question_evaluation' in first.phases, false);
  assert.ok(second.phases.question_evaluation >= 5);
  assert.equal('authentication' in second.phases, false);
  assert.deepEqual(first.supabaseOperations.map((item) => item.name), ['auth.get_user']);
  assert.deepEqual(second.supabaseOperations.map((item) => item.name), ['questions.read']);
  assert.equal(first.requestId, 'request-first-0001');
  assert.equal(second.requestId, 'request-second-0002');
});

test('trace data and log-safe fields do not retain secrets or answers', async () => {
  const current = trace('request-safe-0001');
  await measureSupabaseOperation(current, 'exam_history.insert', async () => ({
    password: 'must-not-be-recorded',
    answers: { q1: 'must-not-be-recorded' },
    access_token: 'must-not-be-recorded',
  }));

  const serializedTrace = JSON.stringify(current);
  assert.equal(serializedTrace.includes('must-not-be-recorded'), false);
  assert.equal(serializedTrace.includes('password'), false);
  assert.equal(serializedTrace.includes('answers'), false);
  assert.equal(serializedTrace.includes('access_token'), false);
  assert.deepEqual(current.supabaseOperations.map((item) => item.name), ['exam_history.insert']);
});
