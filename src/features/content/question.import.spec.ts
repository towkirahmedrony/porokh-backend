import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assignResolvedExamReferences,
  importPlanCounts,
  normalizeImportQuestion,
  normalizeImportQuestions,
  planImportBatch,
  withContentHashes,
  ImportValidationError,
} from './question.import';

const baseQuestion = () => ({
  type: 'mcq',
  body: { text_bn: 'প্রশ্ন', text_en: 'Question', image_url: null },
  options: [
    { id: 9, text_bn: 'ক', text_en: 'A', isCorrect: false },
    { id: 3, text_bn: 'খ', text_en: 'B', isCorrect: true },
    { id: 7, text_bn: 'গ', text_en: 'C', isCorrect: false },
  ],
  explanation: { bn: 'ব্যাখ্যা', en: 'Explanation' },
  difficulty_level: 'medium',
  source_type: 'board_exam',
  exam_references: [
    { source_kind: 'board', board: 'Dhaka Board', year: '2024', eiin: '91000002' },
  ],
  tags: ['vector', ' vector ', 'hsc'],
  subject_id: 'sub_physics',
  chapter_id: 'chap_vectors',
  topic_id: 'top_dot',
});

test('normalize keeps the answer key and regenerates option ids from position', () => {
  const result = normalizeImportQuestion(baseQuestion(), 0, 'editor');

  assert.deepEqual(result.errors, []);
  const options = result.payload.options as Array<Record<string, unknown>>;
  assert.deepEqual(
    options.map((option) => ({ id: option.id, isCorrect: option.isCorrect })),
    [
      { id: 1, isCorrect: false },
      { id: 2, isCorrect: true },
      { id: 3, isCorrect: false },
    ]
  );
  assert.equal(result.payload.type, 'mcq');
  assert.equal((result.payload.body as Record<string, unknown>).text_bn, 'প্রশ্ন');
});

test('normalize trims and de-duplicates tags and supports comma separated input', () => {
  const result = normalizeImportQuestion({ ...baseQuestion(), tags: 'vector, dot ,vector' }, 0);

  assert.deepEqual(result.payload.tags, ['vector', 'dot']);
});

test('normalize rejects a question without a marked correct option', () => {
  const question = baseQuestion();
  question.options = question.options.map((option) => ({ ...option, isCorrect: false }));

  const result = normalizeImportQuestion(question, 0);

  assert.ok(result.errors.some((error) => error.includes('No correct option')));
});

test('normalize rejects multiple correct options', () => {
  const question = baseQuestion();
  question.options = question.options.map((option) => ({ ...option, isCorrect: true }));

  const result = normalizeImportQuestion(question, 0);

  assert.ok(result.errors.some((error) => error.includes('exactly one')));
});

test('normalize rejects missing bilingual question text and curriculum scope', () => {
  const result = normalizeImportQuestion(
    {
      ...baseQuestion(),
      body: { text_bn: '   ', text_en: '' },
      subject_id: '',
      chapter_id: '',
    },
    0
  );

  assert.ok(result.errors.some((error) => error.includes('body.text_bn')));
  assert.ok(result.errors.some((error) => error.includes('subject_id')));
  assert.ok(result.errors.some((error) => error.includes('chapter_id')));
  assert.ok(result.warnings.some((warning) => warning.includes('body.text_en')));
});

test('normalize rejects unsupported difficulty and source type values', () => {
  const result = normalizeImportQuestion(
    { ...baseQuestion(), difficulty_level: 'impossible', source_type: 'rumour' },
    0
  );

  assert.ok(result.errors.some((error) => error.includes('difficulty_level')));
  assert.ok(result.errors.some((error) => error.includes('source_type')));
});

test('normalize accepts legacy source aliases and defaults the status to pending', () => {
  const result = normalizeImportQuestion(
    { ...baseQuestion(), source_type: 'board', difficulty_level: 'Hard' },
    0,
    'teacher'
  );

  assert.equal(result.payload.source_type, 'board_exam');
  assert.equal(result.payload.difficulty_level, 'hard');
  assert.equal(result.payload.status, 'pending');
});

