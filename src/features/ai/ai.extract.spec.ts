import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
  question_number: '1',
  body: { text_bn: 'প্রশ্ন', text_en: 'Question' },
  options: [option('ক', true), option('খ'), option('গ'), option('ঘ')],
  explanation: { bn: 'ব্যাখ্যা', en: 'Explanation' },
  difficulty_level: 'medium',
  source_type: 'board_exam',
  exam_references: [{ source_kind: 'board', board: 'Dhaka Board', year: '2024' }],
  tags: ['algebra'],
  source_metadata: { institution: 'Dhaka Board', exam_name: 'HSC', year: '2024' },
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
  });

  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.images[0].data, IMAGE.data);
  assert.equal(parsed.images[0].mime_type, 'image/jpeg');
  assert.equal(parsed.sourceHint.institution, 'Dhaka Board');
  assert.equal(parsed.sourceHint.year, '2024');
});

test('parseExtractionRequest accepts exactly one image and rejects anything else', () => {
  assert.throws(() => parseExtractionRequest({ images: [] }), /Exactly one/);
  assert.throws(() => parseExtractionRequest({}), /Exactly one/);
  assert.throws(
    () => parseExtractionRequest({ images: [IMAGE, { ...IMAGE, image_id: 'img_2' }] }),
    /Only one question-paper image/
  );

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
});

// --- model output sanitising ----------------------------------------------

test('sanitizeModelOutput keeps a printed answer key and structured fields', () => {
  const result = sanitizeModelOutput({ questions: [question()] }, 1);

  assert.equal(result.questions.length, 1);
  assert.equal(result.rejected.length, 0);

  const extracted = result.questions[0];
  assert.equal(extracted.type, 'mcq');
  assert.equal(extracted.question_number, '1');
  assert.equal(extracted.confidence, 'high');
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
  assert.equal(extracted.confidence, 'low');
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
  assert.equal(extracted.confidence, 'low');
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
        question({ question_number: '1', body: { text_bn: '', text_en: 'missing bangla' } }),
        question({ question_number: '2', options: [option('only one')] }),
        question({ question_number: '3' }),
      ],
    },
    1
  );

  assert.equal(result.questions.length, 1);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0].reason, /Bengali text/);
  assert.match(result.rejected[1].reason, /2-6 options/);
  // Rejections are reported, never silently omitted.
  assert.ok(result.warnings.some((warning) => warning.includes('manual re-check')));
});

test('sanitizeModelOutput keeps the printed question number and original order', () => {
  const result = sanitizeModelOutput(
    {
      questions: [
        question({ question_number: '12' }),
        question({ question_number: '13' }),
        question({ question_number: '14' }),
      ],
    },
    1
  );

  assert.deepEqual(
    result.questions.map((entry) => entry.question_number),
    ['12', '13', '14']
  );
});

test('sanitizeModelOutput flags a missing number and derives low confidence', () => {
  const result = sanitizeModelOutput(
    { questions: [question({ question_number: undefined })] },
    1
  );

  const extracted = result.questions[0];
  assert.equal(extracted.question_number, '');
  assert.ok(extracted.uncertain_ocr_flags.includes('question_number_missing'));
  assert.equal(extracted.confidence, 'low');
});

test('sanitizeModelOutput warns about duplicate question numbers', () => {
  const result = sanitizeModelOutput(
    {
      questions: [question({ question_number: '5' }), question({ question_number: '5' })],
    },
    1
  );

  assert.equal(result.questions.length, 2);
  assert.ok(result.warnings.some((warning) => warning.includes('Question number 5 appears')));
  assert.ok(
    result.questions.every((entry) =>
      entry.uncertain_ocr_flags.includes('duplicate_question_number: 5')
    )
  );
  assert.ok(result.questions.every((entry) => entry.confidence === 'low'));
});

test('sanitizeModelOutput reports out-of-order numbering but keeps the order', () => {
  const result = sanitizeModelOutput(
    {
      questions: [question({ question_number: '8' }), question({ question_number: '2' })],
    },
    1
  );

  assert.deepEqual(
    result.questions.map((entry) => entry.question_number),
    ['8', '2']
  );
  assert.ok(result.warnings.some((warning) => warning.includes('numerical order')));
});

test('sanitizeModelOutput flags an unexpected option count and missing source metadata', () => {
  const result = sanitizeModelOutput(
    {
      questions: [
        question({
          options: [option('ক', true), option('খ'), option('গ')],
          exam_references: [],
          source_metadata: undefined,
        }),
      ],
    },
    1
  );

  const extracted = result.questions[0];
  assert.ok(extracted.uncertain_ocr_flags.includes('option_count_unexpected: 3'));
  assert.ok(extracted.uncertain_ocr_flags.includes('source_metadata_not_detected'));
  assert.equal(extracted.source_metadata, undefined);
});

test('sanitizeModelOutput covers Bangla, English, bilingual, math and diagram pages', () => {
  const result = sanitizeModelOutput(
    {
      batch_source_info: { institution: 'Dhaka Board', exam_name: 'HSC', year: '2024' },
      questions: [
        question({
          question_number: '1',
          body: { text_bn: 'বাংলা প্রশ্ন', text_en: '' },
        }),
        question({
          question_number: '2',
          body: { text_bn: 'ইংরেজি প্রশ্নের অনুবাদ', text_en: 'English question' },
        }),
        question({
          question_number: '3',
          body: { text_bn: 'বilingual প্রশ্ন', text_en: 'Bilingual question' },
          answer_source: 'marked',
          options: [option('$\\sqrt{2}$', true), option('$\\pi$'), option('$e$'), option('$1$')],
        }),
        question({
          question_number: '4',
          body: { text_bn: 'চিত্র ২ অনুযায়ী বল নির্ণয় করো।', text_en: 'Find the force from figure 2.' },
          uncertain_ocr_flags: ['diagram_required: figure 2'],
        }),
        question({
          question_number: '5',
          answer_source: 'none',
          answer_evidence: '',
          options: [option('ক'), option('খ'), option('গ'), option('ঘ')],
        }),
      ],
    },
    1
  );

  assert.equal(result.questions.length, 5);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.questions[0].confidence, 'low');
  assert.equal(result.questions[1].confidence, 'high');
  assert.equal(result.questions[2].options[0].text_bn, '$\\sqrt{2}$');
  assert.equal(result.questions[3].uncertain_ocr_flags[0], 'diagram_required: figure 2');
  assert.equal(result.questions[4].requires_manual_answer_verification, true);
  assert.equal(result.questions[4].confidence, 'low');
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
          source_metadata: undefined,
          exam_references: [{ source_kind: 'madrasa', board: 'Dhaka Board' }],
          tags: ['physics', 'physics', ''],
        }),
      ],
    },
    1
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

test('buildImageResults reports the question count for the single image', () => {
  const questions = sanitizeModelOutput(
    {
      questions: [
        question({ question_number: '1', source_image_index: 0 }),
        question({ question_number: '2', source_image_index: 0 }),
      ],
    },
    1
  ).questions;

  const results = buildImageResults([{ ...IMAGE, image_id: 'a' }], questions);

  assert.deepEqual(
    results.map((entry) => [entry.image_id, entry.status, entry.question_count]),
    [['a', 'extracted', 2]]
  );
});

test('buildImageResults marks a page with no readable questions as empty', () => {
  const results = buildImageResults([{ ...IMAGE, image_id: 'a' }], []);

  assert.equal(results[0].status, 'empty');
  assert.equal(results[0].question_count, 0);
});
