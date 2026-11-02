import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EXTRACT_IMAGES,
  MAX_IMAGE_BYTES,
  buildImageResults,
  parseExtractionRequest,
  sanitizeModelOutput,
} from './ai.extract';

const IMAGE = {
  image_id: 'img_1',
  file_name: 'page-1.jpg',
  mime_type: 'image/jpeg',
  data: Buffer.from('fake-jpeg-bytes').toString('base64'),
};

const option = (text: string, isCorrect = false) => ({
  text_bn: text,
  text_en: text,
  isCorrect,
});

const question = (overrides: Record<string, unknown> = {}) => ({
  body: { text_bn: 'প্রশ্ন', text_en: 'Question' },
  options: [option('ক', true), option('খ'), option('গ'), option('ঘ')],
  explanation: { bn: 'ব্যাখ্যা', en: 'Explanation' },
  difficulty_level: 'medium',
  source_type: 'board_exam',
  exam_references: [{ source_kind: 'board', board: 'Dhaka Board', year: '2024' }],
  tags: ['algebra'],
  answer_source: 'printed',
  answer_evidence: 'Answer: (ক)',
  requires_manual_answer_verification: false,
  uncertain_ocr_flags: [],
  source_image_index: 0,
  ...overrides,
});

// --- request parsing -------------------------------------------------------

test('parseExtractionRequest accepts a valid image and strips the data URL prefix', () => {
  const parsed = parseExtractionRequest({
    images: [{ ...IMAGE, data: `data:image/jpeg;base64,${IMAGE.data}` }],
    source_hint: { institution: 'Dhaka Board', year: 2024 },
    generate_missing_explanations: false,
  });

  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.images[0].data, IMAGE.data);
  assert.equal(parsed.images[0].mime_type, 'image/jpeg');
  assert.equal(parsed.sourceHint.institution, 'Dhaka Board');
  assert.equal(parsed.sourceHint.year, '2024');
  assert.equal(parsed.generateMissingExplanations, false);
});

test('parseExtractionRequest rejects an empty, oversized or excessive request', () => {
  assert.throws(() => parseExtractionRequest({ images: [] }), /At least one/);
  assert.throws(() => parseExtractionRequest({}), /At least one/);

  const tooMany = Array.from({ length: MAX_EXTRACT_IMAGES + 1 }, (_, index) => ({
    ...IMAGE,
    image_id: `img_${index}`,
    data: Buffer.from('x').toString('base64'),
  }));
  assert.throws(() => parseExtractionRequest({ images: tooMany }), /at most/);

  const oversized = {
    ...IMAGE,
    data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64'),
  };
  assert.throws(() => parseExtractionRequest({ images: [oversized] }), /per-image limit/);
});

test('parseExtractionRequest rejects bad mime types, empty data and duplicate ids', () => {
  assert.throws(
    () => parseExtractionRequest({ images: [{ ...IMAGE, mime_type: 'image/gif' }] }),
    /mime_type/
  );
  assert.throws(
    () => parseExtractionRequest({ images: [{ ...IMAGE, data: '' }] }),
    /base64 data/
  );
  assert.throws(
    () => parseExtractionRequest({ images: [{ ...IMAGE, data: '!!!' }] }),
    /base64 data/
  );
  assert.throws(
    () => parseExtractionRequest({ images: [IMAGE, { ...IMAGE }] }),
    /Duplicate image_id/
  );
});

// --- model output sanitising ----------------------------------------------

test('sanitizeModelOutput keeps a printed answer key and structured fields', () => {
  const result = sanitizeModelOutput({ questions: [question()] }, 1);

  assert.equal(result.questions.length, 1);
  assert.equal(result.rejected.length, 0);

  const extracted = result.questions[0];
  assert.equal(extracted.type, 'mcq');
  assert.equal(extracted.options.filter((entry) => entry.isCorrect).length, 1);
  assert.equal(extracted.options[0].id, 1);
  assert.equal(extracted.requires_manual_answer_verification, false);
  assert.equal(extracted.source_type, 'board_exam');
  assert.equal(extracted.exam_references[0].board, 'Dhaka Board');
});

test('sanitizeModelOutput never invents an answer when none is printed', () => {
  const result = sanitizeModelOutput(
    {
      questions: [
        question({
          answer_source: 'none',
          answer_evidence: '',
          // A model could still mark an option; that must be discarded.
          options: [option('ক', true), option('খ'), option('গ'), option('ঘ')],
        }),
      ],
    },
    1
  );

  const extracted = result.questions[0];
  assert.equal(extracted.options.some((entry) => entry.isCorrect), false);
  assert.equal(extracted.requires_manual_answer_verification, true);
  assert.ok(extracted.uncertain_ocr_flags.includes('answer_not_printed'));
});

