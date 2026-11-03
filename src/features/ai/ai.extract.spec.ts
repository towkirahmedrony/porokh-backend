import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SOURCES,
  MAX_TEXT_SOURCE_CHARS,
  buildSourceResults,
  parseExtractionRequest,
  sanitizePlainText,
} from './ai.extract';

/**
 * Pure extraction-contract checks: request limits for mixed text/image sources
 * and normalisation of the model's Structured Plain Text answer.
 */

const IMAGE = {
  source_id: 'img_1',
  file_name: 'page-1.jpg',
  kind: 'image',
  mime_type: 'image/jpeg',
  data: Buffer.from('fake-jpeg-bytes').toString('base64'),
};

const TEXT = {
  source_id: 'txt_1',
  file_name: 'questions.txt',
  kind: 'text',
  text: 'Q_EN: What is the capital of Bangladesh?\nANS: A',
};

test('parseExtractionRequest accepts text and image sources and strips the data URL prefix', () => {
  const parsed = parseExtractionRequest({
    sources: [
      { ...TEXT, file_name: '  paper.txt  ' },
      { ...IMAGE, data: `data:image/jpeg;base64,${IMAGE.data}` },
    ],
    source_hint: { institution: ' Dhaka Board ', year: 2024, ignored: 'x' },
  });

  assert.equal(parsed.sources.length, 2);
  assert.equal(parsed.sources[0].kind, 'text');
  assert.equal(parsed.sources[0].file_name, 'paper.txt');
  assert.equal(parsed.sources[1].kind, 'image');

  if (parsed.sources[1].kind === 'image') {
    assert.equal(parsed.sources[1].data, IMAGE.data);
  }

  assert.deepEqual(parsed.sourceHint, { institution: 'Dhaka Board', year: '2024' });
});

test('parseExtractionRequest rejects an empty source list or an unknown kind', () => {
  assert.throws(() => parseExtractionRequest({ sources: [] }), /At least one/);
  assert.throws(() => parseExtractionRequest({}), /At least one/);
  assert.throws(
    () => parseExtractionRequest({ sources: [{ kind: 'pdf', text: 'x' }] }),
    /must be either "text" or "image"/
  );
});

test('parseExtractionRequest rejects empty text, duplicate ids, and too many sources', () => {
  assert.throws(
    () => parseExtractionRequest({ sources: [{ ...TEXT, text: '   ' }] }),
    /text is empty/
  );

  assert.throws(
    () => parseExtractionRequest({ sources: [TEXT, { ...TEXT }] }),
    /Duplicate source_id/
  );

  const tooMany = Array.from({ length: MAX_SOURCES + 1 }, (_, index) => ({
    ...TEXT,
    source_id: `src_${index}`,
  }));
  assert.throws(() => parseExtractionRequest({ sources: tooMany }), /At most 8 sources/);
});

test('parseExtractionRequest enforces image type/size and the text budget', () => {
  assert.throws(
    () => parseExtractionRequest({ sources: [{ ...IMAGE, mime_type: 'application/pdf' }] }),
    /mime_type must be one of/
  );

  assert.throws(
    () => parseExtractionRequest({ sources: [{ ...IMAGE, data: 'not-valid-base64***' }] }),
    /missing base64|not valid base64/
  );

  assert.throws(
    () =>
      parseExtractionRequest({
        sources: [{ ...TEXT, text: 'x'.repeat(MAX_TEXT_SOURCE_CHARS + 1) }],
      }),
    /exceeds 120000 characters/
  );
});

test('sanitizePlainText keeps well-formed blocks and joins them with a separator', () => {
  const result = sanitizePlainText(
    '@institution: University of Dhaka\n\nQ_BN: প্রশ্ন?\nQ_EN: Question?\nA_BN: ক\nA_EN: A\nANS: A\n\n---\n\nQ_EN: Second?\nANS: B\n'
  );

  assert.equal(result.question_count, 2);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.plain_text.includes('---\n'));
  assert.ok(result.plain_text.startsWith('@institution: University of Dhaka'));
  assert.ok(result.plain_text.endsWith('\n'));
});

test('sanitizePlainText removes code fences and leading commentary', () => {
  const result = sanitizePlainText(
    'Here are the questions:\n```text\nQ_EN: What is it?\nANS: A\n```\n'
  );

  assert.equal(result.plain_text, 'Q_EN: What is it?\nANS: A\n');
  assert.equal(result.question_count, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('before the first question')));
});

test('sanitizePlainText drops exact duplicate blocks and reports them', () => {
  const block = 'Q_EN: Duplicate question?\nANS: A';
  const result = sanitizePlainText(`${block}\n---\n${block}\n---\nQ_EN: Unique?\nANS: B`);

  assert.equal(result.question_count, 2);
  assert.ok(result.warnings.some((warning) => warning.includes('duplicated question block')));
  assert.equal(result.plain_text.match(/Duplicate question/g)?.length, 1);
});

test('sanitizePlainText maps NONE to an empty document', () => {
  assert.deepEqual(sanitizePlainText(' NONE \n'), {
    plain_text: '',
    question_count: 0,
    warnings: [],
  });
});

test('sanitizePlainText warns when no question block is present', () => {
  const result = sanitizePlainText('@institution: University of Dhaka\nNo questions here.');

  assert.equal(result.plain_text, '');
  assert.equal(result.question_count, 0);
  assert.ok(result.warnings.some((warning) => warning.includes('did not contain any question')));
});

test('sanitizePlainText preserves LaTeX and continuation lines verbatim', () => {
  const math = 'Q_EN: Evaluate $\\int_0^1 x^2\\,dx$.\ni. Use the power rule.\nANS: A';
  const result = sanitizePlainText(math);

  assert.equal(result.plain_text, `${math}\n`);
});

test('sanitizePlainText rejects a non-string provider answer', () => {
  assert.throws(() => sanitizePlainText({ questions: [] }), /was not plain text/);
});

test('buildSourceResults credits every source when questions were found', () => {
  const sources = [
    { ...TEXT, kind: 'text' as const },
    { ...IMAGE, kind: 'image' as const },
  ];

  assert.deepEqual(buildSourceResults(sources, 2), [
    { source_id: 'txt_1', file_name: 'questions.txt', status: 'extracted' },
    { source_id: 'img_1', file_name: 'page-1.jpg', status: 'extracted' },
  ]);

  assert.equal(buildSourceResults(sources, 0)[0].status, 'empty');
});
