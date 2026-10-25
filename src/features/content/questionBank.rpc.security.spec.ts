import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Static security guard for the student question bank RPCs.
 *
 * The behaviour of the SQL is verified against a real Postgres engine before
 * deployment; these assertions only protect the properties that are easy to
 * lose in a later edit (privileges, security definer, redaction, answer-key
 * suppression) and that no unit test can otherwise observe from TypeScript.
 */

const MIGRATION_DIR = join(process.cwd(), 'supabase', 'migrations');
const V1_FILE = join(MIGRATION_DIR, '20261022090200_student_question_bank_rpc.sql');
const V2_FILE = join(MIGRATION_DIR, '20261025090000_student_question_bank_rpc_v2.sql');
const V2_SIGNATURE =
  'text, text, text, text, text, boolean, boolean, boolean, text, text, text, integer, integer';

const read = (file: string) => readFileSync(file, 'utf8').toLowerCase();

test('both student question bank RPC migrations are present', () => {
  assert.equal(existsSync(V1_FILE), true);
  assert.equal(existsSync(V2_FILE), true);
});

test('v2 is security definer with a pinned empty search_path', () => {
  const sql = read(V2_FILE);

  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = ''/);
  // Fully qualified access is required because search_path is empty.
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /public\.get_user_access\(/);
  assert.match(sql, /from public\.questions/);
});

test('v2 is executable by authenticated callers only', () => {
  const sql = read(V2_FILE);
  const signature = V2_SIGNATURE.replace(/\s+/g, ' ');

  assert.ok(
    sql.includes(`revoke all on function public.get_student_question_bank_v2(\n  ${signature}\n) from public, anon`),
    'execute must be revoked from public and anon'
  );
  assert.ok(
    sql.includes(`grant execute on function public.get_student_question_bank_v2(\n  ${signature}\n) to authenticated`),
    'execute must be granted to authenticated only'
  );
  assert.equal(/grant execute[\s\S]{0,200}\bto anon\b/.test(sql), false);
});

test('v2 keeps premium redaction and never emits answer keys', () => {
  const sql = read(V2_FILE);

  assert.match(sql, /when r\.locked then '\{\}'::jsonb/, 'locked rows return an empty body');
  assert.match(sql, /when r\.locked or jsonb_typeof\(r\.options\) <> 'array' then '\[\]'::jsonb/);
  assert.match(sql, /'explanation', case when r\.locked then null/);
  assert.equal(sql.includes('is_correct'), false, 'answer-key columns must not be selected');
  assert.equal(sql.includes('correct_option'), false);
});

test('v2 excludes questions that belong to a live exam paper', () => {
  const sql = read(V2_FILE);

  assert.match(sql, /and not exists \(/);
  assert.match(sql, /from public\.exam_paper_questions epq/);
  assert.match(sql, /ep\.end_time is null or ep\.end_time > now\(\)/);
});

test('v2 requires an authenticated identity', () => {
  const sql = read(V2_FILE);

  assert.match(sql, /if v_uid is null then\s+raise exception 'authentication required'/);
});

test('v2 clamps page size and paginates deterministically', () => {
  const sql = read(V2_FILE);

  assert.match(sql, /least\(greatest\(coalesce\(p_limit, 20\), 1\), 50\)/);
  assert.match(sql, /limit v_limit\s+offset v_offset/);
  assert.match(sql, /q\.id asc/, 'id must break ties so pages cannot overlap');
  assert.match(sql, /count\(\*\) over \(\) as total_count/);
});

test('v2 is additive: the v1 function definition is left untouched', () => {
  const sql = read(V2_FILE);

  assert.equal(
    sql.includes('create or replace function public.get_student_question_bank('),
    false,
    'v2 must not redefine the v1 signature'
  );
  assert.equal(sql.includes('drop function'), false);
});
