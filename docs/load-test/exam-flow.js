import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

/**
 * Staging load test for the exam lifecycle. Not run against production.
 *
 * One session per VU: the student signs in with Supabase, then starts an attempt,
 * fetches its questions, autosaves, and submits. Because a real exam can only be
 * taken once per account, the start/submit part of the exam flow is exercised by
 * the `deadline_burst` scenario against fresh accounts; the mixed scenario also
 * covers the read-heavy paths, which are safe to repeat.
 */

const startLatency = new Trend('exam_start_ms');
const submitLatency = new Trend('exam_submit_ms');
const rejected = new Rate('business_rejections');

const EMAIL = __ENV.STUDENT_EMAIL_1;
const PASSWORD = __ENV.STUDENT_PASSWORD_1;
const EXAM_ID = __ENV.EXAM_ID;

export const options = {
  scenarios: {
    mixed: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 10 },
        { duration: '3m', target: 10 },
        { duration: '1m', target: 0 },
      ],
      exec: 'mixedStudent',
    },
    deadline_burst: {
      executor: 'per-vu-iterations',
      vus: 200,
      iterations: 1,
      startTime: '6m',
      maxDuration: '3m',
      exec: 'submitOnce',
    },
  },
  thresholds: {
    // Deliberately loose: the point is to record the numbers, not to gate a build.
    http_req_failed: ['rate<0.05'],
  },
};

const jsonHeaders = (token) => ({
  'Content-Type': 'application/json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

function signIn() {
  const res = http.post(
    `${__ENV.SUPABASE_URL}/auth/v1/token?grant_type=password`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { apikey: __ENV.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' } }
  );

  check(res, { 'signed in': (r) => r.status === 200 });
  return res.json('access_token');
}

function startAttempt(token) {
  const res = http.post(
    `${__ENV.API_URL}/exams/user/attempts/start`,
    JSON.stringify({ exam_id: EXAM_ID }),
    { headers: jsonHeaders(token), tags: { name: 'exam_start' } }
  );

  startLatency.add(res.timings.duration);
  // 403 FREE_LIMIT_REACHED and 409 ALREADY_ATTEMPTED are valid business answers.
  rejected.add(res.status === 200 ? 0 : 1);

  return res.status === 200 ? res.json('data.id') : null;
}

export function mixedStudent() {
  const token = signIn();
  if (!token) return;

  http.get(`${__ENV.API_URL}/profiles/me`, {
    headers: jsonHeaders(token),
    tags: { name: 'profile_me' },
  });

  const attemptId = startAttempt(token);

  if (attemptId) {
    const questions = http.get(`${__ENV.API_URL}/exams/user/attempts/${attemptId}/questions`, {
      headers: jsonHeaders(token),
      tags: { name: 'exam_questions' },
    });

    const ids = (questions.json('data') || []).map((q) => q.id).slice(0, 5);
    for (const id of ids) {
      http.patch(
        `${__ENV.API_URL}/exams/user/attempts/${attemptId}/answers`,
        JSON.stringify({ answers: { [id]: 'a' }, current_question_index: 1 }),
        { headers: jsonHeaders(token), tags: { name: 'exam_autosave' } }
      );
      sleep(0.2);
    }
  }

  sleep(1);
}

export function submitOnce() {
  const token = signIn();
  if (!token) return;

  const attemptId = startAttempt(token);
  if (!attemptId) return;

  const res = http.post(
    `${__ENV.API_URL}/exams/user/submit`,
    JSON.stringify({ attempt_id: attemptId, answers: {} }),
    { headers: jsonHeaders(token), tags: { name: 'exam_submit' } }
  );

  submitLatency.add(res.timings.duration);
  check(res, { 'submit answered': (r) => r.status < 500 });
}
