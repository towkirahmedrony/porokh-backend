import {
  IMPORT_DIFFICULTY_LEVELS,
  IMPORT_REFERENCE_KINDS,
  IMPORT_SOURCE_TYPES,
  MAX_IMPORT_BATCH_SIZE,
} from './question.import';

/**
 * Plain-text -> question JSON for the AI Question Importer.
 *
 * An AI (or a person) writes simple `KEY: value` blocks separated by `---`;
 * this module builds the canonical bilingual question objects. Everything the
 * model used to repeat per question (ids, isCorrect, null image urls, the
 * shared exam reference) is produced here, so it cannot be mistyped.
 *
 * The output deliberately has no subject_id / chapter_id / topic_id: the
 * importer adds them from its dropdowns, then the normal `/questions/import`
 * validation (dry run, duplicates, reference resolution) still runs on it.
 *
 * Pure and database-free, like `question.import`.
 */

export const MAX_PARSE_TEXT_LENGTH = 90_000;

export class TextParseValidationError extends Error {
  status = 400;
  errorCode = 'VALIDATION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'TextParseValidationError';
  }
}

export interface ParsedOption {
  id: number;
  text_bn: string;
  text_en: string;
  image_url: null;
  isCorrect: boolean;
}

export interface ParsedQuestion {
  type: 'mcq';
  body: { text_bn: string; text_en: string; image_url: null };
  options: ParsedOption[];
  explanation?: { bn: string; en: string };
  difficulty_level: string;
  source_type: string;
  tags: string[];
  exam_references: Array<Record<string, string>>;
}

export interface ParseIssue {
  /** 1-based question number; 0 means a header (@ line) problem. */
  question: number;
  /** Line in the pasted text where the question block starts. */
  line: number;
  messages: string[];
}

export interface TextParseResult {
  questions: ParsedQuestion[];
  errors: ParseIssue[];
  warnings: ParseIssue[];
  counts: { total: number; valid: number; invalid: number };
}

type Bag = Record<string, string | undefined>;

interface RawLine {
  no: number;
  text: string;
}

interface RawBlock {
  lines: RawLine[];
}

/** Batch defaults, written as `@key: value` and in effect for every later question. */
const BATCH_KEYS = new Set([
  'source',
  'kind',
  'institution',
  'exam',
  'unit',
  'year',
  'difficulty',
  'tags',
]);

const QUESTION_KEYS = new Set([
  'q',
  'q_bn',
  'q_en',
  'ans',
  'exp',
  'exp_bn',
  'exp_en',
  'diff',
  'src',
  'inst',
  'exam',
  'unit',
  'year',
  'tags',
]);