test('sanitizeModelOutput keeps a printed answer without evidence but requires review', () => {
  const result = sanitizeModelOutput(
    { questions: [question({ answer_source: 'printed', answer_evidence: '' })] },
    1
  );

  const extracted = result.questions[0];
  assert.equal(extracted.options.filter((entry) => entry.isCorrect).length, 1);
  assert.equal(extracted.requires_manual_answer_verification, true);
  assert.ok(extracted.uncertain_ocr_flags.includes('answer_evidence_missing'));
});

test('sanitizeModelOutput clears contradictory or ambiguous answers', () => {
  const result = sanitizeModelOutput(
    {
      questions: [
        question({
          answer_source: 'marked',
          options: [option('ক', true), option('খ', true), option('গ'), option('ঘ')],
        }),
      ],
    },
    1
  );

  const extracted = result.questions[0];
  assert.equal(extracted.options.some((entry) => entry.isCorrect), false);
  assert.equal(extracted.requires_manual_answer_verification, true);
  assert.ok(extracted.uncertain_ocr_flags.includes('answer_ambiguous'));
});

test('sanitizeModelOutput preserves LaTeX and scientific notation verbatim', () => {
  const latex = 'যদি $x^2 + y^2 = r^2$ হয়, তবে $\\frac{dy}{dx}$ এর মান কত? Unit: m/s²';
  const result = sanitizeModelOutput(
    {
      questions: [
        question({
          body: { text_bn: latex, text_en: '$x^2 + y^2 = r^2$' },
          options: [
            { text_bn: '$\\sqrt{2}$', text_en: '$\\sqrt{2}$', isCorrect: true },
            { text_bn: '$\\pm 1$', text_en: '$\\pm 1$', isCorrect: false },
          ],
        }),
      ],
    },
    1
  );

  assert.equal(result.questions[0].body.text_bn, latex);
  assert.equal(result.questions[0].options[0].text_bn, '$\\sqrt{2}$');
});

test('sanitizeModelOutput rejects unreadable questions without dropping the batch', () => {
  const result = sanitizeModelOutput(
    {
      questions: [
        question({ body: { text_bn: '', text_en: 'missing bangla' } }),
        question({ options: [option('only one')] }),
        question(),
      ],
    },
    1
  );

  assert.equal(result.questions.length, 1);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0].reason, /Bengali text/);
  assert.match(result.rejected[1].reason, /2-6 options/);
});

test('sanitizeModelOutput normalises metadata and clamps the image index', () => {
  const result = sanitizeModelOutput(
    {
      batch_source_info: { institution: 'BUET', exam_name: 'Admission', year: '2023' },
      questions: [
        question({
          difficulty_level: 'impossible',
          source_type: 'Board Exam',
          source_image_index: 7,
          exam_references: [{ source_kind: 'madrasa', board: 'Dhaka Board' }],
          tags: ['physics', 'physics', ''],
        }),
      ],
    },
    2
  );

  const extracted = result.questions[0];
  assert.equal(extracted.difficulty_level, 'medium');
  assert.equal(extracted.source_type, 'board_exam');
  assert.equal(extracted.source_image_index, 0);
  assert.ok(extracted.uncertain_ocr_flags.includes('source_image_index_out_of_range'));
  assert.equal(extracted.exam_references[0].source_kind, 'unknown');
  assert.deepEqual(extracted.tags, ['physics']);
  assert.equal(extracted.source_metadata?.institution, 'BUET');
});

test('sanitizeModelOutput drops references without a traceable name', () => {
  const result = sanitizeModelOutput(
    {
      questions: [
        question({
          exam_references: [{ source_kind: 'board', year: '2022' }],
        }),
      ],
    },
    1
  );

  assert.deepEqual(result.questions[0].exam_references, []);
});

test('sanitizeModelOutput rejects a response without a questions array', () => {
  assert.throws(() => sanitizeModelOutput({}, 1), /questions array/);
  assert.throws(() => sanitizeModelOutput(null, 1), /questions array/);
});

// --- per-image status ------------------------------------------------------

test('buildImageResults reports question counts per image and marks empty pages', () => {
  const questions = sanitizeModelOutput(
    {
      questions: [question({ source_image_index: 0 }), question({ source_image_index: 0 })],
    },
    2
  ).questions;

  const images = [
    { ...IMAGE, image_id: 'a' },
    { ...IMAGE, image_id: 'b' },
  ];

  const results = buildImageResults(images, questions);

  assert.deepEqual(
    results.map((entry) => [entry.image_id, entry.status, entry.question_count]),
    [
      ['a', 'extracted', 2],
      ['b', 'empty', 0],
    ]
  );
});