test('normalize keeps structured exam references and validates their ids and years', () => {
  const references = normalizeImportQuestion(
    {
      ...baseQuestion(),
      exam_references: [
        { source_kind: 'admission', institution_name: 'Dhaka University', year: 2023 },
        { source_kind: 'board', board: 'Rajshahi Board', year: 'circa' },
      ],
    },
    0
  );

  assert.deepEqual(references.errors, []);
  assert.deepEqual(references.payload.exam_references, [
    { source_kind: 'admission', institution_name: 'Dhaka University', year: '2023' },
    { source_kind: 'board', board: 'Rajshahi Board', year: 'circa' },
  ]);
  assert.ok(references.warnings.some((warning) => warning.includes('4-digit year')));

  const invalid = normalizeImportQuestion(
    {
      ...baseQuestion(),
      exam_references: [{ source_kind: 'board', institution_id: 'not-a-uuid' }],
    },
    0
  );

  assert.ok(invalid.errors.some((error) => error.includes('must be a UUID')));
});

test('normalize rejects a non-mcq type and a non-object question', () => {
  assert.ok(
    normalizeImportQuestion({ ...baseQuestion(), type: 'Comprehension' }, 0).errors.some((error) =>
      error.includes('only mcq')
    )
  );
  assert.ok(normalizeImportQuestion('nope', 0).errors.includes('Question must be an object.'));
});

test('normalizeImportQuestions rejects an empty or oversized batch', () => {
  assert.throws(() => normalizeImportQuestions([]), ImportValidationError);
  assert.throws(() => normalizeImportQuestions('nope'), ImportValidationError);
  assert.throws(
    () => normalizeImportQuestions(Array.from({ length: 501 }, () => baseQuestion())),
    ImportValidationError
  );
});

test('content hash is stable for reordered objects and changes with the answer key', () => {
  const reference = [{ source_kind: 'board', board: 'Dhaka Board', year: '2024' }];
  const first = withContentHashes(
    assignResolvedExamReferences([normalizeImportQuestion(baseQuestion(), 0)], [reference])
  )[0];
  const reordered = baseQuestion();
  reordered.exam_references = [
    { year: '2024', board: 'Dhaka Board', source_kind: 'board' } as never,
  ];
  const second = withContentHashes(
    assignResolvedExamReferences([normalizeImportQuestion(reordered, 0)], [reference])
  )[0];

  assert.ok(first.content_hash);
  assert.equal(first.content_hash, second.content_hash);

  const answerChanged = baseQuestion();
  answerChanged.options = answerChanged.options.map((option, index) => ({
    ...option,
    isCorrect: index === 0,
  }));
  const third = withContentHashes(
    assignResolvedExamReferences([normalizeImportQuestion(answerChanged, 0)], [reference])
  )[0];

  assert.notEqual(first.content_hash, third.content_hash);
});

test('invalid questions never receive a content hash', () => {
  const [item] = withContentHashes([
    normalizeImportQuestion({ ...baseQuestion(), subject_id: '' }, 0),
  ]);

  assert.equal(item.content_hash, undefined);
});

const hashedBatch = () =>
  withContentHashes(
    normalizeImportQuestions([baseQuestion(), baseQuestion()], 'admin')
  );

test('planImportBatch marks both copies duplicate when the subject already has the hash', () => {
  const items = hashedBatch();
  const hash = items[0].content_hash!;
  const existing = new Map([['sub_physics', new Map([[hash, 'existing-1']])]]);

  const plan = planImportBatch(items, existing);

  assert.deepEqual(
    plan.map((row) => row.action),
    ['duplicate', 'duplicate']
  );
  assert.equal(plan[0].existing_id, 'existing-1');
  assert.deepEqual(importPlanCounts(plan), { total: 2, insert: 0, duplicate: 2, invalid: 0 });
});

test('planImportBatch reports the second in-batch copy as a duplicate and keeps the first', () => {
  const plan = planImportBatch(hashedBatch());

  assert.deepEqual(
    plan.map((row) => row.action),
    ['insert', 'duplicate']
  );
  assert.ok(plan[1].errors[0].includes('question #1'));
});