const OPTION_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
const OPTION_KEY = /^([a-f])(?:_(bn|en))?$/;
const FIELD_LINE = /^\s*(@?)([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/;

const ANSWER_MAP: Record<string, number> = {
  a: 1,
  b: 2,
  c: 3,
  d: 4,
  e: 5,
  f: 6,
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  'ক': 1,
  'খ': 2,
  'গ': 3,
  'ঘ': 4,
  'ঙ': 5,
  'চ': 6,
};

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

const toEnglishDigits = (value: string): string =>
  value.replace(/[০-৯]/g, (digit) => String(BN_DIGITS.indexOf(digit)));

const SOURCE_REFERENCE_KINDS: Record<string, string> = {
  admission: 'admission',
  board_exam: 'board',
  college_test: 'college',
  school_exam: 'school',
  university_exam: 'university',
  textbook: 'book',
  guidebook: 'book',
};

const pick = (...values: Array<string | undefined>): string | undefined =>
  values.find((value) => value !== undefined && value !== '');

const normalizeTag = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/^_+|_+$/g, '');

const parseTags = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(/[,;\n]/)
    .map(normalizeTag)
    .filter(Boolean);

const splitBlocks = (text: string): RawBlock[] => {
  const blocks: RawBlock[] = [];
  let current: RawBlock = { lines: [] };

  text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const no = index + 1;

      // AI chat tools often wrap the answer in a code fence; drop the fence lines.
      if (/^\s*`{3}/.test(raw)) return;

      if (/^\s*-{3,}\s*$/.test(raw)) {
        blocks.push(current);
        current = { lines: [] };
        return;
      }

      current.lines.push({ no, text: raw });
    });

  blocks.push(current);

  return blocks.filter((block) => block.lines.some((line) => line.text.trim() !== ''));
};

const parseBlock = (
  block: RawBlock
): { headers: Bag; fields: Bag; problems: string[] } => {
  const headers: Bag = {};
  const fields: Bag = {};
  const problems: string[] = [];
  let target: { bag: Bag; key: string } | null = null;

  for (const { no, text } of block.lines) {
    const match = FIELD_LINE.exec(text);

    if (match) {
      const isHeader = match[1] === '@';
      const rawKey = match[2].toLowerCase();
      // @session is the preferred admission label; keep storing it in the
      // existing `year` metadata field for backward compatibility.
      const key = rawKey === 'session' ? 'year' : rawKey;
      const value = match[3].trim();

      if (isHeader) {
        if (!BATCH_KEYS.has(key)) {
          problems.push(`Line ${no}: unknown header "@${match[2]}".`);
          target = null;
        } else {
          headers[key] = value;
          target = { bag: headers, key };
        }
        continue;
      }

      if (QUESTION_KEYS.has(key) || OPTION_KEY.test(key)) {
        if (fields[key] !== undefined) {
          problems.push(`Line ${no}: "${match[2]}" appears twice in one question.`);
        }
        fields[key] = value;
        target = { bag: fields, key };
        continue;
      }
    }

    // Anything else continues the previous field (multi-line statements, i./ii./iii.).
    const trimmed = text.trim();
    if (target && trimmed !== '') {
      const existing = target.bag[target.key] ?? '';
      target.bag[target.key] = existing ? `${existing}\n${trimmed}` : trimmed;
    }
  }

  return { headers, fields, problems };
};

const parseAnswer = (raw: string): number | null => {
  const cleaned = toEnglishDigits(raw)
    .trim()
    .replace(/^[([]+|[.)\]]+$/g, '')
    .toLowerCase();

  return ANSWER_MAP[cleaned] ?? null;
};

const buildQuestion = (
  fields: Bag,
  defaults: Bag
): { question: ParsedQuestion | null; errors: string[]; warnings: string[] } => {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Question text: Q_BN / Q_EN, or a single Q used for both languages.
  const qBn = pick(fields.q_bn, fields.q);
  const qEn = pick(fields.q_en, fields.q);
  let text_bn = qBn ?? '';
  const text_en = qEn ?? '';

  if (!text_bn && text_en) {
    text_bn = text_en;
    warnings.push('Q_BN is missing; the English text was used for the Bengali field.');
  }
  if (!text_bn) errors.push('Question text is missing (use Q_BN and Q_EN, or Q).');

  // Options: A..F, contiguous from A.
  const present = OPTION_LETTERS.map((letter) =>
    [fields[letter], fields[`${letter}_bn`], fields[`${letter}_en`]].some(
      (value) => value !== undefined
    )
  );
  const lastPresent = present.lastIndexOf(true);
  const options: ParsedOption[] = [];

  if (lastPresent < 1) {
    errors.push('At least 2 options (A and B) are required.');
  } else {
    for (let index = 0; index <= lastPresent; index += 1) {
      const letter = OPTION_LETTERS[index];
      const label = letter.toUpperCase();

      if (!present[index]) {
        errors.push(`Option ${label} is missing (options must run A, B, C... without gaps).`);
        continue;
      }

      const both = fields[letter];
      const bn = pick(fields[`${letter}_bn`], both, fields[`${letter}_en`]) ?? '';
      const en = pick(fields[`${letter}_en`], both) ?? '';

      if (!bn) {
        errors.push(`Option ${label} has no text.`);
        continue;
      }

      options.push({
        id: index + 1,
        text_bn: bn,
        text_en: en,
        image_url: null,
        isCorrect: false,
      });
    }
  }

  // Correct answer: exactly one, and it must be one of the options.
  const rawAnswer = pick(fields.ans);
  if (!rawAnswer) {
    errors.push('ANS is missing (e.g. ANS: B).');
  } else {
    const answerId = parseAnswer(rawAnswer);
    if (answerId === null) {
      errors.push(`ANS "${rawAnswer}" is not understood; give exactly one letter from A to F.`);
    } else {
      const chosen = options.find((option) => option.id === answerId);
      if (!chosen) {
        errors.push(`ANS "${rawAnswer}" does not match any option.`);
      } else {
        chosen.isCorrect = true;
      }
    }
  }

  const difficulty = (pick(fields.diff, defaults.difficulty) ?? 'medium').toLowerCase();
  if (!(IMPORT_DIFFICULTY_LEVELS as readonly string[]).includes(difficulty)) {
    errors.push(
      `DIFF "${difficulty}" must be one of ${IMPORT_DIFFICULTY_LEVELS.join(', ')}.`
    );
  }

  const sourceType = (pick(fields.src, defaults.source) ?? 'unknown')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!(IMPORT_SOURCE_TYPES as readonly string[]).includes(sourceType)) {
    errors.push(`Source type "${sourceType}" is not supported.`);
  }

  // Exam reference: only built when an institution is given. The reference
  // kind follows the source type unless @kind overrides it.
  const institution = pick(fields.inst, defaults.institution);
  const exam = pick(fields.exam, defaults.exam);
  const unit = pick(fields.unit, defaults.unit);
  const yearRaw = pick(fields.year, defaults.year);
  const year = yearRaw ? toEnglishDigits(yearRaw).replace(/\s+/g, '') : undefined;
  const kind = (pick(defaults.kind) ?? SOURCE_REFERENCE_KINDS[sourceType] ?? 'unknown').toLowerCase();
  const exam_references: Array<Record<string, string>> = [];

  if (sourceType === 'admission') {
    if (!institution) {
      errors.push('Admission questions need an institution (use @institution).');
    }
    if (!unit) {
      errors.push('Admission questions need an admission unit (use @unit, e.g. @unit: A).');
    }
  }

  if (institution) {
    if (!(IMPORT_REFERENCE_KINDS as readonly string[]).includes(kind)) {
      errors.push(`@kind "${kind}" is not a supported reference kind.`);
    }
    exam_references.push({
      source_kind: kind,
      institution_name: institution,
      ...(exam ? { exam_name: exam } : {}),
      ...(unit ? { unit_name: unit } : {}),
      ...(year ? { year } : {}),
    });
  } else if (exam || unit || year) {
    warnings.push('Exam/unit/year were ignored because no institution is set.');
  }

  const explanationBn = pick(fields.exp_bn, fields.exp) ?? '';
  const explanationEn = pick(fields.exp_en, fields.exp) ?? '';

  const tags = Array.from(new Set([...parseTags(defaults.tags), ...parseTags(fields.tags)]));

  if (errors.length > 0) return { question: null, errors, warnings };

  return {
    question: {
      type: 'mcq',
      body: { text_bn, text_en, image_url: null },
      options,
      ...(explanationBn || explanationEn
        ? { explanation: { bn: explanationBn, en: explanationEn } }
        : {}),
      difficulty_level: difficulty,
      source_type: sourceType,
      tags,
      exam_references,
    },
    errors,
    warnings,
  };
};

/**
 * Parses pasted question text.
 *
 * Valid questions come back in `questions`; each invalid one is listed in
 * `errors` with its question number and start line so only that block needs
 * fixing. `@key: value` lines set defaults for every later question.
 */
export const parseQuestionText = (input: unknown): TextParseResult => {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new TextParseValidationError('text is required.');
  }

  if (input.length > MAX_PARSE_TEXT_LENGTH) {
    throw new TextParseValidationError(
      `text is too long; paste at most ${MAX_PARSE_TEXT_LENGTH} characters at a time.`
    );
  }

  const defaults: Bag = {};
  const questions: ParsedQuestion[] = [];
  const errors: ParseIssue[] = [];
  const warnings: ParseIssue[] = [];
  let number = 0;

  for (const block of splitBlocks(input)) {
    const line = block.lines.find((entry) => entry.text.trim() !== '')?.no ?? 1;
    const { headers, fields, problems } = parseBlock(block);

    // A new institution starts a new section: the unit and exam of the previous
    // one must not carry over unless this block sets them again.
    if (
      headers.institution !== undefined &&
      headers.institution.trim().toLowerCase() !== (defaults.institution ?? '').trim().toLowerCase()
    ) {
      for (const key of ['unit', 'exam']) {
        if (headers[key] === undefined) delete defaults[key];
      }
    }

    // An empty header value clears that default.
    Object.assign(defaults, headers);

    if (Object.keys(fields).length === 0) {
      if (problems.length > 0) errors.push({ question: 0, line, messages: problems });
      continue;
    }

    number += 1;

    if (number > MAX_IMPORT_BATCH_SIZE) {
      throw new TextParseValidationError(
        `A single import batch may contain at most ${MAX_IMPORT_BATCH_SIZE} questions.`
      );
    }

    const built = buildQuestion(fields, defaults);
    const messages = [...problems, ...built.errors];

    if (messages.length > 0 || !built.question) {
      errors.push({ question: number, line, messages });
    } else {
      questions.push(built.question);
    }

    if (built.warnings.length > 0) {
      warnings.push({ question: number, line, messages: built.warnings });
    }
  }

  if (number === 0) {
    throw new TextParseValidationError(
      'No questions found. Separate questions with --- and start each with Q_BN: (or Q:).'
    );
  }

  return {
    questions,
    errors,
    warnings,
    counts: { total: number, valid: questions.length, invalid: number - questions.length },
  };
};