test('planImportBatch marks invalid questions without touching the duplicate index', () => {
  const items = withContentHashes(
    normalizeImportQuestions([
      { ...baseQuestion(), subject_id: '' },
      baseQuestion(),
    ])
  );

  const plan = planImportBatch(items);

  assert.deepEqual(
    plan.map((row) => row.action),
    ['invalid', 'insert']
  );
});

const admissionQuestion = () => ({
  ...baseQuestion(),
  source_type: 'admission',
  exam_references: [
    {
      source_kind: 'admission',
      institution_name: 'University of Dhaka',
      unit_name: 'A',
    },
  ],
});

test('admission imports need a resolved institution and unit, other sources do not', () => {
  const [linked] = assignResolvedExamReferences(
    [normalizeImportQuestion(admissionQuestion(), 0)],
    [
      [
        {
          source_kind: 'admission',
          institution_id: '11111111-1111-4111-8111-111111111111',
          institution_name: 'University of Dhaka',
          unit_id: '22222222-2222-4222-8222-222222222222',
          unit_name: 'A Unit',
        },
      ],
    ]
  );
  assert.deepEqual(linked.errors, []);

  const [unlinked] = assignResolvedExamReferences(
    [normalizeImportQuestion(admissionQuestion(), 0)],
    [
      [
        {
          source_kind: 'admission',
          institution_id: '11111111-1111-4111-8111-111111111111',
          institution_name: 'University of Dhaka',
          unit_name: 'A',
        },
      ],
    ]
  );
  assert.ok(unlinked.errors.some((error) => error.includes('linked institution and admission unit')));

  const modelTest = normalizeImportQuestion(
    { ...baseQuestion(), source_type: 'model_test', exam_references: null },
    0
  );
  assert.deepEqual(modelTest.errors, []);
});

test('normalize records preparation placement without adding it to the question payload', () => {
  const hsc = normalizeImportQuestion(
    { ...baseQuestion(), preparation_category: 'hsc' },
    0
  );

  assert.equal(hsc.preparation_present, true);
  assert.equal(hsc.preparation_category, 'hsc');
  assert.equal('preparation_category' in hsc.payload, false);

  const both = normalizeImportQuestion(
    { ...baseQuestion(), preparation_category: 'hsc + admission' },
    0
  );
  assert.equal(both.preparation_category, 'both');

  const cleared = normalizeImportQuestion(
    { ...baseQuestion(), preparation_category: null },
    0
  );
  assert.equal(cleared.preparation_present, true);
  assert.equal(cleared.preparation_category, null);

  const absent = normalizeImportQuestion(baseQuestion(), 0);
  assert.equal(absent.preparation_present, false);
});

test('normalize rejects an unknown preparation category', () => {
  const result = normalizeImportQuestion(
    { ...baseQuestion(), preparation_category: 'varsity' },
    0
  );

  assert.ok(result.errors.some((error) => error.includes('preparation_category')));
});

/**
 * The guards are behaviour the suite cannot observe without a live project, so
 * they are asserted against the route table exactly as other route specs do.
 */
test('importer routes require authentication, an author role, and questions.manage', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'features', 'content', 'content.routes.ts'),
    'utf8'
  );

  assert.match(source, /router\.use\(requireAuth\)/);

  for (const path of ['/questions/import', '/questions/import-history']) {
    const line = source
      .split('\n')
      .find((candidate) => candidate.includes(`'${path}'`));

    assert.ok(line, `${path} must be registered`);
    assert.ok(line!.includes("rbacGuard(['admin', 'editor', 'teacher'])"), `${path} role guard`);
    assert.ok(line!.includes('requirePermission(PERMISSIONS.QUESTIONS_MANAGE)'), `${path} permission`);
    assert.equal(line!.includes("'student'"), false, `${path} must never allow students`);
  }
});

test('the importer controller takes the author identity from the verified token', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'features', 'content', 'content.controller.ts'),
    'utf8'
  );

  assert.ok(source.includes('userId: req.user.id'));
  assert.equal(source.includes('req.body.user_id'), false);
  assert.equal(source.includes('SERVICE_ROLE'), false);
});
